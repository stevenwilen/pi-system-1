// Finance lane, step 1. Real rows, real endpoints, no model call anywhere.
const H = require('./harness');
const U = H.TEST_USER_ID;
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
const PORT = 3982;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

async function call(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const server = H.spawnServer(PORT);

const made = [];

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const supabase = H.db;

  console.log('empty to begin with');
  const start = await call('/finance-intent');
  check('answers', start.status === 200);
  check('offers the five kinds', start.data.kinds.join(',') === 'situation,reserve,target,declared,slip', start.data.kinds.join(','));
  check('offers both reserve modes', start.data.modes.join(',') === 'wall,floor');
  const baseline = start.data.items.length;

  console.log('\nvalidation');
  check('rejects an unknown kind', (await call('/finance-intent', { kind: 'vibes', label: 'x' })).status === 400);
  check('rejects an empty label', (await call('/finance-intent', { kind: 'target', label: '  ' })).status === 400);
  const noMode = await call('/finance-intent', { kind: 'reserve', label: 'Brokerage' });
  check('a reserve must say wall or floor', noMode.status === 400, noMode.data.error);
  check('and rejects a nonsense mode', (await call('/finance-intent', { kind: 'reserve', mode: 'fence', label: 'x' })).status === 400);

  console.log('\ncreating one of each kind');
  const specs = [
    { kind: 'situation', label: 'Between jobs until the new one starts', body: 'No income arriving before the start date.' },
    { kind: 'reserve', mode: 'wall', label: 'Brokerage account', body: 'Would have to be sold and transferred on purpose.' },
    { kind: 'reserve', mode: 'floor', label: 'Everyday checking', body: 'Can be reached without deciding anything.' },
    { kind: 'target', label: 'Cover the transfer application year', body: '' },
    { kind: 'declared', label: 'Spanish tutoring', body: 'Chosen deliberately. Not a leak.' },
    { kind: 'slip', label: 'Takeaway on gym days', body: 'Already known. Only worth raising if it grows.' },
  ];

  for (const spec of specs) {
    const r = await call('/finance-intent', spec);
    check(`${spec.kind}${spec.mode ? '/' + spec.mode : ''} created`, r.status === 200, r.data.error || '');
    if (r.data.entry) made.push(r.data.entry.id);
  }

  const listed = (await call('/finance-intent')).data;
  // Only the rows this run created. The notebook belongs to the person
  // and may already hold intent rows of every kind.
  const mine = (kind, mode) =>
    listed.items.filter((i) => made.includes(i.id)).find((i) => i.kind === kind && (mode === undefined || i.mode === mode));
  const mineAll = () => listed.items.filter((i) => made.includes(i.id));
  check('all six come back', listed.items.length === baseline + 6, `${listed.items.length} total, ${baseline} already there`);
  check('kinds round trip', mineAll().filter((i) => i.kind === 'reserve').length === 2);
  const wall = mine('reserve', 'wall');
  const floor = mine('reserve', 'floor');
  check('wall stored as a wall', wall && wall.label === 'Brokerage account');
  check('floor stored as a floor', floor && floor.label === 'Everyday checking');
  check('non-reserve kinds carry no mode', mineAll().filter((i) => i.kind !== 'reserve').every((i) => i.mode === null));
  check('body round trips', mine('slip').body.startsWith('Already known'));
  check('an empty body comes back as empty string', mine('target').body === '');

  console.log('\nstored as ordinary entries, nothing bespoke');
  const { data: raw } = await supabase
    .from('entries').select('type, title, body, why, priority, frequency')
    .eq('user_id', U).eq('type', 'finance_intent').eq('status', 'active');
  check('every row is type finance_intent', raw.every((r) => r.type === 'finance_intent'));
  check('no finance-specific column used', raw.every((r) => r.why === null && r.priority === null && r.frequency === null));
  console.log('    titles:', raw.map((r) => r.title).join(' | '));
  check('kind is encoded in the title', raw.some((r) => r.title.startsWith('reserve/wall: ')));

  console.log('\nediting');
  const target = mine('target');
  const renamed = await call(`/finance-intent/${target.id}/update`, { label: 'Cover the application year', body: 'Updated.' });
  check('label updates', renamed.data.entry.label === 'Cover the application year', JSON.stringify(renamed.data));
  check('body updates', renamed.data.entry.body === 'Updated.');
  check('kind is unchanged', renamed.data.entry.kind === 'target');

  const tryKindChange = await call(`/finance-intent/${target.id}/update`, { kind: 'slip', label: 'Cover the application year' });
  const afterAttempt = (await call('/finance-intent')).data.items.find((i) => i.id === target.id);
  check('kind cannot be changed by an update', afterAttempt.kind === 'target', `${afterAttempt.kind} (request returned ${tryKindChange.status})`);

  const modeSwap = await call(`/finance-intent/${wall.id}/update`, { mode: 'floor' });
  check('a reserve can move between wall and floor', modeSwap.data.entry.mode === 'floor');
  check('rejects a bad mode on update', (await call(`/finance-intent/${wall.id}/update`, { mode: 'fence' })).status === 400);
  check('rejects blanking the label', (await call(`/finance-intent/${wall.id}/update`, { label: '  ' })).status === 400);

  console.log('\ndeleting is soft');
  const slip = mine('slip');
  await call(`/finance-intent/${slip.id}/delete`, {});
  const afterDelete = (await call('/finance-intent')).data;
  check('gone from the list', !afterDelete.items.some((i) => i.id === slip.id));
  const { data: tomb } = await supabase.from('entries').select('status').eq('id', slip.id).maybeSingle();
  check('row survives as a tombstone', tomb && tomb.status === 'deleted');

  console.log('\nthe planner is untouched by any of this');
  const plan = (await call('/entries')).data;
  check('stale panel never shows intent rows', plan.items.every((i) => ['habit', 'project', 'task'].includes(i.type)), `${plan.items.length} items: ${plan.items.map((i) => i.type).join(',') || 'none'}`);
  check('paused list too', (plan.paused || []).every((i) => ['habit', 'project', 'task'].includes(i.type)));
  // Count is not asserted: the notebook was deliberately reset, and pinning a
  // number here only records how many rows happened to exist that day.

  console.log('\nno model call, and no number in the engine');
  const fs = require('fs');
  // The web layer, all of it. It used to be one file; the routes moved out, so
  // reading server.js alone would now check almost nothing and would keep
  // passing however much crept into the parts it no longer holds.
  const WEB = ['server.js', 'routes/entries.js', 'routes/plan.js', 'routes/review.js', 'routes/finance.js'];
  const serverSrc = WEB.map((f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8')).join('\n');
  const brainSrc = fs.readFileSync(ROOT + '/brain.js', 'utf8');
  const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
  check('the web layer does not require the brain', !/require\('\.\.?\/brain'\)/.test(serverSrc));
  check('brain.js unchanged by this step', !/finance|intent|reserve|runway/i.test(brainSrc));
  // Rule 2.4 is about amounts belonging to a person living in the engine, not
  // about formatting in the view. A currency symbol next to a figure the
  // server computed is presentation; a hardcoded balance or threshold is the
  // thing that must never appear. So the check is for literal amounts, not
  // for the symbol.
  const literalMoney = /[$£€]\s*\d[\d,]*\.\d\d/;
  check('no amount hardcoded into the page', !literalMoney.test(html));
  check('no amount hardcoded anywhere in the web layer', !literalMoney.test(serverSrc));

  // The finance lane used to be a marked-off section of server.js. It is now
  // two whole files, so the check reads the files rather than hunting for
  // comment banners that a refactor can quietly rename away.
  //
  // finance-intent.js matters most here: it holds the interview prompt, which
  // is the one piece of engine text that talks about money at all, and it must
  // still say nothing about anyone's.
  const financeSrc = ['routes/finance.js', 'finance-intent.js']
    .map((f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8'))
    .join('\n');
  check('no amount in the finance lane', !literalMoney.test(financeSrc));
  check(
    'no threshold or balance in the finance lane',
    // HTTP statuses and the import cap are the only bare numbers allowed.
    !/\b\d{3,}\b/.test(financeSrc.replace(/\b(400|404|500|200)\b/g, '')),
    (financeSrc.replace(/\b(400|404|500|200)\b/g, '').match(/\b\d{3,}\b/g) || []).join(',')
  );
  check('the interview prompt names no figure', !/\b\d{3,}\b/.test(require(ROOT + '/finance-intent.js').SETUP_PROMPT));

  console.log('\ncleanup');
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  const { count: left } = await supabase
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U)
    .eq('type', 'finance_intent').eq('status', 'active');
  // Back to what was there before, not to zero. These rows are the
  // person's own and this run must leave exactly as many as it found.
  check('back to the rows that were already there', left === baseline, `${left}, started with ${baseline}`);

  console.log(bad === 0 ? '\nFinance step 1 clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  const supabase = H.db;
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  server.kill();
  process.exit(1);
});
