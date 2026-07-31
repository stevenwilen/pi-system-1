// Hits /calendar against the real ICS feeds on a spare port.
//
// The endpoint's job shrank: it used to sort events into pinned blocks, all-day
// notes and things to auto-place. It now returns one list of what is on the
// calendar, and the screen shows it. Nothing here is placed, pinned or stored.
const { spawn } = require('child_process');
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

(async () => {
  authed = H.as((await H.setup()).a);
  await H.ensureProfile();

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/version'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  const bad400 = await authed(BASE + '/calendar/not-a-date');
  check('rejects a malformed date', bad400.status === 400);

  const feed = await (await authed(BASE + '/entries')).json();
  const d = new Date(`${feed.today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);

  const res = await authed(`${BASE}/calendar/${tomorrow}`);
  const data = await res.json();
  check('200 for a valid date', res.status === 200);
  check('returns one list', Array.isArray(data.items),
    `${(data.items || []).length} item(s) on ${tomorrow}`);

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

  // A week out, to prove the shape holds when the feed has something in it.
  const far = new Date(`${feed.today}T12:00:00Z`);
  far.setUTCDate(far.getUTCDate() + 7);
  const later = await (await authed(`${BASE}/calendar/${far.toISOString().slice(0, 10)}`)).json();
  check('a different day also answers', Array.isArray(later.items), `${(later.items || []).length} item(s)`);

  console.log(bad === 0 ? '\nCalendar endpoint clean' : `\n${bad} FAILURE(S)`);
  // Exiting the instant the child is killed tears down a libuv handle that is
  // already closing, which aborts with a native assertion and a garbage exit
  // code, so a clean run reports failure. Set the code and let the loop drain.
  process.exitCode = bad === 0 ? 0 : 1;
  server.stdout.destroy();
  server.stderr.destroy();
  server.kill();
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
  server.stdout.destroy();
  server.stderr.destroy();
  server.kill();
});
