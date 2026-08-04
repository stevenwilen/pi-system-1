// Hits /calendar on a spare port, against a feed this suite serves itself.
//
// The endpoint's job shrank: it used to sort events into pinned blocks, all-day
// notes and things to auto-place. It now returns one list of what is on the
// calendar, and the screen shows it. Nothing here is placed, pinned or stored.
//
// IT USED TO READ THE OWNER'S REAL FEEDS, out of CALENDAR_ICS_URL. That was
// its one distinctive value and it went when the urls moved onto the profile
// row — but the failure would have been silent rather than loud. The test
// account has no feeds, so the endpoint would answer with an empty list, and
// almost every assertion here is of the form "every item is well-shaped",
// which is true of no items at all. It would have gone on passing while
// checking nothing.
//
// So it serves its own feed with known events in it, and asserts they come
// back. A suite whose assertions are vacuously true of an empty list is worse
// than one that fails.
const { spawn } = require('child_process');
const http = require('http');
// The harness, for the account. The server has no user of its own any more:
// it serves whoever the request's token says, so a suite driving it has to be
// somebody. It reaches only the test account, which is the same guarantee the
// PI_USER_ID it used to be started with was there to give.
const H = require('./harness');
const ROOT = H.ROOT;
const PORT = 3986;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Spawned here rather than through the harness because this suite reads the
// server's output and does its own teardown.
const server = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    SCHEDULER_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Assigned once the account is signed in. The calendar comes from an ICS feed
// rather than from any row, so nothing here depends on whose account it is —
// but every request still has to be somebody's.
let authed = () => {
  throw new Error('the account is not signed in yet');
};

// 3979, not 3987: step1-verify.js already serves on that one. The suites run
// one at a time so a clash only bites when a server is slow to let go of its
// socket, which is exactly the kind of failure that looks like something else.
const FEED_PORT = 3979;
const FEED = `http://127.0.0.1:${FEED_PORT}`;

