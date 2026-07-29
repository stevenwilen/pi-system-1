// Step 6, against a real plan for the real yesterday.
const H = require('./harness');
const U = H.TEST_USER_ID;
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
const PORT = 3983;
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

let planId = null;

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const supabase = H.db;

  console.log('with nothing planned yesterday');
  const empty = await call('/review');
  check('answers rather than erroring', empty.status === 200);
  check('reports the date it looked at', /^\d{4}-\d{2}-\d{2}$/.test(empty.data.date), empty.data.date);
  check('no blocks', empty.data.blocks.length === 0);

  const yesterday = empty.data.date;
  const feed = (await call('/entries')).data;
  check('the date really is the day before today', (() => {
    const d = new Date(`${feed.today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10) === yesterday;
  })(), `${yesterday} vs today ${feed.today}`);

  console.log('\nwith a real confirmed day behind us');
  // Blocks carry no entry_id here. Review is about what happened, not about
  // what it was tagged to, and the notebook may legitimately be empty.
  const { data: plan } = await supabase
    .from('plans').insert({ user_id: U, date: yesterday, wake_time: '08:00:00', status: 'confirmed' })
    .select('id').single();
  planId = plan.id;

  const target = { title: 'Morning block' };
  const rows = [
    { title: target.title, entry_id: null, start_time: '08:00:00', duration_minutes: 60, pinned: false },
    { title: 'Dentist', entry_id: null, start_time: '10:00:00', duration_minutes: 60, pinned: false },
    { title: 'Deep work', entry_id: null, start_time: '11:00:00', duration_minutes: 120, pinned: false },
  ].map((r, i) => ({ user_id: U, plan_id: planId, sort_order: i, message_text: null, message_sent_at: null, ...r }));
  const { error: insErr } = await supabase.from('blocks').insert(rows);
  if (insErr) throw new Error(insErr.message);

  const review = (await call('/review')).data;
  check('all three blocks come back', review.blocks.length === 3, `${review.blocks.length}`);
  check('in plan order', review.blocks.map((b) => b.title).join('|') === `${target.title}|Dentist|Deep work`);
  check('assumed done, no confirmation asked for', review.blocks.every((b) => b.completed === true));
  check('no reasons yet', review.blocks.every((b) => b.miss_reason === null));
  check('times come back as minutes', review.blocks[1].start_minutes === 600 && review.blocks[1].duration_minutes === 45);
  // Nothing is pinned any more, and yesterday's review has no use for the
  // distinction: a block either happened or it did not.
  check('nothing is reported as pinned', review.blocks.every((b) => b.pinned === undefined));

  console.log('\nmarking one missed, with a reason');
  const deep = review.blocks[2];
  const missed = await call(`/blocks/${deep.id}/miss`, { missed: true, reason: 'Ran over on the call' });
  check('accepted', missed.status === 200, JSON.stringify(missed.data));
  check('completed flipped to false', missed.data.completed === false);
  check('reason stored', missed.data.miss_reason === 'Ran over on the call');

  let after = (await call('/review')).data;
  check('review shows it missed', after.blocks[2].completed === false);
  check('and carries the reason', after.blocks[2].miss_reason === 'Ran over on the call');
  check('the others are untouched', after.blocks.slice(0, 2).every((b) => b.completed === true));

  console.log('\na miss with no reason at all');
  const bare = await call(`/blocks/${review.blocks[0].id}/miss`, { missed: true });
  check('still recorded', bare.data.completed === false);
  check('reason left null rather than empty string', bare.data.miss_reason === null, JSON.stringify(bare.data.miss_reason));

  const blank = await call(`/blocks/${review.blocks[1].id}/miss`, { missed: true, reason: '   ' });
  check('whitespace is not a reason', blank.data.miss_reason === null);

  console.log('\nputting one back');
  const undo = await call(`/blocks/${deep.id}/miss`, { missed: false });
  check('completed back to true', undo.data.completed === true);
  check('reason cleared with it', undo.data.miss_reason === null, JSON.stringify(undo.data.miss_reason));

  console.log('\nthe rows really changed in the database');
  const { data: raw } = await supabase
    .from('blocks').select('title, completed, miss_reason').eq('plan_id', planId).order('sort_order');
  for (const r of raw) console.log(`    ${r.completed ? 'done ' : 'MISS '} ${r.title}${r.miss_reason ? ` :: ${r.miss_reason}` : ''}`);
  check('two missed, one done', raw.filter((r) => !r.completed).length === 2);

  console.log('\nunknown block');
  const ghost = await call('/blocks/00000000-0000-0000-0000-0000000000ff/miss', { missed: true });
  check('404 rather than a silent success', ghost.status === 404, `${ghost.status}`);

  console.log('\na pending day is not reviewable');
  await supabase.from('plans').update({ status: 'pending' }).eq('user_id', U).eq('id', planId);
  const pending = (await call('/review')).data;
  check('nothing to review', pending.blocks.length === 0, `${pending.blocks.length}`);

  console.log('\ncleanup');
  await supabase.from('plans').delete().eq('user_id', U).eq('id', planId);
  planId = null;
  const { count: plansLeft } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U);
  const { count: blocksLeft } = await supabase.from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('no plans left', plansLeft === 0, `${plansLeft}`);
  check('no blocks left', blocksLeft === 0, `${blocksLeft}`);

  console.log(bad === 0 ? '\nStep 6 clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (planId) await H.db.from('plans').delete().eq('user_id', U).eq('id', planId);
  server.kill();
  process.exit(1);
});
