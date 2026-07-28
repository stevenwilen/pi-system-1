// The copy-paste interview flow. Real endpoints, real rows.
const H = require('./harness');
const U = H.TEST_USER_ID;
const { spawn } = require('child_process');
const fs = require('fs');
const vm = require('vm');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const PORT = 3976;
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

// The extractor and validator, lifted from the shipped page.
const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const helpers = script.match(/const KINDS = \[[\s\S]*?function validateIntents[\s\S]*?\n      \}/)[0];
const ctx = vm.createContext({ Array, String, JSON, console });
vm.runInContext(helpers, ctx);

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const supabase = H.db;

  // What was already there. The notebook is the person's, and this run has to
  // leave exactly as many rows as it found rather than expecting none.
  const { count: baseline } = await supabase
    .from('entries')
    .select('*', { count: 'exact', head: true }).eq('user_id', U)
    .eq('type', 'finance_intent')
    .eq('status', 'active');
  console.log(`  ${baseline} intent row(s) already present\n`);

  console.log('the prompt is engine text');
  const prompt = (await call('/finance-intent/setup-prompt')).data.prompt;
  check('served', typeof prompt === 'string' && prompt.length > 400, `${prompt.length} chars`);
  check('asks about all six subjects', ['Income', 'bank', 'off limits', 'building toward', 'consciously chosen', 'overspend'].every((s) => new RegExp(s, 'i').test(prompt)));
  check('asks for wall or floor explicitly', /wall.*floor|floor.*wall/is.test(prompt));
  check('asks conversationally, not as a form', /one or two questions at a time/i.test(prompt) && /not.*a form|wall of questions/i.test(prompt));
  check('demands a fenced json block and nothing after', /```json/.test(prompt) && /nothing after it/i.test(prompt));
  check('names the five kinds', ['situation', 'reserve', 'target', 'declared', 'slip'].every((k) => prompt.includes(k)));

  // Rule 2.4: identical for everyone.
  check('contains no personal amount', !/[$£€]\s*\d/.test(prompt));
  check('contains no name, account or merchant', !/\b(chase|fidelity|venmo|zelle|kalshi|steve)\b/i.test(prompt));
  const again = (await call('/finance-intent/setup-prompt')).data.prompt;
  check('identical on every request', again === prompt);

  console.log('\nextracting the json from a paste');
  const good = { intents: [{ kind: 'situation', title: 'Between jobs', body: 'Starts in August.' }] };
  const cases = [
    ['a bare object', JSON.stringify(good)],
    ['a fenced block', '```json\n' + JSON.stringify(good, null, 2) + '\n```'],
    ['a fence with no language tag', '```\n' + JSON.stringify(good) + '\n```'],
    ['prose before the fence', 'Great, here is your summary!\n\n```json\n' + JSON.stringify(good) + '\n```'],
    ['prose after the fence too', 'Here:\n```json\n' + JSON.stringify(good) + '\n```\nLet me know if you want changes.'],
    ['prose and a bare object', 'Here you go:\n\n' + JSON.stringify(good) + '\n\nHope that helps.'],
    ['a bare array', JSON.stringify(good.intents)],
  ];
  for (const [label, text] of cases) {
    const out = ctx.extractJson(text);
    check(label, Array.isArray(out) && out.length === 1, out ? `${out.length} entries` : 'nothing');
  }

  console.log('\nand refusing what it cannot read');
  for (const [label, text] of [
    ['empty paste', ''],
    ['prose only', 'I could not complete that request.'],
    ['broken json', '```json\n{ "intents": [ { "kind": '],
  ]) {
    check(label, ctx.extractJson(text) === null || ctx.validateIntents(ctx.extractJson(text)) !== null);
  }

  console.log('\nvalidation before anything is written');
  check('unknown kind', ctx.validateIntents([{ kind: 'vibes', title: 'x' }]) !== null);
  check('missing title', ctx.validateIntents([{ kind: 'target', title: '  ' }]) !== null);
  check('empty list', ctx.validateIntents([]) !== null);
  const noMode = ctx.validateIntents([{ kind: 'reserve', title: 'Brokerage', body: 'Do not touch it.' }]);
  check('a reserve that says neither wall nor floor', noMode !== null, noMode);
  check('a reserve that says both', ctx.validateIntents([{ kind: 'reserve', title: 'x', body: 'a wall and a floor' }]) !== null);
  check('a valid set passes', ctx.validateIntents(good.intents) === null);

  console.log('\nimport writes all or nothing');
  const before = (await call('/finance-intent')).data.items.length;

  const partial = await call('/finance-intent/import', {
    intents: [
      { kind: 'situation', title: 'Fine', body: 'ok' },
      { kind: 'nonsense', title: 'Bad', body: 'ok' },
    ],
  });
  check('one bad entry rejects the whole import', partial.status === 400, partial.data.error);
  check('and nothing was written', (await call('/finance-intent')).data.items.length === before);

  const badReserve = await call('/finance-intent/import', {
    intents: [{ kind: 'reserve', title: 'Brokerage', body: 'Leave it alone.' }],
  });
  check('a reserve without wall or floor is refused', badReserve.status === 400, badReserve.data.error);

  console.log('\na real interview result');
  const interview = {
    intents: [
      { kind: 'situation', title: 'Between jobs until mid August', body: 'No income arriving before the start date.' },
      { kind: 'reserve', title: 'Brokerage account', body: 'This is a wall. Selling and transferring would be a deliberate act.' },
      { kind: 'reserve', title: 'Everyday checking', body: 'A floor. Ordinary spending can reach it without any decision.' },
      { kind: 'target', title: 'Cover the application year', body: 'Enough set aside to not need work during it.' },
      { kind: 'declared', title: 'Spanish tutoring', body: 'Chosen deliberately and not up for discussion.' },
      { kind: 'slip', title: 'Takeaway on gym days', body: 'Already known. Only worth raising if it grows.' },
    ],
  };

  const saved = await call('/finance-intent/import', interview);
  check('saved', saved.status === 200 && saved.data.saved === 6, JSON.stringify(saved.data).slice(0, 80));
  for (const e of saved.data.entries || []) made.push(e.id);

  const listed = (await call('/finance-intent')).data;
  check('all six appear', listed.items.length === before + 6, `${listed.items.length}`);
  check('the wall was read as a wall', listed.items.some((i) => i.mode === 'wall' && i.label === 'Brokerage account'));
  check('the floor as a floor', listed.items.some((i) => i.mode === 'floor' && i.label === 'Everyday checking'));
  check('every kind survived', ['situation', 'reserve', 'target', 'declared', 'slip'].every((k) => listed.items.some((i) => i.kind === k)));
  check('bodies survived', listed.items.some((i) => i.body.includes('deliberate act')));

  console.log('\nimporting again appends rather than replacing');
  const second = await call('/finance-intent/import', {
    intents: [{ kind: 'target', title: 'Second target', body: 'Added later.' }],
  });
  for (const e of second.data.entries || []) made.push(e.id);
  const after = (await call('/finance-intent')).data;
  check('the first six are still there', after.items.length === listed.items.length + 1, `${after.items.length}`);
  check('nothing was wiped', after.items.some((i) => i.label === 'Brokerage account'));

  console.log('\ncleanup');
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  const { count: left } = await supabase
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('type', 'finance_intent');
  check('back to the rows that were already there', left === baseline, `${left}, started with ${baseline}`);

  console.log(bad === 0 ? '\nSetup interview clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  server.on('exit', () => process.exit(bad === 0 ? 0 : 1));
  setTimeout(() => process.exit(bad === 0 ? 0 : 1), 2000);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  const supabase = H.db;
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  server.kill();
  process.exit(1);
});