// Two events on whatever day the suite asks about, one timed and one all day,
// so both shapes are exercised and neither list is ever empty.
let feedBody = '';
const ics = (events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const bare = (date) => date.replace(/-/g, '');
const dayAfter = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
// Unique uids per day: an ICS file with the same uid twice is one event, and
// the second day would silently hold nothing.
const eventsOn = (date) => [
  ['BEGIN:VEVENT', `UID:endpoint-timed-${bare(date)}`, `DTSTART:${bare(date)}T150000Z`,
    `DTEND:${bare(date)}T160000Z`, 'SUMMARY:A timed thing', 'END:VEVENT'].join('\r\n'),
  ['BEGIN:VEVENT', `UID:endpoint-allday-${bare(date)}`, `DTSTART;VALUE=DATE:${bare(date)}`,
    `DTEND;VALUE=DATE:${bare(dayAfter(date))}`, 'SUMMARY:An all-day thing', 'END:VEVENT'].join('\r\n'),
  // OFF THE GRID, because the length is what a press turns into a block and
  // the day is built in half hours. Forty-five minutes is the ordinary meeting
  // this has to have an answer for.
  ['BEGIN:VEVENT', `UID:endpoint-odd-${bare(date)}`, `DTSTART:${bare(date)}T091000Z`,
    `DTEND:${bare(date)}T095500Z`, 'SUMMARY:An odd length', 'END:VEVENT'].join('\r\n'),
  // PAST MIDNIGHT AND THEN SOME. Anything overlapping the date comes back, so
  // the raw length of this is measured in days — and a block that long is not
  // a day gone wrong, it is a day that cannot be laid out at all.
  //
  // TEN PAST, not on the hour, and that is the whole reason for the odd minute.
  // What is left of the day from an odd start is not a multiple of anything, so
  // clipping to it without putting it on the grid first produces a length the
  // confirm refuses. On the hour both roads lead to the same number and the
  // rule is invisible.
  ['BEGIN:VEVENT', `UID:endpoint-long-${bare(date)}`, `DTSTART:${bare(date)}T201000Z`,
    `DTEND:${bare(dayAfter(dayAfter(date)))}T200000Z`,
    'SUMMARY:A thing that runs long', 'END:VEVENT'].join('\r\n'),
];

let feedServer;

(async () => {
  authed = H.as((await H.setup()).a);
  await H.ensureProfile();

  feedServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(feedBody);
  });
  await new Promise((r) => feedServer.listen(FEED_PORT, r));
  // Held open by keep-alive sockets from the server it feeds, so it is told not
  // to keep this process alive.
  feedServer.unref();

  await H.setProfile('a', { calendar_ics_url: `${FEED}/endpoint.ics` });

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/version'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  const bad400 = await authed(BASE + '/calendar/not-a-date');
  check('rejects a malformed date', bad400.status === 400);

  const feed = await (await authed(BASE + '/entries')).json();
  const d = new Date(`${feed.today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);

  const far = new Date(`${feed.today}T12:00:00Z`);
  far.setUTCDate(far.getUTCDate() + 7);
  const farDate = far.toISOString().slice(0, 10);

  // Both days in one file, fetched once. The feed is cached per user and url
  // for a minute, so a body swapped in later would never be seen.
  feedBody = ics([...eventsOn(tomorrow), ...eventsOn(farDate)]);

  const res = await authed(`${BASE}/calendar/${tomorrow}`);
  const data = await res.json();
  check('200 for a valid date', res.status === 200);
  check('returns one list', Array.isArray(data.items),
    `${(data.items || []).length} item(s) on ${tomorrow}`);

  // THE CHECK THAT KEEPS THE REST HONEST. Everything below is of the form
  // "every item is well-shaped", and every one of those is true of an empty
  // list. Without this the suite passes just as happily against an account
  // with no feed at all, which is exactly what it became when the urls moved
  // off the environment.
  const titles = (data.items || []).map((e) => e.title).sort();
  check('and the list is not empty, which every check below assumes',
    titles.length === 4, titles.join(', '));
  check('every event came back',
    titles.join(', ') === 'A thing that runs long, A timed thing, An all-day thing, An odd length',
    titles.join(', '));

  const shaped = (data.items || []).every(
    (e) =>
      typeof e.title === 'string' &&
      (e.start_minutes === null ||
        (Number.isInteger(e.start_minutes) && e.start_minutes >= 0 && e.start_minutes < 1440))
  );
  check('every item is a title and either a wall-clock minute or nothing', shaped);

  // Timed first in clock order, then the all-day entries. What is happening at
  // a particular hour is the more useful thing to read first.
  const timed = (data.items || []).filter((e) => e.start_minutes !== null);
  const untimed = (data.items || []).filter((e) => e.start_minutes === null);
  check('timed events are sorted',
    timed.every((e, i, a) => i === 0 || a[i - 1].start_minutes <= e.start_minutes));
  check('and all come before the all-day entries',
    (data.items || []).findIndex((e) => e.start_minutes === null) === -1 ||
      (data.items || []).findIndex((e) => e.start_minutes === null) === timed.length,
    `${timed.length} timed, ${untimed.length} all-day`);

  for (const e of data.items || []) {
    const when =
      e.start_minutes === null
        ? '  all day'
        : `${String(Math.floor(e.start_minutes / 60)).padStart(2, '0')}:${String(e.start_minutes % 60).padStart(2, '0')}     `;
    console.log(`      ${when}  ${e.title}`);
  }

  console.log('\nhow long each one runs, for the press that makes it a block');
  {
    // READ, NOT INVENTED, which is the distinction the group below is about.
    // This is what the calendar says the event's length is — the one thing
    // about it this day model can hold exactly, since an hour is an hour
    // wherever the block ends up sitting. The start is not: blocks stack from
    // the wake time, so the hour is shown and never used.
    const by = (t) => (data.items || []).find((e) => e.title === t) || {};

    check('an hour is an hour', by('A timed thing').duration_minutes === 60,
      `${by('A timed thing').duration_minutes}`);

    // UP, NEVER DOWN. A block that under-states its own length makes every
    // time below it wrong in the optimistic direction, which is the direction
    // that has you arriving late.
    check('forty-five minutes rounds up to the hour',
      by('An odd length').duration_minutes === 60, `${by('An odd length').duration_minutes}`);

    // An all-day entry claims no hour, so it has no length that means anything
    // as a block. The screen starts it at one step like anything else.
    check('an all-day entry has no length at all',
      by('An all-day thing').duration_minutes === null,
      `${by('An all-day thing').duration_minutes}`);

    // Clipped, and the property rather than the number: where the clip lands
    // depends on the account's timezone, and an expectation written as minutes
    // would be a test that passes in one zone and fails in another.
    const long = by('A thing that runs long');
    check('one running past midnight is clipped to what is left of the day',
      long.duration_minutes === Math.floor((1440 - long.start_minutes) / 30) * 30,
      `${long.start_minutes} + ${long.duration_minutes}`);
    check('so it cannot run off the end of the day',
      long.start_minutes + long.duration_minutes <= 1440,
      `${long.start_minutes + long.duration_minutes}`);

    // Every one of them, on the grid the confirm insists on. A length off the
    // step is refused by POST /plan, so an event that produced one would be a
    // row that cannot be pressed without breaking the day it lands in.
    const timedItems = (data.items || []).filter((e) => e.start_minutes !== null);
    check('every length is a multiple of thirty minutes',
      timedItems.every((e) => e.duration_minutes % 30 === 0),
      timedItems.map((e) => e.duration_minutes).join(', '));
    check('and none is shorter than one step',
      timedItems.every((e) => e.duration_minutes >= 30));
  }

  console.log('\nnothing is claimed, placed or stored');
  {
    check('nothing is reported as pinned',
      (data.items || []).every((e) => e.pinned === undefined));
    check('and nothing is offered for placement', data.to_place === undefined);

    // The endpoint that used to claim events for a date. It had a side effect,
    // which is why it was a POST, and there is nothing left for it to do.
    const place = await authed(`${BASE}/calendar/${tomorrow}/place`, { method: 'POST' });
    check('the placement endpoint is gone', place.status === 404, `${place.status}`);

    // Reading twice must give the same answer. It always should have, and the
    // placement route was the one thing that made a read not repeatable.
    const again = await (await authed(`${BASE}/calendar/${tomorrow}`)).json();
    check('reading it twice gives the same answer',
      JSON.stringify(again.items) === JSON.stringify(data.items));
  }

  console.log('\na failure travels with the answer rather than being swallowed');
  // A plain fact now, not a list of named feeds: there is one calendar, and
  // the only question is whether this list can be trusted.
  check('it says whether the feed could be read', data.failed === false,
    JSON.stringify(data.failed));
  check('and whether there is a calendar at all', data.configured === true,
    JSON.stringify(data.configured));

  // A week out, to prove the shape holds on a second day.
  //
  // The feed already carries this day — it was built with both in it, up at
  // the top, rather than swapped in here. Swapping would have proved nothing:
  // the feed is cached per user and url for a minute, so the request below
  // would have been answered from the copy fetched for tomorrow, found no
  // events on this date, and returned an empty list that
  // `Array.isArray(later.items)` is perfectly happy with.
  const later = await (await authed(`${BASE}/calendar/${farDate}`)).json();
  const laterTitles = (later.items || []).map((e) => e.title).sort();
  check('a different day also answers', Array.isArray(later.items),
    `${(later.items || []).length} item(s)`);
  check('with that day\'s events, not the first day\'s',
    laterTitles.join(', ') ===
      'A thing that runs long, A timed thing, An all-day thing, An odd length',
    laterTitles.join(', '));

  console.log(bad === 0 ? '\nCalendar endpoint clean' : `\n${bad} FAILURE(S)`);
  // Exiting the instant the child is killed tears down a libuv handle that is
  // already closing, which aborts with a native assertion and a garbage exit
  // code, so a clean run reports failure. Set the code and let the loop drain.
  process.exitCode = bad === 0 ? 0 : 1;
  server.stdout.destroy();
  server.stderr.destroy();
  server.kill();
  if (feedServer) { feedServer.closeAllConnections(); feedServer.close(); }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
  server.stdout.destroy();
  server.stderr.destroy();
  server.kill();
  if (feedServer) { feedServer.closeAllConnections(); feedServer.close(); }
});
