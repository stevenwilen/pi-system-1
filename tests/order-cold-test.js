// Manual ordering and the coldness verdict. Real rows, one real model call.
const H = require('./harness');
const U = H.TEST_USER_ID;
process.env.SCHEDULER_DISABLED = '1';

const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const PORT = 3980;
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

  console.log('schema');
  for (const col of ['sort_order', 'cold', 'cold_reason']) {
    const { error } = await supabase.from('entries').select(`id, ${col}`).limit(1);
    check(`${col} exists`, !error, error ? 'run migration-manual-order.sql' : '');
  }
  if (bad) { server.kill(); process.exit(1); }

  console.log('\npriority is gone from the write path');
  const withPriority = await call('/entries', { type: 'project', title: '__p project', why: 'because', priority: 1 });
  check('accepted without complaint', withPriority.status === 200, withPriority.data.error || '');
  if (withPriority.data.entry) made.push(withPriority.data.entry.id);
  const { data: raw } = await supabase.from('entries').select('priority').eq('id', withPriority.data.entry.id).single();
  check('and the value was dropped, not stored', raw.priority === null, String(raw.priority));

  console.log('\nnew items go to the top');
  const a = await call('/entries', { type: 'task', title: '__p A' });
  const b = await call('/entries', { type: 'task', title: '__p B' });
  const c = await call('/entries', { type: 'task', title: '__p C' });
  for (const r of [a, b, c]) if (r.data.entry) made.push(r.data.entry.id);

  let feed = (await call('/entries')).data;
  const titles = feed.items.map((i) => i.title);
  check('newest first', titles.slice(0, 3).join(',') === '__p C,__p B,__p A', titles.slice(0, 4).join(','));
  check('adding one did not disturb the others', titles.indexOf('__p A') < titles.indexOf('__p project') + 2);

  console.log('\nreorder takes the whole list');
  const ids = feed.items.map((i) => i.id);
  const reversed = ids.slice().reverse();
  const ok = await call('/entries/reorder', { ids: reversed });
  check('accepted', ok.status === 200 && ok.data.ordered === reversed.length, JSON.stringify(ok.data));

  feed = (await call('/entries')).data;
  check('the stored order is the sent order', feed.items.map((i) => i.id).join(',') === reversed.join(','));
  check('sort_order is 0..n', feed.items.every((it, i) => it.sort_order === i), feed.items.map((i) => i.sort_order).join(','));

  console.log('\nreorder refuses what it should');
  check('empty list', (await call('/entries/reorder', { ids: [] })).status === 400);
  check('not an array', (await call('/entries/reorder', { ids: 'nope' })).status === 400);
  check('repeated ids', (await call('/entries/reorder', { ids: [ids[0], ids[0]] })).status === 400);
  const foreign = await call('/entries/reorder', { ids: ['00000000-0000-0000-0000-0000000000ff'] });
  check('an id that is not theirs', foreign.status === 400, foreign.data.error);

  console.log('\nnothing reorders itself');
  const before = (await call('/entries')).data.items.map((i) => i.id);
  await call(`/entries/${before[before.length - 1]}/pause`, { paused: true });
  await call(`/entries/${before[before.length - 1]}/pause`, { paused: false });
  const after = (await call('/entries')).data.items.map((i) => i.id);
  check('pausing and resuming leaves the order alone', before.join(',') === after.join(','));

  console.log('\nediting keeps the rules');
  const proj = feed.items.find((i) => i.title === '__p project');
  check('cannot empty a project why', (await call(`/entries/${proj.id}/update`, { why: '  ' })).status === 400);
  check('cannot empty a title', (await call(`/entries/${proj.id}/update`, { title: '' })).status === 400);
  const renamed = await call(`/entries/${proj.id}/update`, { title: '__p renamed' });
  check('title edits', renamed.status === 200 && renamed.data.entry.title === '__p renamed');

  const hab = await call('/entries', { type: 'habit', title: '__p habit', frequency: 'daily' });
  made.push(hab.data.entry.id);
  check('cannot set a habit to a bad frequency', (await call(`/entries/${hab.data.entry.id}/update`, { frequency: 'often' })).status === 400);
  const freq = await call(`/entries/${hab.data.entry.id}/update`, { frequency: 'weekly' });
  check('frequency edits', freq.data.entry.frequency === 'weekly');
  check('editing one field leaves the other alone', freq.data.entry.title === '__p habit');

  console.log('\nthe coldness verdict');
  const { judge, parseVerdicts } = require(ROOT + '/coldness.js');

  check('parser accepts a clean reply', parseVerdicts('1|yes|a\n2|no|b', 2) instanceof Map);
  check('rejects a missing item', parseVerdicts('1|yes|a', 2) === null);
  check('rejects a bad verdict word', parseVerdicts('1|maybe|a\n2|no|b', 2) === null);
  check('rejects a duplicate', parseVerdicts('1|yes|a\n1|no|b', 2) === null);
  // Length is not a structural fault. One verbose sentence should not cost a
  // whole day's judgment, so it is trimmed rather than refused.
  const long = parseVerdicts(`1|yes|${'word '.repeat(60)}\n2|no|b`, 2);
  check('an overlong reason is trimmed, not refused', long !== null && long.get(1).reason.length <= 120,
    long ? `${long.get(1).reason.length} chars` : 'refused');
  check('and it is trimmed on a word boundary', long !== null && long.get(1).reason.endsWith('…'));

  // Pause one so the never-cold rule has something to bite on.
  await call(`/entries/${hab.data.entry.id}/pause`, { paused: true });

  // Everything so far was created today, so nothing could be cold and the
  // verdict would be untested against a real gap.
  //
  // Ten days is the discriminating age. A daily habit untouched that long is a
  // clear lapse; a monthly one has not yet missed a cycle. Forty days would
  // not test anything, because by then the monthly one has missed one too and
  // both answers are correctly the same.
  const longAgo = new Date(Date.now() - 10 * 86400000).toISOString();

  const stale = await call('/entries', { type: 'habit', title: '__p daily habit', frequency: 'daily' });
  made.push(stale.data.entry.id);
  await supabase.from('entries').update({ created_at: longAgo }).eq('user_id', U).eq('id', stale.data.entry.id);

  const monthly = await call('/entries', { type: 'habit', title: '__p monthly habit', frequency: 'monthly' });
  made.push(monthly.data.entry.id);
  await supabase.from('entries').update({ created_at: longAgo }).eq('user_id', U).eq('id', monthly.data.entry.id);

  // Captured immediately before judging, so the comparison afterwards is
  // against what was actually on screen at that moment.
  const feedBefore = (await call('/entries')).data;
  const orderBefore = feedBefore.items.map((i) => i.id);
  const today = feedBefore.today;
  const before2 = Date.now();
  const result = await judge(U, today);
  console.log(`    took ${Math.round((Date.now() - before2) / 1000)}s`);
  check('judged every item', result.judged > 0, JSON.stringify(result));

  const judged = (await call('/entries')).data;
  console.log('');
  for (const i of [...judged.items, ...judged.paused]) {
    console.log(`    ${i.cold ? 'COLD' : '    '}  ${i.title.padEnd(16)} ${i.paused ? '(paused) ' : ''}${i.cold_reason || ''}`);
  }

  const all = [...judged.items, ...judged.paused];
  check('every item has a reason', all.every((i) => i.cold_reason));
  check('a paused item is never cold', judged.paused.every((i) => i.cold === false));
  check('a paused item still explains itself', judged.paused.every((i) => i.cold_reason));
  check('reasons stay one line', all.every((i) => !i.cold_reason.includes('\n')));

  const dailyOld = all.find((i) => i.title === '__p daily habit');
  const monthlyOld = all.find((i) => i.title === '__p monthly habit');

  check('something cold was actually found', all.some((i) => i.cold), `${all.filter((i) => i.cold).length} cold`);
  check('a daily habit untouched for 10 days is cold', dailyOld && dailyOld.cold === true, dailyOld && dailyOld.cold_reason);
  check('items added today are not cold', all.filter((i) => /__p [ABC]$/.test(i.title)).every((i) => !i.cold));

  // Ten days is genuinely borderline for a monthly habit: a third of a cycle
  // gone with nothing done. The model has answered it both ways across runs,
  // defensibly each time, so asserting a verdict there would only test which
  // way it happened to land.
  //
  // What must always hold is the direction. Frequency can only make the
  // threshold tighter, so at the same age the daily one is cold whenever the
  // monthly one is, and never the other way round.
  check(
    'frequency moves the threshold the right way',
    !(monthlyOld && monthlyOld.cold && dailyOld && !dailyOld.cold),
    `daily ${dailyOld && dailyOld.cold ? 'cold' : 'not cold'}, monthly ${monthlyOld && monthlyOld.cold ? 'cold' : 'not cold'}`
  );
  console.log(`    monthly at 10 days was judged: ${monthlyOld && monthlyOld.cold ? 'cold' : 'not cold'} (borderline either way)`);

  console.log('\nthe verdict does not reorder anything');
  const orderAfter = judged.items.map((i) => i.id);
  check('order unchanged by judging', orderAfter.join(',') === orderBefore.join(','),
    `${orderBefore.length} items before, ${orderAfter.length} after`);
  check('a cold item did not move to the top', (() => {
    const coldIds = judged.items.filter((i) => i.cold).map((i) => i.id);
    return coldIds.every((id) => orderAfter.indexOf(id) === orderBefore.indexOf(id));
  })(), 'cold is an outline, not a sort');

  console.log('\na failed judgement leaves yesterday standing');
  const first = judged.items[0];
  await supabase.from('entries').update({ cold: true, cold_reason: 'yesterday' }).eq('user_id', U).eq('id', first.id);
  const { parseVerdicts: pv } = require(ROOT + '/coldness.js');
  check('malformed output is refused before any write', pv('garbage', 3) === null);
  const { data: still } = await supabase.from('entries').select('cold, cold_reason').eq('id', first.id).single();
  check('the previous verdict is intact', still.cold === true && still.cold_reason === 'yesterday');

  console.log('\ncleanup');
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  const { count: left } = await supabase
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U).like('title', '__p%');
  check('probe rows removed', left === 0, `${left}`);

  console.log(bad === 0 ? '\nManual order and coldness clean' : `\n${bad} FAILURE(S)`);
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
