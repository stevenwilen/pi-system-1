// Due dates, sizes, and the warning marks they produce. End to end.
//
// Needs migration-due.sql and migration-size.sql to have been run. Everything
// writes as the test user.
const H = require('./harness');
const U = H.TEST_USER_ID;
const ROOT = H.ROOT;
process.chdir(ROOT);

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Relative to the real today, because the marks are arithmetic against the
// server's idea of now and a fixed date would drift out of every band.
const day = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

  const { error: probeErr } = await H.db.from('entries').select('id, due, size').limit(1);
  if (probeErr) {
    console.log(`\n  a migration has not been run: ${probeErr.message}`);
    process.exit(2);
  }

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  console.log('who may carry a date');
  {
    const task = await post('/entries', {
      type: 'task', title: 'Passport', due: day(5), size: 'a few days',
    });
    check('a task takes one', task.status === 200 && task.body.entry.due === day(5),
      JSON.stringify(task.body).slice(0, 120));

    // This is the change: a project used to be refused a deadline and given a
    // size instead. It now has both, and the two together are the mark.
    const proj = await post('/entries', {
      type: 'project', title: 'Thesis', due: day(30), size: 'a few weeks',
    });
    check('a project takes one too', proj.status === 200 && proj.body.entry.due === day(30),
      `${proj.status} ${proj.body.error || ''}`);

    const habit = await post('/entries', {
      type: 'habit', title: 'Gym', frequency: 'daily', due: day(3), size: 'a day',
    });
    check('a habit is refused one', habit.status === 400, `${habit.status} ${habit.body.error}`);
    check('and told what it has instead', /frequency/i.test(habit.body.error || ''), habit.body.error);

    const plain = await post('/entries', { type: 'habit', title: 'Reading', frequency: 'weekly' });
    check('a habit with no date is fine', plain.status === 200, JSON.stringify(plain.body).slice(0, 90));

    const noDate = await post('/entries', { type: 'task', title: 'Call bank' });
    check('a task with no date is fine',
      noDate.status === 200 && noDate.body.entry.due === null, `due=${noDate.body.entry.due}`);
  }

  console.log('\nthe date and the size travel together');
  {
    const noSize = await post('/entries', { type: 'task', title: 'Naked date', due: day(4) });
    check('a date with no size is refused', noSize.status === 400, `${noSize.status}`);
    check('and the message lists the buckets', /a few days/.test(noSize.body.error || ''), noSize.body.error);

    const badSize = await post('/entries', {
      type: 'task', title: 'Bad size', due: day(4), size: 'quite big',
    });
    check('an unrecognised size is refused', badSize.status === 400, badSize.body.error);

    const orphan = await post('/entries', { type: 'task', title: 'Naked size', size: 'a week' });
    check('a size with no date is refused too', orphan.status === 400, `${orphan.status}`);
    check('because it has nothing to measure against',
      /due date|deadline/i.test(orphan.body.error || ''), orphan.body.error);
  }

  console.log('\na bad date is refused rather than stored');
  for (const [value, why] of [
    ['tomorrow', 'free text'],
    ['2026-13-01', 'month 13'],
    ['2026-02-31', 'a day that does not exist'],
    ['26-07-05', 'a two digit year'],
  ]) {
    const r = await post('/entries', { type: 'task', title: `bad ${value}`, due: value, size: 'a day' });
    check(`refuses ${why}`, r.status === 400, `${r.status} ${r.body.error || ''}`);
  }

  console.log('\nthe list carries it back, with the mark already computed');
  {
    const list = await get('/entries');
    const byTitle = Object.fromEntries(list.body.items.map((i) => [i.title, i]));

    check('the task has its date', byTitle['Passport'].due === day(5), String(byTitle['Passport'].due));
    check('and its size', byTitle['Passport'].size === 'a few days', String(byTitle['Passport'].size));
    check('it is a plain YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(byTitle['Passport'].due));
    check('a dateless row reports null', byTitle['Call bank'].due === null, String(byTitle['Call bank'].due));
    check('and carries no mark', byTitle['Call bank'].mark === null, String(byTitle['Call bank'].mark));

    // 5 days out, 3 days of work: slack 2, which is the '!!' band.
    check('the mark is on the row, not left to the screen',
      byTitle['Passport'].mark === '!!', String(byTitle['Passport'].mark));
    // 30 days out, 15 days of work: slack 15, which is past every band.
    check('comfortable slack gets no mark',
      byTitle['Thesis'].mark === null, String(byTitle['Thesis'].mark));
    check('the days left are counted here too',
      byTitle['Passport'].days_until_due === 5, String(byTitle['Passport'].days_until_due));
  }

  console.log('\nevery band, against real rows');
  {
    // size 'a week' is 6 days of work, so slack = daysUntil - 6.
    const cases = [
      ['Band overdue', -2, '!!!'], //  -8 slack
      ['Band none left', 6, '!!!'], //   0 slack
      ['Band tight', 8, '!!'], //        2 slack
      ['Band watch', 12, '!'], //        6 slack
      ['Band fine', 30, null], //       24 slack
    ];

    for (const [title, offset] of cases) {
      await post('/entries', { type: 'task', title, due: day(offset), size: 'a week' });
    }

    const list = await get('/entries');
    const byTitle = Object.fromEntries(list.body.items.map((i) => [i.title, i]));

    for (const [title, offset, want] of cases) {
      check(
        `${title} (${offset > 0 ? '+' : ''}${offset} days) reads ${want || 'no mark'}`,
        byTitle[title].mark === want,
        `got ${JSON.stringify(byTitle[title].mark)}`
      );
    }
  }

  console.log('\nediting a date, and clearing it');
  {
    const list = await get('/entries');
    const task = list.body.items.find((i) => i.title === 'Passport');

    const moved = await post(`/entries/${task.id}/update`, { due: day(9) });
    check('the date can be changed', moved.status === 200 && moved.body.entry.due === day(9),
      String(moved.body.entry && moved.body.entry.due));

    const resized = await post(`/entries/${task.id}/update`, { size: 'a week' });
    check('the size can be changed', resized.body.entry.size === 'a week', String(resized.body.entry.size));

    const cleared = await post(`/entries/${task.id}/update`, { due: '' });
    check('an empty value clears the date', cleared.status === 200 && cleared.body.entry.due === null,
      String(cleared.body.entry && cleared.body.entry.due));
    check('and the size goes with it, so nothing is left orphaned',
      cleared.body.entry.size === null, String(cleared.body.entry.size));

    const untouched = await post(`/entries/${task.id}/update`, { title: 'Passport renewal' });
    check('leaving it out does not resurrect it', untouched.body.entry.due === null,
      String(untouched.body.entry.due));

    const back = await post(`/entries/${task.id}/update`, { due: day(2), size: 'a day' });
    check('and it can be set again', back.body.entry.due === day(2), String(back.body.entry.due));

    const nakedAgain = await post(`/entries/${task.id}/update`, { size: '' });
    check('clearing only the size is refused while a date stands',
      nakedAgain.status === 400, `${nakedAgain.status} ${nakedAgain.body.error || ''}`);

    const bad = await post(`/entries/${task.id}/update`, { due: 'soon' });
    check('a bad date on update is refused', bad.status === 400, `${bad.status} ${bad.body.error || ''}`);

    const after = await get('/entries');
    check('and the old value survives the refusal',
      after.body.items.find((i) => i.id === task.id).due === day(2));
  }

  console.log('\nthere is no reordering to do');
  {
    const list = await get('/entries');
    const ids = list.body.items.map((i) => i.id);

    // Read as a raw response rather than through post(): an unknown path falls
    // through to the static handler and comes back as the page, so asking for
    // JSON here throws on the HTML instead of reporting the 404.
    const r = await fetch(`${BASE}/entries/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    check('the endpoint is gone', r.status === 404, `${r.status}`);

    const after = await get('/entries');
    check('and the list still reads',
      after.status === 200 && after.body.items.length === ids.length, `${after.body.items.length}`);
    check('ordered longest left first',
      after.body.items.every((it, i, a) => i === 0 || a[i - 1].days >= it.days),
      after.body.items.map((i) => i.days).join(','));
  }

  console.log('\nthe endpoints that were removed really are gone');
  {
    for (const path of ['/plan-intent/setup-prompt', '/summarize']) {
      const r = await fetch(`${BASE}${path}`);
      check(`${path} is gone`, r.status === 404, `${r.status}`);
    }
    const list = await get('/entries');
    const id = list.body.items[0].id;
    const paused = await fetch(`${BASE}/entries/${id}/pause`, { method: 'POST' });
    check('/entries/:id/pause is gone', paused.status === 404, `${paused.status}`);
    check('and nothing reports a paused list', list.body.paused === undefined);
  }

  console.log('\ncleanup');
  server.kill();
  await H.cleanup();
  const { count } = await H.raw
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nDue dates and marks clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (server) server.kill();
  await H.cleanup();
  process.exit(1);
});
