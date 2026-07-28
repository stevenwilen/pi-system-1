// Hits /calendar against the real ICS feed on a spare port.
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
const PORT = 3986;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Pointed at the throwaway user. The calendar comes from an ICS feed rather
// than from any row, so nothing here needs the real person, and a server
// started as them is a hazard sitting in a test whatever the test does.
const server = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    PI_USER_ID: '00000000-0000-0000-0000-00000000fee1',
    SCHEDULER_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

(async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  const bad400 = await fetch(BASE + '/calendar/not-a-date');
  check('rejects a malformed date', bad400.status === 400);

  const feed = await (await fetch(BASE + '/entries')).json();
  const d = new Date(`${feed.today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);

  const res = await fetch(`${BASE}/calendar/${tomorrow}`);
  const data = await res.json();
  check('200 for a valid date', res.status === 200);
  check('returns an events array', Array.isArray(data.events), `${(data.events || []).length} event(s) on ${tomorrow}`);

  const shaped = (data.events || []).every(
    (e) =>
      typeof e.title === 'string' &&
      Number.isInteger(e.start_minutes) &&
      e.start_minutes >= 0 && e.start_minutes < 1440 &&
      Number.isInteger(e.duration_minutes) &&
      e.duration_minutes >= 15 &&
      e.start_minutes + e.duration_minutes <= 1440
  );
  check('every event is wall-clock minutes, inside the day', shaped);
  check('sorted by start', (data.events || []).every((e, i, a) => i === 0 || a[i - 1].start_minutes <= e.start_minutes));

  for (const e of data.events || []) {
    const h = String(Math.floor(e.start_minutes / 60)).padStart(2, '0');
    const m = String(e.start_minutes % 60).padStart(2, '0');
    console.log(`      ${h}:${m} for ${e.duration_minutes}m  ${e.title}`);
  }

  // A week out, to prove the shape holds when the feed has something in it.
  const far = new Date(`${feed.today}T12:00:00Z`);
  far.setUTCDate(far.getUTCDate() + 7);
  const later = await (await fetch(`${BASE}/calendar/${far.toISOString().slice(0, 10)}`)).json();
  check('a different day also answers', Array.isArray(later.events), `${(later.events || []).length} event(s)`);

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
