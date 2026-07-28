// Two calendar feeds: things to know, and things to do.
//
// The rule that matters most is that saying no sticks. An auto-placed block
// the person deletes must not come back when they reopen the builder, or the
// feature is one that keeps arguing.
//
// Both feeds are served from a local ICS server, so the assertions are about
// this code rather than about what happens to be in anyone's real calendar.
const H = require('./harness');
const U = H.TEST_USER_ID;
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
const NEXT = '2031-03-15';

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
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
};
const post = async (p) => {
  const r = await fetch(BASE + p, { method: 'POST' });
  return { status: r.status, body: await r.json() };
};

const clearClaims = async () => {
  await H.db.from('sent_log').delete().eq('user_id', U);
};

(async () => {
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
    allDay('do-2', 'Book haircut', DATE),
    timed('do-3', 'Standup', DATE, '0900', '0915'),
  ]);

  console.log('which feed a thing is on decides what happens to it');
  {
    const r = await get(`/calendar/${DATE}`);
    check('the day reads', r.status === 200, JSON.stringify(r.body).slice(0, 100));

    // Timed events are appointments on either feed: the hour is spoken for.
    const pinned = r.body.events.map((e) => e.title).sort();
    check('timed events from both feeds are pinned', pinned.join(',') === 'Dentist,Standup', pinned.join(','));

    // All-day on the awareness feed is a note and nothing else.
    check('an all-day thing to know is a note',
      r.body.all_day.map((a) => a.title).join(',') === 'Mums birthday',
      JSON.stringify(r.body.all_day));

    // All-day on the action feed is work waiting to be placed.
    const offered = r.body.to_place.map((t) => t.title).sort();
    check('all-day things to do are offered', offered.join(',') === 'Book haircut,Cancel Paramount', offered.join(','));
    check('and are not in the note', !JSON.stringify(r.body.all_day).includes('Paramount'));
    check('nor pinned', !pinned.includes('Cancel Paramount'));

    check('nothing is reported as failed', r.body.failed.length === 0, JSON.stringify(r.body.failed));
  }

  console.log('\nplacing is a claim, and it is made once');
  {
    const first = await post(`/calendar/${DATE}/place`);
    check('the first open is offered both', first.body.placed.length === 2, JSON.stringify(first.body.placed));
    check('as ordinary half-hour blocks',
      first.body.placed.every((p) => p.duration_minutes === 30),
      JSON.stringify(first.body.placed.map((p) => p.duration_minutes)));

    // This is the whole feature: reopening must not bring them back.
    const second = await post(`/calendar/${DATE}/place`);
    check('reopening the builder places nothing again', second.body.placed.length === 0, JSON.stringify(second.body.placed));

    const third = await post(`/calendar/${DATE}/place`);
    check('and again', third.body.placed.length === 0);

    // The read is unaffected: it still reports what the feed holds.
    const r = await get(`/calendar/${DATE}`);
    check('but the day still reports what is on the feed', r.body.to_place.length === 2, `${r.body.to_place.length}`);
  }

  console.log('\na claim is per date, not per event');
  {
    // Same events, different day. The feed server answers for any date, so
    // this proves the claim is keyed on the date and not only on the uid.
    awareness = ics([]);
    action = ics([allDay('do-1', 'Cancel Paramount', NEXT)]);

    // Past the 60s cache.
    const { data: claimed } = await H.db
      .from('sent_log').select('job, sent_for_date').eq('user_id', U);
    check('two claims exist for the first date',
      claimed.filter((c) => c.sent_for_date === DATE).length === 2,
      JSON.stringify(claimed.map((c) => c.sent_for_date)));
    check('and each names its own event',
      new Set(claimed.map((c) => c.job)).size === claimed.length,
      claimed.map((c) => c.job.slice(0, 20)).join(' '));
    check('under a prefix that cannot collide with a real job',
      claimed.every((c) => c.job.startsWith('placed:')), claimed[0].job.slice(0, 12));
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

    const r = await (await fetch(`${brokenBase}/calendar/2031-03-20`)).json();
    check('the request still succeeds', Array.isArray(r.events));
    check('and the dead feed is named', r.failed.length === 1, JSON.stringify(r.failed));
    check('by a name a person would recognise',
      r.failed.length === 1 && r.failed[0].label === 'Dates', JSON.stringify(r.failed));
    check('the working feed is not blamed',
      !r.failed.some((f) => f.source === 'action'), JSON.stringify(r.failed));
    check('and it still returns what it could read',
      r.to_place.map((t) => t.title).join(',') === 'Still here', JSON.stringify(r.to_place));

    broken.kill();
  }

  console.log('\nwith no action feed, nothing changes');
  {
    const solo = H.spawnServer(PORT + 1, { CALENDAR_ICS_URL: `${FEED}/dates.ics` });
    const soloBase = `http://127.0.0.1:${PORT + 1}`;
    if (!(await H.waitFor(soloBase))) throw new Error('solo server never came up');

    awareness = ics([allDay('know-9', 'Anniversary', '2031-04-01')]);
    const r = await (await fetch(`${soloBase}/calendar/2031-04-01`)).json();

    check('the awareness feed still reads', r.all_day.map((a) => a.title).join(',') === 'Anniversary', JSON.stringify(r.all_day));
    check('nothing is offered for placing', r.to_place.length === 0, JSON.stringify(r.to_place));
    check('and nothing is reported broken', r.failed.length === 0, JSON.stringify(r.failed));

    const placed = await (await fetch(`${soloBase}/calendar/2031-04-01/place`, { method: 'POST' })).json();
    check('placing is a no-op', placed.placed.length === 0, JSON.stringify(placed.placed));

    solo.kill();
  }

  console.log('\nthe page shows the failure rather than an empty day');
  {
    const fs = require('fs');
    const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
    check('it says it could not reach the calendar', /Couldn't reach \$\{names\}/.test(html));
    check('in the miss colour', /el\('div', 'err', `Couldn't reach/.test(html));
    check('the note shows even with nothing all-day',
      /!allDay\.length && !failed\.length/.test(html));
    check('and placing only happens on a day with no saved plan',
      /await loadCalendar\(date\);\s*\n\s*await placeActionItems\(date\)/.test(html));
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
