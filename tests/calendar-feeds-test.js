// Both calendar feeds, read into one list.
//
// The feeds used to mean different things: one was things to know, the other
// things to do, and the second fed all-day events into the day as blocks. That
// distinction is gone. Both are now read the same way and shown the same way,
// and nothing on either is placed, pinned, claimed or stored.
//
// Both feeds are served from a local ICS server, so the assertions are about
// this code rather than about what happens to be in anyone's real calendar.
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
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Well clear of each other and of every other suite: PORT + 1 previously
// landed on the feed server itself, so a request for a day came back as raw
// ICS and the failure read as bad JSON.
const PORT = 3990;
const FEED_PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const FEED = `http://127.0.0.1:${FEED_PORT}`;

let server;
let feedServer;

// What each feed returns next. Swapped between cases.
let awareness = '';
let action = '';

const DATE = '2031-03-14';

const ics = (events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');

// The end is the day after the start, computed rather than fixed. It was
// hardcoded to one date, so an all-day event on any other day ended before it
// began — and an event that matches nothing looks exactly like a feature that
// does not work.
const dayAfter = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const allDay = (uid, summary, date) =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
    `DTEND;VALUE=DATE:${dayAfter(date).replace(/-/g, '')}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ].join('\r\n');

const timed = (uid, summary, date, from, to) =>
  [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${date.replace(/-/g, '')}T${from}00Z`,
    `DTEND:${date.replace(/-/g, '')}T${to}00Z`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ].join('\r\n');

const get = async (p) => {
  const r = await authed(BASE + p);
  return { status: r.status, body: await r.json() };
};

const clearClaims = async () => {
  await H.db.from('sent_log').delete().eq('user_id', U);
};

