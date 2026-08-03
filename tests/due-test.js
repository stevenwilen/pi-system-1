// Due dates, sizes, and the warning marks they produce. End to end.
//
// Needs migration-due.sql and migration-size.sql to have been run. Everything
// writes as the test user.
const H = require('./harness');
// The test account, discovered rather than written down. It is a real auth
// user now, created by the harness, so its id is not knowable until it
// exists — which is why this is assigned inside the run rather than at the
// top of the file.
let U;

// Every request this suite makes, as the test account.
//
// The server takes its user from the token and refuses a request without
// one, so a bare fetch here would not read as a broken test — it would read
// as an account with nothing in it.
let authed = () => {
  throw new Error('the account is not signed in yet');
};
const ROOT = H.ROOT;
process.chdir(ROOT);

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// The server's idea of today, read from it rather than assumed.
//
// This used to count from the UTC date. The server counts from the profile
// timezone — America/New_York for the test user — and for the hours where
// those two disagree every offset here was out by one, so a deadline built as
// "six days out" arrived as seven and landed in the wrong band. The suite
// failed in the evening and passed in the morning.
let TODAY = null;

const day = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * The list's order, as much of it as the payload can show.
 *
 * Two halves: everything carrying a mark, then everything without. The marked
 * half is ordered by days of room left, ascending — and `slack` is not sent,
 * so what is checked here is the consequence of that. Ascending slack means
 * non-increasing severity, because the marks are slack's own thresholds.
 *
 * The unmarked half is the old rule, longest untouched first.
 */
const SEVERITY = { '!!!': 3, '!!': 2, '!': 1 };

function wellOrdered(items) {
  // THREE HALVES NOW, and the pinned one is declared rather than computed.
  // Everything pinned sits above everything else, including a deadline that
  // has run out — and INSIDE each half the old two-part rule still holds, so
  // this is the same invariant applied twice rather than a new one.
  const firstLoose = items.findIndex((i) => !i.pinned);
  if (firstLoose !== -1 && items.slice(firstLoose).some((i) => i.pinned)) return false;

  return [items.filter((i) => i.pinned), items.filter((i) => !i.pinned)]
    .every(halfIsOrdered);
}

function halfIsOrdered(items) {
  const marked = items.filter((i) => i.mark);
  const cold = items.filter((i) => !i.mark);

  // No unmarked row may appear above a marked one.
  const firstCold = items.findIndex((i) => !i.mark);
  if (firstCold !== -1 && items.slice(firstCold).some((i) => i.mark)) return false;

  const nonIncreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] >= x);
  return (
    nonIncreasing(marked.map((i) => SEVERITY[i.mark])) &&
    nonIncreasing(cold.map((i) => i.days))
  );
}

const describe = (items) =>
  items.map((i) => `${i.pinned ? 'PIN ' : ''}${i.mark || '-'}/${i.days}d`).join(' ');

const PORT = 3974;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

