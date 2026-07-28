// Due dates, end to end, and what the coldness job is told about them.
//
// Needs migration-due.sql to have been run. Everything writes as the test user.
const H = require('./harness');
const U = H.TEST_USER_ID;
const ROOT = H.ROOT;
process.chdir(ROOT);

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const coldness = require(ROOT + '/coldness.js');

const day = (n) => {
  const d = new Date('2026-07-27T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TODAY = day(0);

const PORT = 3974;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
};

(async () => {
  await H.assertGuarded();
  await H.ensureProfile();

  const { data: probe, error: probeErr } = await H.db.from('entries').select('id, due').limit(1);
  if (probeErr) {
    console.log(`\n  migration-due.sql has not been run: ${probeErr.message}`);
    process.exit(2);
  }

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  console.log('the column takes a date, and only where it is allowed');
  {
    const made = await post('/entries', { type: 'task', title: 'Passport', due: day(5) });
    check('a task takes a due date', made.status === 200 && made.body.entry.due === day(5), JSON.stringify(made.body).slice(0, 120));

    const proj = await post('/entries', { type: 'project', title: 'Thesis', why: 'The year', due: day(30) });
    check('a project takes one', proj.status === 200, JSON.stringify(proj.body).slice(0, 120));

    const habit = await post('/entries', { type: 'habit', title: 'Gym', frequency: 'daily', due: day(3) });
    check('a habit is refused one', habit.status === 400, `${habit.status} ${habit.body.error}`);
    check('and the message says why', /habit has a frequency/i.test(habit.body.error || ''), habit.body.error);

    const plain = await post('/entries', { type: 'habit', title: 'Reading', frequency: 'weekly' });
    check('a habit with no date is fine', plain.status === 200, JSON.stringify(plain.body).slice(0, 90));

    const noDate = await post('/entries', { type: 'task', title: 'Call bank' });
    check('a task with no date is fine', noDate.status === 200 && noDate.body.entry.due === null, `due=${noDate.body.entry.due}`);
  }

  console.log('\na bad date is refused rather than stored');
  for (const [value, why] of [
    ['tomorrow', 'free text'],
    ['2026-13-01', 'month 13'],
    ['2026-02-31', 'a day that does not exist'],
    ['26-07-05', 'a two digit year'],
  ]) {
    const r = await post('/entries', { type: 'task', title: `bad ${value}`, due: value });
    check(`refuses ${why}`, r.status === 400, `${r.status} ${r.body.error || ''}`);
  }

  console.log('\nthe list carries it back');
  {
    const list = await get('/entries');
    const byTitle = Object.fromEntries(list.body.items.map((i) => [i.title, i]));
    check('the task has its date', byTitle['Passport'].due === day(5), String(byTitle['Passport'].due));
    check('a dateless row reports null', byTitle['Call bank'].due === null, String(byTitle['Call bank'].due));
    check('a habit reports null', byTitle['Gym'] === undefined && byTitle['Reading'].due === null);
    check('it is a plain YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(byTitle['Passport'].due));
  }

  console.log('\nediting a date, and clearing it');
  {
    const list = await get('/entries');
    const task = list.body.items.find((i) => i.title === 'Passport');

    const moved = await post(`/entries/${task.id}/update`, { due: day(9) });
    check('the date can be changed', moved.status === 200 && moved.body.entry.due === day(9), String(moved.body.entry && moved.body.entry.due));

    const cleared = await post(`/entries/${task.id}/update`, { due: '' });
    check('an empty value clears it to null', cleared.status === 200 && cleared.body.entry.due === null, String(cleared.body.entry && cleared.body.entry.due));

    const untouched = await post(`/entries/${task.id}/update`, { title: 'Passport renewal' });
    check('leaving it out does not resurrect it', untouched.body.entry.due === null, String(untouched.body.entry.due));

    const back = await post(`/entries/${task.id}/update`, { due: day(2) });
    check('and it can be set again', back.body.entry.due === day(2), String(back.body.entry.due));

    const bad = await post(`/entries/${task.id}/update`, { due: 'soon' });
    check('a bad date on update is refused', bad.status === 400, `${bad.status} ${bad.body.error || ''}`);
    const after = await get('/entries');
    check('and the old value survives the refusal',
      after.body.items.find((i) => i.id === task.id).due === day(2));
  }

  console.log('\nreordering still works, and still only takes ids');
  {
    const list = await get('/entries');
    const priorities = list.body.items.filter((i) => i.type !== 'habit');
    const ids = priorities.map((i) => i.id).reverse();

    const r = await post('/entries/reorder', { ids });
    check('the priorities reorder', r.status === 200 && r.body.ordered === ids.length, JSON.stringify(r.body));

    const after = await get('/entries');
    const order = after.body.items.filter((i) => i.type !== 'habit').map((i) => i.id);
    check('the new order sticks', order.join(',') === ids.join(','), order.join(','));

    // Habits were not in the payload and must be untouched by it.
    const habits = after.body.items.filter((i) => i.type === 'habit');
    check('habits are still in the list', habits.length === 1, `${habits.length}`);
  }

  console.log('\nwhat the coldness job is told');
  {
    const items = await coldness.gather(U, TODAY);
    const text = coldness.render(items, TODAY);

    const passport = items.find((i) => i.title === 'Passport renewal');
    check('due is gathered', passport.due === day(2), String(passport.due));
    check('and the days are counted, not left to the model', passport.due_in === 2, String(passport.due_in));

    check('the briefing states the deadline', /due in 2 days/.test(text), text.split('\n').find((l) => /Passport/.test(l)));
    check('and whether anything is planned', /not on any plan yet/.test(text));
    check('a dateless row says nothing about a deadline',
      !/due/i.test(text.split('\n').find((l) => /Call bank/.test(l)) || ''),
      text.split('\n').find((l) => /Call bank/.test(l)));

    // The thing the user was explicit about.
    check('rank is not in the briefing', !/rank|position|sort_order|ranked/i.test(text));

    // Comments stripped first. The last version of this matched the comment in
    // gather() that explains sort_order is deliberately not read, which is a
    // check that fails precisely because the reasoning was written down.
    const code = require('fs')
      .readFileSync(ROOT + '/coldness.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check('coldness never selects sort_order', !/sort_order/.test(code));
    check('and orders by when things were added', /\.order\('created_at'\)/.test(code));
    check('the ranked order is not read from the row either',
      !/\.order\(/.test(code.split('function render')[0].replace(/\.order\('created_at'\)/g, '')));

    console.log('\n    ' + text.split('\n').filter((l) => /^\d+\./.test(l)).join('\n    '));
  }

  console.log('\noverdue, and already planned, read differently');
  {
    const { data: made } = await H.db
      .from('entries')
      .insert({ user_id: U, type: 'task', title: 'Visa', due: day(-4) })
      .select('id')
      .single();

    const items = await coldness.gather(U, TODAY);
    const visa = items.find((i) => i.title === 'Visa');
    check('an overdue item counts negative', visa.due_in === -4, String(visa.due_in));

    const text = coldness.render(items, TODAY);
    check('the briefing shouts it', /4 days OVERDUE/.test(text), text.split('\n').find((l) => /Visa/.test(l)));

    // On a plan for tomorrow: being dealt with, and the briefing must say so.
    const { data: plan } = await H.db
      .from('plans')
      .insert({ user_id: U, date: day(1), wake_time: '08:00:00', status: 'confirmed' })
      .select('id')
      .single();
    await H.db.from('blocks').insert({
      user_id: U, plan_id: plan.id, title: 'Visa', entry_id: made.id,
      start_time: '09:00:00', duration_minutes: 60, sort_order: 0,
    });

    const planned = await coldness.gather(U, TODAY);
    const v2 = planned.find((i) => i.title === 'Visa');
    check('a future plan counts as planned', v2.planned === true && v2.planned_for === day(1), `${v2.planned} ${v2.planned_for}`);
    check('the briefing says it is being dealt with', /already on the plan for/.test(coldness.render(planned, TODAY)));
  }

  console.log('\na paused row with a passed deadline is still never cold');
  {
    const { data: row } = await H.db
      .from('entries')
      .insert({
        user_id: U, type: 'task', title: 'Dentist',
        due: day(-30), paused_at: new Date().toISOString(), cold: false,
      })
      .select('id')
      .single();

    const items = await coldness.gather(U, TODAY);
    const it = items.find((i) => i.title === 'Dentist');
    check('it is gathered as paused', it.paused === true);
    check('and thirty days overdue', it.due_in === -30, String(it.due_in));

    // The code path, not the prompt: a yes for a paused item is forced to no.
    const verdicts = coldness.parseVerdicts(
      items.map((_, i) => `${i + 1}|yes|everything is cold`).join('\n'),
      items.length
    );
    check('a model saying yes is parsed', verdicts.get(items.indexOf(it) + 1).cold === true);

    const src = require('fs').readFileSync(ROOT + '/coldness.js', 'utf8');
    check('and overridden in code, not only in the prompt', /item\.paused \? false : verdict\.cold/.test(src));
    check('the prompt also states it for a passed date', /paused item with an overdue deadline is still paused/i.test(src));
    check('the prompt says a deadline outranks cadence', /deadline outranks cadence/i.test(src));
  }

  console.log('\ncleanup');
  server.kill();
  await H.cleanup();
  const { count } = await H.raw
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nDue dates clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (server) server.kill();
  await H.cleanup();
  process.exit(1);
});
