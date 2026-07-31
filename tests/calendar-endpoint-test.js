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

  await H.setProfile('a', {
    calendar_ics_url: `${FEED}/endpoint.ics`,
    calendar_action_ics_url: null,
  });

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
    titles.length === 2, titles.join(', '));
  check('both events came back', titles.join(', ') === 'A timed thing, An all-day thing',
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

  console.log('\nnothing is claimed, placed or stored');
  {
    check('no duration is invented for anything',
      (data.items || []).every((e) => e.duration_minutes === undefined));
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

  console.log('\na failed feed is named rather than swallowed');
  check('failures travel with the answer', Array.isArray(data.failed),
    JSON.stringify(data.failed));

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
    laterTitles.join(', ') === 'A timed thing, An all-day thing', laterTitles.join(', '));

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