const post = async (path, body) => {
  const r = await authed(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (path) => {
  const r = await authed(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
};

(async () => {
  U = await H.userId();
  authed = H.as((await H.setup()).a);
  await H.assertGuarded();
  await H.ensureProfile();

  const { error: probeErr } = await H.db.from('entries').select('id, due, size').limit(1);
  if (probeErr) {
    console.log(`\n  a migration has not been run: ${probeErr.message}`);
    process.exit(2);
  }

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  const opening = await get('/entries');
  TODAY = opening.body.today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(TODAY))) {
    throw new Error(`the server did not report a date: ${JSON.stringify(opening.body).slice(0, 120)}`);
  }
  console.log(`  the server's today is ${TODAY} (${opening.body.timezone})\n`);

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
    const r = await authed(`${BASE}/entries/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    check('the endpoint is gone', r.status === 404, `${r.status}`);

    const after = await get('/entries');
    check('and the list still reads',
      after.status === 200 && after.body.items.length === ids.length, `${after.body.items.length}`);
    check('still in the two-part order',
      wellOrdered(after.body.items), describe(after.body.items));
  }

  console.log('\na deadline outranks a cold thing');
  {
    // RELATIVE POSITIONS, and nothing cleared first. Emptying the notebook to
    // make the assertions easy is how a case takes the rows a later one was
    // relying on: this deleted everything and the section after it threw on a
    // row that no longer existed.
    const mine = [];
    const at = (list, title) => list.findIndex((i) => i.title === title);

    // Added just now, so its staleness is zero and only the deadline can lift
    // it. The other is the opposite: forty days cold, no deadline at all.
    const fresh = await post('/entries', {
      type: 'task', title: 'zz due on Friday', due: day(2), size: 'a day',
    });
    mine.push(fresh.body.entry.id);

    const { data: old } = await H.db
      .from('entries')
      .insert({
        user_id: U, type: 'task', title: 'zz cold and undated',
        created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
      })
      .select().single();
    mine.push(old.id);

    const list = (await get('/entries')).body.items;
    const urgent = at(list, 'zz due on Friday');
    const cold = at(list, 'zz cold and undated');

    check('both are in the list', urgent !== -1 && cold !== -1, describe(list));
    check('the fresh urgent thing outranks the cold one', urgent < cold,
      `${urgent} vs ${cold}`);
    check('even though it is the colder of the two by far',
      list[cold].days > list[urgent].days,
      `${list[cold].days}d vs ${list[urgent].days}d`);

    // AND SLACK ORDERS WITHIN THE MARKS, not the mark itself. Both of these
    // are '!!!' — one out of room today, the other for a month — and a sort on
    // the mark alone would leave them in whatever order they arrived in.
    const worse = await post('/entries', {
      type: 'task', title: 'zz overdue by a month', due: day(-30), size: 'a day',
    });
    mine.push(worse.body.entry.id);

    const both = (await get('/entries')).body.items;
    check('the worse of two !!! comes first',
      at(both, 'zz overdue by a month') < at(both, 'zz due on Friday'),
      describe(both));
    check('and the whole list is still well ordered', wellOrdered(both), describe(both));

    for (const id of mine) await H.db.from('entries').delete().eq('user_id', U).eq('id', id);
  }

  console.log('\na pin outranks the arithmetic, which is the point of it');
  {
    // THE ONE THING ON THIS LIST A PERSON ORDERS BY HAND. Everything else is
    // subtraction on what they declared — and so, in the end, is this: the
    // arithmetic GUESSES at what needs attention, and a pin is saying it.
    //
    // It is not the ranking that was retired, though it revives that column.
    // What was refused was a SCORE blending "days since" with "days of room",
    // which cannot be read off a screen. A pin blends nothing.
    const at = (list, title) => list.findIndex((i) => i.title === title);

    const made = [];
    const coldRes = await post('/entries', { type: 'habit', title: 'zz pin me', frequency: 'daily' });
    const cold = coldRes.body.entry.id;
    made.push(cold);
    const urgentRes = await post('/entries', {
      type: 'task', title: 'zz runs out today', due: TODAY, size: 'a week',
    });
    made.push(urgentRes.body.entry.id);

    const before = (await get('/entries')).body.items;
    check('the urgent one starts above the cold one',
      at(before, 'zz runs out today') < at(before, 'zz pin me'), describe(before));
    check('and nothing is pinned yet',
      before.every((i) => i.pinned === false), describe(before));

    const pinned = await post(`/entries/${cold}/pin`, { pinned: true });
    check('pinning is accepted', pinned.status === 200, JSON.stringify(pinned.body));
    check('and it says so', pinned.body.pinned === true, JSON.stringify(pinned.body));

    const after = (await get('/entries')).body.items;
    check('THE PIN NOW OUTRANKS THE DEADLINE',
      at(after, 'zz pin me') < at(after, 'zz runs out today'), describe(after));
    check('it is first in the whole list', at(after, 'zz pin me') === 0, describe(after));
    check('the list still says which row is pinned',
      after.find((i) => i.title === 'zz pin me').pinned === true, describe(after));
    check('and the order is still well formed inside each half',
      wellOrdered(after), describe(after));

    // The mark is untouched. A pin says where a row sits, not whether it is
    // running out of room, and those are two different questions.
    check('the urgent one keeps its mark',
      after.find((i) => i.title === 'zz runs out today').mark === '!!!',
      describe(after));

    const off = await post(`/entries/${cold}/pin`, { pinned: false });
    check('unpinning is accepted', off.status === 200 && off.body.pinned === false,
      JSON.stringify(off.body));

    const back = (await get('/entries')).body.items;
    check('and it falls back to where the arithmetic puts it',
      at(back, 'zz runs out today') < at(back, 'zz pin me'), describe(back));

    const junk = await post(`/entries/${cold}/pin`, { pinned: 'yes' });
    check('pinned must be true or false', junk.status === 400, JSON.stringify(junk.body));

    const missing = await post('/entries/00000000-0000-0000-0000-000000000000/pin', { pinned: true });
    check('and a row that is not yours cannot be pinned', missing.status === 400,
      JSON.stringify(missing.body));

    for (const id of made) await H.db.from('entries').delete().eq('user_id', U).eq('id', id);
  }

  console.log('\nthe endpoints that were removed really are gone');
  {
    for (const path of ['/plan-intent/setup-prompt', '/summarize']) {
      const r = await authed(`${BASE}${path}`);
      check(`${path} is gone`, r.status === 404, `${r.status}`);
    }
    const list = await get('/entries');
    const id = list.body.items[0].id;
    const paused = await authed(`${BASE}/entries/${id}/pause`, { method: 'POST' });
    check('/entries/:id/pause is gone', paused.status === 404, `${paused.status}`);
    check('and nothing reports a paused list', list.body.paused === undefined);
  }

  console.log('\ncleanup');
  server.kill();
  await H.cleanup();
  const { count } = await H.service
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
