// Marking a block missed, against real rows.
//
// This used to be the review screen's suite, driving a GET that read yesterday
// and a POST that corrected it. The read half is gone: the question is asked in
// place now, on today's own blocks as they pass. What is left is the endpoint
// that records the answer, and the rule that makes recording it worth anything
// — a missed block must not count as work done.
const H = require('./harness');
const U = H.TEST_USER_ID;
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
const PORT = 3983;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

async function call(p, body) {
  const res = await fetch(BASE + p, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const server = H.spawnServer(PORT);
const DATE = '2031-02-18';
let planId = null;

(async () => {
  await H.assertGuarded();
  await H.ensureProfile();
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  const { data: plan } = await H.db
    .from('plans')
    .insert({ user_id: U, date: DATE, wake_time: '08:00:00', status: 'confirmed' })
    .select('id')
    .single();
  planId = plan.id;

  const { data: rows } = await H.db
    .from('blocks')
    .insert([
      { user_id: U, plan_id: planId, title: 'Reading', start_time: '08:00:00', duration_minutes: 60, sort_order: 0 },
      { user_id: U, plan_id: planId, title: 'Gym', start_time: '09:00:00', duration_minutes: 60, sort_order: 1 },
    ])
    .select('id, title, completed');
  const reading = rows.find((r) => r.title === 'Reading');
  const gym = rows.find((r) => r.title === 'Gym');

  console.log('a day is assumed to have gone as planned');
  check('a new block is already complete', rows.every((r) => r.completed === true));

  console.log('\nmarking one missed');
  {
    const r = await call(`/blocks/${reading.id}/miss`, { missed: true, reason: 'ran out of time' });
    check('accepted', r.status === 200, JSON.stringify(r.data));
    check('and it reports back',
      r.data.completed === false && r.data.miss_reason === 'ran out of time', JSON.stringify(r.data));

    const { data: after } = await H.db
      .from('blocks').select('title, completed, miss_reason').eq('plan_id', planId).order('sort_order');
    check('the row really changed', after[0].completed === false, String(after[0].completed));
    check('with its reason', after[0].miss_reason === 'ran out of time', String(after[0].miss_reason));
    check('and the other is untouched', after[1].completed === true);
  }

  console.log('\nthe reason is optional');
  {
    const r = await call(`/blocks/${gym.id}/miss`, { missed: true });
    check('a miss with nothing said is still a miss', r.data.completed === false);
    check('and stores null rather than an empty string', r.data.miss_reason === null,
      JSON.stringify(r.data.miss_reason));

    const blank = await call(`/blocks/${gym.id}/miss`, { missed: true, reason: '   ' });
    check('whitespace is not a reason', blank.data.miss_reason === null,
      JSON.stringify(blank.data.miss_reason));
  }

  console.log('\nputting one back');
  {
    const r = await call(`/blocks/${reading.id}/miss`, { missed: false });
    check('completed again', r.data.completed === true);
    // An un-marked block must not keep an explanation for something that did
    // happen.
    check('and the reason went with it', r.data.miss_reason === null,
      JSON.stringify(r.data.miss_reason));
  }

  console.log('\nwhat a miss is worth');
  {
    // The reason this endpoint exists at all. staleness counts blocks where
    // completed is true, so a block marked missed must not reset the clock on
    // the thing it was for.
    const { data: entry } = await H.db
      .from('entries')
      .insert({ user_id: U, type: 'habit', title: '__probe miss', frequency: 'daily' })
      .select('id')
      .single();

    const { data: b } = await H.db
      .from('blocks')
      .insert({
        user_id: U, plan_id: planId, title: '__probe miss', entry_id: entry.id,
        start_time: '10:00:00', duration_minutes: 30, sort_order: 2,
      })
      .select('id')
      .single();

    const { lastScheduled } = require(ROOT + '/staleness.js');

    const done = await lastScheduled(U);
    check('a completed block counts as having done it', done.get(entry.id) === DATE,
      String(done.get(entry.id)));

    await call(`/blocks/${b.id}/miss`, { missed: true });
    const missed = await lastScheduled(U);
    check('a missed one does not', missed.get(entry.id) === undefined,
      String(missed.get(entry.id)));

    await call(`/blocks/${b.id}/miss`, { missed: false });
    const back = await lastScheduled(U);
    check('and putting it back counts again', back.get(entry.id) === DATE,
      String(back.get(entry.id)));

    await H.db.from('entries').delete().eq('user_id', U).eq('id', entry.id);
  }

  console.log('\nrefusals');
  {
    const unknown = await call('/blocks/00000000-0000-0000-0000-0000000000ff/miss', { missed: true });
    check('an unknown block is a 404, not a silent success', unknown.status === 404,
      `${unknown.status}`);

    // The read half of the old review screen. Asking about yesterday the next
    // morning is not how this works any more.
    const gone = await fetch(`${BASE}/review`);
    check('GET /review is gone', gone.status === 404, `${gone.status}`);
  }

  console.log('\ncleanup');
  server.kill();
  await H.db.from('plans').delete().eq('user_id', U).eq('id', planId);
  await H.cleanup();
  const { count } = await H.raw
    .from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('no blocks left', count === 0, `${count}`);

  console.log(bad === 0 ? '\nBlocks clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  server.kill();
  if (planId) await H.db.from('plans').delete().eq('user_id', U).eq('id', planId);
  await H.cleanup();
  process.exit(1);
});
