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

  console.log('\nsaved for later leaves the list without leaving the data');
  {
    // SET DOWN ON PURPOSE, which is the whole difference from Delete. The row
    // keeps everything it has and stops competing for attention — and the risk
    // of that is that leaving the list is indistinguishable from being
    // forgotten, which is what the Wednesday message exists to answer.
    const at = (list, title) => list.findIndex((i) => i.title === title);

    const made = [];
    const res = await post('/entries', {
      type: 'project', title: 'zz set me down', due: day(20), size: 'a week',
    });
    const id = res.body.entry.id;
    made.push(id);

    const before = (await get('/entries')).body;
    check('it starts in the list', at(before.items, 'zz set me down') !== -1,
      String(before.items.length));
    check('and nothing is saved yet',
      !(before.saved || []).some((i) => i.title === 'zz set me down'),
      JSON.stringify((before.saved || []).map((i) => i.title)));
    check('the list says it is not set down',
      before.items[at(before.items, 'zz set me down')].later === false);

    const put = await post(`/entries/${id}/later`, { later: true });
    check('setting it down is accepted', put.status === 200, JSON.stringify(put.body));
    check('and it says so', put.body.later === true, JSON.stringify(put.body));

    const after = (await get('/entries')).body;
    check('IT LEAVES THE LIST', at(after.items, 'zz set me down') === -1,
      JSON.stringify(after.items.map((i) => i.title)));
    check('and turns up under saved', at(after.saved, 'zz set me down') !== -1,
      JSON.stringify(after.saved.map((i) => i.title)));

    // NOT DELETED, and that is the point of the column rather than a tombstone:
    // everything the row carried is still on it.
    const kept = after.saved[at(after.saved, 'zz set me down')];
    check('it keeps its deadline', kept.due === day(20), String(kept.due));
    check('and its length', kept.size === 'a week', String(kept.size));
    check('and whatever mark it had',
      kept.mark === before.items[at(before.items, 'zz set me down')].mark,
      `${kept.mark} was ${before.items[at(before.items, 'zz set me down')].mark}`);

    const back = await post(`/entries/${id}/later`, { later: false });
    check('picking it back up is accepted', back.status === 200 && back.body.later === false,
      JSON.stringify(back.body));

    const now = (await get('/entries')).body;
    check('and it returns to the list', at(now.items, 'zz set me down') !== -1,
      JSON.stringify(now.items.map((i) => i.title)));
    check('with nothing left under saved',
      !now.saved.some((i) => i.title === 'zz set me down'),
      JSON.stringify(now.saved.map((i) => i.title)));

    const junk = await post(`/entries/${id}/later`, { later: 'yes' });
    check('later must be true or false', junk.status === 400, JSON.stringify(junk.body));

    for (const x of made) await H.db.from('entries').delete().eq('user_id', U).eq('id', x);
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

  // --- habits are marked against their own rhythm --------------------------
  //
  // END TO END, because the arithmetic passing in isolation says nothing about
  // whether the route hands it what it needs. `warning.js` wants a frequency
  // and a count of days; the route has a frequency column and a date it works
  // that count out from, and the wiring between them is the thing that breaks.

  console.log('\na habit is marked by how far it has drifted past its cadence');
  {
    // AGED ON PURPOSE. A habit created a moment ago is nought days old and says
    // nothing, correctly — so a case built on a fresh row would pass against a
    // null mark and prove only that nothing happened. Backdating `created_at`
    // is what the route measures from when a habit has never been scheduled.
    const age = async (title, frequency, days) => {
      const made = await post('/entries', { type: 'habit', title, frequency });
      if (made.status !== 200) return { error: `${made.status} ${made.body.error || ''}` };
      const when = new Date(Date.now() - days * 86400000).toISOString();
      const { error } = await H.service
        .from('entries').update({ created_at: when }).eq('id', made.body.entry.id);
      return error ? { error: error.message } : { id: made.body.entry.id };
    };

    const fresh = await age('Stretch today', 'daily', 0);
    const oneOver = await age('Stretch one over', 'daily', 1);
    const twoOver = await age('Stretch two over', 'daily', 2);
    const longGone = await age('Stretch long gone', 'daily', 9);
    const weekly = await age('Weekly six days on', 'weekly', 6);
    const weeklyGone = await age('Weekly three weeks', 'weekly', 21);

    for (const [what, made] of Object.entries({ fresh, oneOver, twoOver, longGone, weekly, weeklyGone })) {
      if (made.error) check(`${what} was created`, false, made.error);
    }

    const list = await get('/entries');
    const markOf = (id) => {
      const row = (list.body.items || []).find((i) => i.id === id);
      return row ? row.mark : 'not on the list';
    };

    check('a daily habit done today says nothing', markOf(fresh.id) === null, String(markOf(fresh.id)));
    check('one day past its rhythm says !', markOf(oneOver.id) === '!', String(markOf(oneOver.id)));
    check('two days past says !!', markOf(twoOver.id) === '!!', String(markOf(twoOver.id)));
    check('and well gone says !!!', markOf(longGone.id) === '!!!', String(markOf(longGone.id)));

    // THE SAME NUMBER OF DAYS, A DIFFERENT ANSWER, which is the whole point of
    // judging each against its own rhythm rather than against the calendar.
    check('six days is nothing to a weekly habit', markOf(weekly.id) === null,
      String(markOf(weekly.id)));
    check('while six days is !!! to a daily one', markOf(longGone.id) === '!!!');
    check('and three weeks is !!! to the weekly one', markOf(weeklyGone.id) === '!!!',
      String(markOf(weeklyGone.id)));

    // AND IT JOINS THE MARKED HALF OF THE LIST. Habits used to be unmarkable by
    // construction, so the marked half was the dated half; it is not any more.
    const marked = (list.body.items || []).filter((i) => i.mark);
    const firstUnmarked = (list.body.items || []).findIndex((i) => !i.mark);
    const lastMarked = (list.body.items || []).map((i) => Boolean(i.mark)).lastIndexOf(true);
    check('the marked habits are on the list at all',
      marked.some((i) => i.type === 'habit'), `${marked.length} marked`);
    check('and everything marked still sits above everything unmarked',
      firstUnmarked === -1 || lastMarked < firstUnmarked, `${lastMarked} then ${firstUnmarked}`);
  }

  console.log('\nonly a task can be a one off');
  {
    // TASKS ONLY, and refused rather than ignored. A project is not finished by
    // one sitting — that is the difference between a project and a task — and a
    // habit recurs, which is the opposite of happening once. Accepting the flag
    // and quietly dropping it would leave someone believing a project would
    // take itself off the list.
    const task = await post('/entries', { type: 'task', title: 'Pay Albie', one_off: true });
    check('a task takes the flag', task.status === 200, JSON.stringify(task.body).slice(0, 120));

    const proj = await post('/entries', { type: 'project', title: 'Thesis two', one_off: true });
    check('a project is refused', proj.status === 400, `${proj.status} ${proj.body.error || ''}`);
    check('and told why', /not finished in one sitting/.test(proj.body.error || ''),
      String(proj.body.error));

    const hab = await post('/entries', {
      type: 'habit', title: 'Stretching two', frequency: 'weekly', one_off: true,
    });
    check('a habit is refused too', hab.status === 400, `${hab.status} ${hab.body.error || ''}`);

    // AND A HABIT'S CADENCE IS NOT A ONE-OFF FLAG. They share a column, so this
    // is the check that the two cannot be confused for each other.
    const weekly = await post('/entries', {
      type: 'habit', title: 'Stretching three', frequency: 'weekly',
    });
    check('an ordinary habit is created', weekly.status === 200,
      JSON.stringify(weekly.body).slice(0, 120));

    const list = await get('/entries');
    const row = (id) => (list.body.items || []).find((i) => i.id === id);
    check('the task reports the flag', row(task.body.entry.id).one_off === true,
      JSON.stringify(row(task.body.entry.id).one_off));
    check('and the weekly habit does not', row(weekly.body.entry.id).one_off === false,
      JSON.stringify(row(weekly.body.entry.id).one_off));
    check('while keeping its cadence', row(weekly.body.entry.id).frequency === 'weekly',
      String(row(weekly.body.entry.id).frequency));

    // TURNING IT OFF CLEARS IT, which is why the column is written on every
    // save rather than only when the flag is set.
    const off = await post(`/entries/${task.body.entry.id}/update`, { one_off: false });
    check('the flag can be turned off', off.status === 200, JSON.stringify(off.body).slice(0, 120));
    const after = await get('/entries');
    check('and it is really off',
      (after.body.items || []).find((i) => i.id === task.body.entry.id).one_off === false);

    // A ONE-OFF TASK KEEPS ITS DEADLINE MARK. The flag lives in a column the
    // cadence arithmetic also reads, so this is the end-to-end half of the
    // regression the unit tests pin.
    const dated = await post('/entries', {
      type: 'task', title: 'Renew the passport', due: day(0), size: 'a day', one_off: true,
    });
    check('a dated one off is created', dated.status === 200,
      JSON.stringify(dated.body).slice(0, 120));
    const marked = await get('/entries');
    const it = (marked.body.items || []).find((i) => i.id === dated.body.entry.id);
    check('and it still carries its deadline mark', it && it.mark === '!!!',
      it ? String(it.mark) : 'not on the list');
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
