// Finishing something, and what a miss is worth.
//
// Two holes that were the same hole: the system recorded outcomes and then
// never read them. A completed task stayed on the list forever, and a block
// that was missed reset the staleness clock exactly as much as one that was
// done — so something dodged four weeks running read as fresh every Monday.
//
// Both are checked against real rows, because the claim is about what the
// database returns and not about what the code looks like.
const H = require('./harness');
const U = H.TEST_USER_ID;
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const { lastScheduled } = require(ROOT + '/staleness.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Its own port. 3986 belongs to calendar-endpoint-test.
const PORT = 3988;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => (await fetch(BASE + p)).json();

// Rows this suite made, cleaned up whatever happens.
const made = { entries: [], plans: [] };

async function entry(type, title) {
  const { data, error } = await H.db
    .from('entries')
    .insert({ user_id: U, type, title, why: type === 'project' ? 'because' : null })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  made.entries.push(data.id);
  return data.id;
}

// A plan on a date, holding a block per entry, each done or missed.
//
// One plan per date: plans are unique on (user_id, date), so two entries being
// compared on the same day have to share a plan, which is what a real day does
// anyway.
async function planWith(date, blocks) {
  const { data: plan, error } = await H.db
    .from('plans')
    .insert({ user_id: U, date, wake_time: '08:00:00', status: 'confirmed' })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  made.plans.push(plan.id);

  const { error: blockErr } = await H.db.from('blocks').insert(
    blocks.map(([entryId, completed], i) => ({
      user_id: U,
      plan_id: plan.id,
      entry_id: entryId,
      title: 'whatever',
      start_time: `${String(9 + i).padStart(2, '0')}:00:00`,
      duration_minutes: 30,
      completed,
    }))
  );
  if (blockErr) throw new Error(blockErr.message);
  return plan.id;
}

// Every delete filters on the test user, which the harness guard enforces
// rather than trusts.
async function cleanup() {
  for (const id of made.plans) {
    await H.db.from('blocks').delete().eq('user_id', U).eq('plan_id', id);
    await H.db.from('plans').delete().eq('user_id', U).eq('id', id);
  }
  for (const id of made.entries) {
    await H.db.from('entries').delete().eq('user_id', U).eq('id', id);
  }
  made.plans.length = 0;
  made.entries.length = 0;
}

(async () => {
  await H.assertGuarded();
  // Everything the test user owns, before the profile is put back. A run that
  // died holding rows would otherwise collide here: plans are unique on
  // (user_id, date), so the leftovers are not inert.
  await H.cleanup();
  await H.ensureProfile();

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  console.log('a missed block does not reset the clock');
  {
    const doneOne = await entry('habit', 'Gym done');
    const missedOne = await entry('habit', 'Gym dodged');

    // Same day, same plan, same shape. One difference: whether it happened.
    await planWith('2031-01-10', [[doneOne, true], [missedOne, false]]);

    const seen = await lastScheduled(U);
    check('doing it counts', seen.get(doneOne) === '2031-01-10', String(seen.get(doneOne)));
    check('missing it does not', !seen.has(missedOne), String(seen.get(missedOne)));

    // This is the bug in one line: before, both of these were the same date and
    // the thing nobody did looked exactly as fresh as the thing they did.
    check('so the two do not read the same', seen.get(doneOne) !== seen.get(missedOne));
  }

  console.log('\nand the panel counts from when it was last actually done');
  {
    const dodged = await entry('task', 'Passport');
    // Planned twice, recently, and skipped both times.
    await planWith('2031-02-01', [[dodged, false]]);
    await planWith('2031-02-08', [[dodged, false]]);

    const list = await get('/entries');
    const row = list.items.find((i) => i.id === dodged);
    check('it is still on the list', Boolean(row));
    check('and counts from when it was added, not when it was planned',
      row && row.last_scheduled === null, String(row && row.last_scheduled));

    // Now it actually happens.
    await planWith('2031-02-15', [[dodged, true]]);
    const after = (await get('/entries')).items.find((i) => i.id === dodged);
    check('doing it moves the clock', after.last_scheduled === '2031-02-15', String(after.last_scheduled));
  }

  console.log('\na task that is done leaves the list');
  {
    const task = await entry('task', 'Haircut');
    check('it starts on the list', (await get('/entries')).items.some((i) => i.id === task));

    const r = await post(`/entries/${task}/done`);
    check('done is accepted', r.status === 200, JSON.stringify(r.body));

    const after = await get('/entries');
    check('it is off the list', !after.items.some((i) => i.id === task));
    check('and not hiding in paused', !after.paused.some((i) => i.id === task));

    // Kept, not destroyed. This is the whole difference from Delete.
    const { data } = await H.db.from('entries').select('status').eq('id', task).single();
    check('the row is still there, marked done', data && data.status === 'done', JSON.stringify(data));
  }

  console.log('\nonly a task can be done in one go');
  {
    const habit = await entry('habit', 'Spanish');
    const project = await entry('project', 'Thesis');

    const h = await post(`/entries/${habit}/done`);
    check('a habit is refused', h.status === 400, JSON.stringify(h.body));
    const p = await post(`/entries/${project}/done`);
    check('a project is refused', p.status === 400, JSON.stringify(p.body));

    const list = await get('/entries');
    check('and both are still on the list',
      list.items.some((i) => i.id === habit) && list.items.some((i) => i.id === project));
  }

  console.log('\ndone is not delete, and a tombstone stays one');
  {
    const gone = await entry('task', 'Deleted thing');
    await post(`/entries/${gone}/delete`);

    const r = await post(`/entries/${gone}/done`);
    check('a deleted row cannot be finished', r.status === 404, JSON.stringify(r.body));

    const { data } = await H.db.from('entries').select('status').eq('id', gone).single();
    check('it is still a tombstone', data && data.status === 'deleted', JSON.stringify(data));

    // The tool the brain holds has to refuse it too, not just the route.
    const { update_entry } = require(ROOT + '/tools.js');
    const viaTool = await update_entry(U, gone, { status: 'done' });
    check('and the tool refuses it as well', Boolean(viaTool.error), JSON.stringify(viaTool).slice(0, 80));

    const { data: still } = await H.db.from('entries').select('status').eq('id', gone).single();
    check('still a tombstone after that', still && still.status === 'deleted', JSON.stringify(still));
  }

  console.log('\nthe page offers Done where it means something');
  {
    const fs = require('fs');
    const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
    check('only on a task', /item\.type === 'task' && !item\.paused/.test(html));
    check('and it posts to the done route', /entries\/\$\{item\.id\}\/done/.test(html));
    check('Delete still asks first', /confirm\(`Delete/.test(html));
  }

  console.log('\ncleanup');
  server.kill();
  await cleanup();
  await H.cleanup();

  console.log(bad === 0 ? '\nDone and staleness clean' : `\n${bad} FAILURE(S)`);
  process.exitCode = bad === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (server) server.kill();
  await cleanup();
  await H.cleanup();
  process.exitCode = 1;
});
