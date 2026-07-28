// How the list orders itself, and the coldness verdict. Real rows, one real
// model call.
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
  // sort_order and priority are checked for existence, not for use. Both are
  // retired and neither is written; the point is that they are still there
  // rather than dropped.
  for (const col of ['sort_order', 'priority', 'cold', 'cold_reason']) {
    const { error } = await supabase.from('entries').select(`id, ${col}`).limit(1);
    check(`${col} still exists in the schema`, !error, error ? error.message : '');
  }
  if (bad) { server.kill(); process.exit(1); }

  console.log('\npriority is gone from the write path');
  const withPriority = await call('/entries', { type: 'project', title: '__p project', why: 'because', priority: 1 });
  check('accepted without complaint', withPriority.status === 200, withPriority.data.error || '');
  if (withPriority.data.entry) made.push(withPriority.data.entry.id);
  const { data: raw } = await supabase.from('entries').select('priority').eq('id', withPriority.data.entry.id).single();
  check('and the value was dropped, not stored', raw.priority === null, String(raw.priority));

  console.log('\nthe list orders itself by neglect');
  const a = await call('/entries', { type: 'task', title: '__p A' });
  const b = await call('/entries', { type: 'task', title: '__p B' });
  const c = await call('/entries', { type: 'task', title: '__p C' });
  for (const r of [a, b, c]) if (r.data.entry) made.push(r.data.entry.id);

  // Backdated so the ages actually differ. Four rows created now would all tie
  // at zero days and fall back to alphabetical, which would prove nothing.
  const daysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };
  await supabase.from('entries').update({ created_at: daysAgo(30) }).eq('user_id', U).eq('id', a.data.entry.id);
  await supabase.from('entries').update({ created_at: daysAgo(10) }).eq('user_id', U).eq('id', b.data.entry.id);
  await supabase.from('entries').update({ created_at: daysAgo(2) }).eq('user_id', U).eq('id', c.data.entry.id);

  let feed = (await call('/entries')).data;
  const titles = feed.items.map((i) => i.title);
  check('longest left, first', titles.slice(0, 3).join(',') === '__p A,__p B,__p C', titles.slice(0, 4).join(','));
  check('and the days descend',
    feed.items.every((it, i, all) => i === 0 || all[i - 1].days >= it.days),
    feed.items.map((i) => i.days).join(','));

  // Being newly added is not a position. The freshest row sorts to the bottom.
  check('a new row does not jump the queue', titles[0] !== '__p project', titles.slice(0, 2).join(','));

  console.log('\nthere is no order to set');
  const ids = feed.items.map((i) => i.id);
  const reorder = await fetch(BASE + '/entries/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ids.slice().reverse() }),
  });
  check('the reorder endpoint is gone', reorder.status === 404, String(reorder.status));

  const stillThere = (await call('/entries')).data;
  check('and asking did not change anything', stillThere.items.map((i) => i.id).join(',') === ids.join(','));

  console.log('\nno position is written on create');
  {
    const { data: rows } = await supabase
      .from('entries').select('title, sort_order').eq('user_id', U).in('id', made);
    check('every row this made has a null sort_order',
      rows.every((r) => r.sort_order === null),
      rows.map((r) => r.title + '=' + r.sort_order).join(' '));
    check('and the column is still in the schema', rows.length > 0 && 'sort_order' in rows[0]);
  }

  console.log('\na row carrying an old position still renders');
  {
    // Rows written before ranking was removed still hold a number. It has to be
    // ignored rather than obeyed: this one is 0, which under the old rule would
    // have put it first.
    await supabase.from('entries').update({ sort_order: 0 }).eq('user_id', U).eq('id', c.data.entry.id);
    const mixed = (await call('/entries')).data;
    check('the leftover number does not move it', mixed.items[0].title === '__p A', mixed.items[0].title);
    check('and it is not sent to the client', mixed.items[0].sort_order === undefined);
    await supabase.from('entries').update({ sort_order: null }).eq('user_id', U).eq('id', c.data.entry.id);
  }

  console.log('\nnothing reorders itself');
  const before = (await call('/entries')).data.items.map((i) => i.id);
  await call('/entries/' + before[before.length - 1] + '/pause', { paused: true });
  await call('/entries/' + before[before.length - 1] + '/pause', { paused: false });
  const after = (await call('/entries')).data.items.map((i) => i.id);
  check('pausing and resuming leaves the order alone', before.join(',') === after.join(','));

  feed = (await call('/entries')).data;


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
  // These three are the same kind of thing at three different ages, which is
  // the judgement the whole job exists to make.
  const twoDays = all.find((i) => i.title === '__p C');
  const thirtyDays = all.find((i) => i.title === '__p A');
  check('a task untouched for two days is not cold', twoDays && twoDays.cold === false, twoDays && twoDays.cold_reason);
  check('a task untouched for thirty is', thirtyDays && thirtyDays.cold === true, thirtyDays && thirtyDays.cold_reason);

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