(async () => {
  U = await H.userId();
  authed = H.as((await H.setup()).a);
  await H.assertGuarded();
  await H.ensureProfile();
  await clearClaims();

  feedServer = http.createServer((req, res) => {
    // A url that always fails, so the broken-feed case can have a cold cache
    // without waiting out the sixty second TTL.
    if (req.url.includes('broken')) {
      res.writeHead(500);
      return res.end('nope');
    }
    const wantsAction = req.url.includes('action');
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(wantsAction ? action : awareness);
  });
  await new Promise((r) => feedServer.listen(FEED_PORT, r));
  // Held open by keep-alive sockets from the servers it feeds, so it is told
  // not to keep this process alive. Without it the checks all pass and the run
  // never ends, which reads as a hang rather than a result.
  feedServer.unref();

  server = H.spawnServer(PORT, {
    CALENDAR_ICS_URL: `${FEED}/dates.ics`,
    CALENDAR_ACTION_ICS_URL: `${FEED}/action.ics`,
  });
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  // The feeds are cached for a minute inside tools.js, so each case uses its
  // own dates rather than trying to change what one date returns.
  awareness = ics([
    allDay('know-1', 'Mums birthday', DATE),
    timed('know-2', 'Dentist', DATE, '1400', '1500'),
  ]);
  action = ics([
    allDay('do-1', 'Cancel Paramount', DATE),
    timed('do-3', 'Standup', DATE, '0900', '0915'),
  ]);

  console.log('both feeds read into one list');
  {
    const r = await get(`/calendar/${DATE}`);
    check('the day reads', r.status === 200, JSON.stringify(r.body).slice(0, 100));

    const titles = r.body.items.map((e) => e.title);
    check('everything on both feeds is there', titles.length === 4, titles.join(', '));
    check('from the awareness feed', titles.includes('Mums birthday') && titles.includes('Dentist'));
    check('and from the action feed', titles.includes('Cancel Paramount') && titles.includes('Standup'));

    // Which feed a thing is on no longer decides anything about it.
    check('nothing says which feed anything came from',
      r.body.items.every((e) => e.source === undefined));

    const byTitle = Object.fromEntries(r.body.items.map((e) => [e.title, e]));

    // The feed gives instants and the screen wants wall-clock minutes where
    // the person lives. 09:00Z on 14 March 2031 is 05:00 in New York, which is
    // the test profile's timezone. Computed rather than written down, so a
    // daylight saving change does not turn this into a puzzle.
    const expected = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      })
        .formatToParts(new Date(`${DATE}T09:00:00Z`))
        .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {}).hour
    ) * 60;

    check('a timed event is converted to the local wall clock',
      byTitle['Standup'].start_minutes === expected,
      `${byTitle['Standup'].start_minutes}, expected ${expected}`);
    check('an all-day entry carries none', byTitle['Cancel Paramount'].start_minutes === null,
      String(byTitle['Cancel Paramount'].start_minutes));
    check('an all-day entry on either feed reads the same',
      byTitle['Mums birthday'].start_minutes === null &&
        byTitle['Cancel Paramount'].start_minutes === null);

    check('timed first, in order, then all-day',
      titles.slice(0, 2).join(',') === 'Standup,Dentist', titles.join(','));

    check('nothing is reported as failed', r.body.failed.length === 0, JSON.stringify(r.body.failed));
  }

  console.log('\nreading a day claims nothing');
  {
    // This is the change that matters. Reading used to be repeatable and
    // placing was a separate POST that was not; there is no placing now, so a
    // read is just a read and it can happen as often as the screen likes.
    const first = await get(`/calendar/${DATE}`);
    const second = await get(`/calendar/${DATE}`);
    const third = await get(`/calendar/${DATE}`);

    check('three reads give three identical answers',
      JSON.stringify(first.body.items) === JSON.stringify(second.body.items) &&
        JSON.stringify(second.body.items) === JSON.stringify(third.body.items));

    const { data: claims } = await H.db
      .from('sent_log').select('job').eq('user_id', U);
    check('and nothing was written to claim any of it', claims.length === 0,
      JSON.stringify(claims.map((c) => c.job)));

    const place = await authed(`${BASE}/calendar/${DATE}/place`, { method: 'POST' });
    check('the placement endpoint is gone', place.status === 404, `${place.status}`);
  }

  console.log('\na broken feed does not look like a quiet day');
  {
    // Its own server pointed at its own URL, because the feed cache is keyed by
    // url and holds for a minute: the working feed above is still cached, so
    // breaking it in place would change nothing for the next sixty seconds.
    // That caching is right, and it is why this needs a cold url rather than a
    // wait.
    const broken = H.spawnServer(PORT + 2, {
      CALENDAR_ICS_URL: `${FEED}/broken.ics`,
      CALENDAR_ACTION_ICS_URL: `${FEED}/action.ics`,
    });
    const brokenBase = `http://127.0.0.1:${PORT + 2}`;
    if (!(await H.waitFor(brokenBase))) throw new Error('broken-feed server never came up');

    action = ics([allDay('do-5', 'Still here', '2031-03-20')]);

    const r = await (await authed(`${brokenBase}/calendar/2031-03-20`)).json();
    check('the request still succeeds', Array.isArray(r.items));
    check('and the dead feed is named', r.failed.length === 1, JSON.stringify(r.failed));
    check('by a name a person would recognise',
      r.failed.length === 1 && r.failed[0].label === 'Dates', JSON.stringify(r.failed));
    check('the working feed is not blamed',
      !r.failed.some((f) => f.source === 'action'), JSON.stringify(r.failed));
    check('and it still returns what it could read',
      r.items.map((t) => t.title).join(',') === 'Still here', JSON.stringify(r.items));

    broken.kill();
  }

  console.log('\nwith no action feed, nothing changes');
  {
    const solo = H.spawnServer(PORT + 1, { CALENDAR_ICS_URL: `${FEED}/dates.ics` });
    const soloBase = `http://127.0.0.1:${PORT + 1}`;
    if (!(await H.waitFor(soloBase))) throw new Error('solo server never came up');

    awareness = ics([allDay('know-9', 'Anniversary', '2031-04-01')]);
    const r = await (await authed(`${soloBase}/calendar/2031-04-01`)).json();

    check('the one feed still reads', r.items.map((a) => a.title).join(',') === 'Anniversary',
      JSON.stringify(r.items));
    check('and nothing is reported broken', r.failed.length === 0, JSON.stringify(r.failed));

    solo.kill();
  }

  console.log('\nthe page shows the failure rather than an empty day');
  {
    const fs = require('fs');
    const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
    check('it says which feed it could not read', /could not be read/.test(html));
    check('in the miss colour', /\.cal \.failed \{[^}]*var\(--warn\)/.test(html));
    check('and an empty calendar says so plainly', /Nothing on it/.test(html));
  }

  console.log('\ncleanup');
  server.kill();
  feedServer.closeAllConnections();
  feedServer.close();
  await clearClaims();
  await H.cleanup();

  console.log(bad === 0 ? '\nCalendar feeds clean' : `\n${bad} FAILURE(S)`);
  process.exitCode = bad === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (server) server.kill();
  if (feedServer) feedServer.closeAllConnections();
  feedServer.close();
  await clearClaims();
  await H.cleanup();
  process.exitCode = 1;
});
