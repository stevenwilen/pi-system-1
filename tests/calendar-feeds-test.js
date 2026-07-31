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

// Path -> exact body, for cases where two urls must return different files.
const perUrl = new Map();

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

    // A file of its own, for cases that need two urls to differ in content
    // rather than in kind. Checked first, so `awareness`/`action` stay the
    // simple default every other case uses.
    if (perUrl.has(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      return res.end(perUrl.get(req.url));
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

  // ONE SERVER FOR EVERY CASE. There used to be three, each spawned with
  // different CALENDAR_*_ICS_URL variables, because that was the only way to
  // give a case a different feed. The urls live on the profile row now, so a
  // case changes the row.
  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  await H.setProfile('a', {
    calendar_ics_url: `${FEED}/dates.ics`,
    calendar_action_ics_url: `${FEED}/action.ics`,
  });

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
    // A COLD URL, not a second server. The cache is keyed by user and url and
    // holds for a minute, so the working feed above is still cached and
    // breaking it in place would change nothing for sixty seconds. Pointing
    // the row at a url that has never been fetched is a cold slot without a
    // wait — which is what the second server was really buying.
    //
    // BOTH urls, and that is the part collapsing three servers into one
    // changes. Each case used to get a fresh process and therefore an empty
    // cache; now the cache outlives a case, so any case that changes what a
    // feed RETURNS needs a url that has never been asked for. Leaving the
    // action feed on its old url served this case the previous case's events,
    // and the check below went red saying it could read nothing.
    await H.setProfile('a', {
      calendar_ics_url: `${FEED}/broken.ics`,
      calendar_action_ics_url: `${FEED}/action-later.ics`,
    });

    action = ics([allDay('do-5', 'Still here', '2031-03-20')]);

    const r = await (await authed(`${BASE}/calendar/2031-03-20`)).json();
    check('the request still succeeds', Array.isArray(r.items));
    check('and the dead feed is named', r.failed.length === 1, JSON.stringify(r.failed));
    check('by a name a person would recognise',
      r.failed.length === 1 && r.failed[0].label === 'Dates', JSON.stringify(r.failed));
    check('the working feed is not blamed',
      !r.failed.some((f) => f.source === 'action'), JSON.stringify(r.failed));
    check('and it still returns what it could read',
      r.items.map((t) => t.title).join(',') === 'Still here', JSON.stringify(r.items));
  }

  console.log('\nwith no action feed, nothing changes');
  {
    // Cleared rather than never set, and a fresh awareness url so the slot is
    // cold. Null is what a person who only keeps one calendar has.
    await H.setProfile('a', {
      calendar_ics_url: `${FEED}/solo.ics`,
      calendar_action_ics_url: null,
    });

    awareness = ics([allDay('know-9', 'Anniversary', '2031-04-01')]);
    const r = await (await authed(`${BASE}/calendar/2031-04-01`)).json();

    check('the one feed still reads', r.items.map((a) => a.title).join(',') === 'Anniversary',
      JSON.stringify(r.items));
    check('and nothing is reported broken', r.failed.length === 0, JSON.stringify(r.failed));
    check('the unset feed is not reported as failed either',
      !r.failed.some((f) => f.source === 'action'), JSON.stringify(r.failed));
  }

  console.log('\nan account with no calendar at all gets an empty aside');
  {
    // NOT AN ERROR. A person who keeps no calendar, or has not pasted a url
    // yet, is an ordinary account — and the answer has to be an empty list
    // rather than a failure, or the screen would say a feed is broken to
    // someone who never had one.
    await H.setProfile('a', { calendar_ics_url: null, calendar_action_ics_url: null });

    const r = await get('/calendar/2031-05-02');
    check('it answers', r.status === 200, String(r.status));
    check('with nothing on', r.body.items.length === 0, JSON.stringify(r.body.items));
    check('and nothing blamed', r.body.failed.length === 0, JSON.stringify(r.body.failed));
    check('there is no error', r.body.error === undefined, JSON.stringify(r.body.error));

    // Put the feeds back for anything after this.
    await H.setProfile('a', {
      calendar_ics_url: `${FEED}/dates.ics`,
      calendar_action_ics_url: `${FEED}/action.ics`,
    });
  }

  console.log('\nthe page shows the failure rather than an empty day');
  {
    const fs = require('fs');
    const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
    check('it says which feed it could not read', /could not be read/.test(html));
    check('in the miss colour', /\.cal \.failed \{[^}]*var\(--warn\)/.test(html));
    check('and an empty calendar says so plainly', /Nothing on it/.test(html));
  }

  console.log('\ntwo people, two calendars, and the cache between them');
  {
    // THE CASE THIS WHOLE CHANGE IS FOR. The feeds are per-user now, and the
    // parsed file is cached — so the question is whether one person's calendar
    // can be handed to another out of that cache.
    //
    // Same date on both sides, and deliberately: the events differ only by
    // whose feed they came from, so a leak cannot hide behind "they asked for
    // different days".
    const SHARED = '2031-06-10';

    await H.setProfile('a', {
      calendar_ics_url: `${FEED}/a-only.ics`,
      calendar_action_ics_url: null,
    });
    await H.setProfile('b', {
      calendar_ics_url: `${FEED}/b-only.ics`,
      calendar_action_ics_url: null,
    });

    const authedB = H.as((await H.setup()).b);

    // The feed server answers by url, so each account's slot holds its own file.
    perUrl.set('/a-only.ics', ics([allDay('a-1', "A's own appointment", SHARED)]));
    perUrl.set('/b-only.ics', ics([allDay('b-1', "B's own appointment", SHARED)]));

    // A first, so A's feed is the one warm in the cache when B asks.
    const first = await get(`/calendar/${SHARED}`);
    const bRes = await (await authedB(`${BASE}/calendar/${SHARED}`)).json();

    const aTitles = first.body.items.map((e) => e.title);
    const bTitles = bRes.items.map((e) => e.title);

    check('A sees their own', aTitles.join(',') === "A's own appointment", aTitles.join(','));
    check('B sees their own', bTitles.join(',') === "B's own appointment", bTitles.join(','));

    // BOTH HALVES, in one check, because either alone is satisfied by B being
    // served nothing at all — and "nothing" is what B gets under several
    // failures that have no leak in them. Keyed on the feed's source, this
    // suite goes red in eight places, but this particular line passed: an
    // earlier case had already warmed the 'awareness' slot with a third feed,
    // so B was served neither their own calendar nor A's.
    check("B has their own and not A's",
      bTitles.includes("B's own appointment") && !bTitles.includes("A's own appointment"),
      bTitles.join(','));

    // The other way round, so the result does not depend on who asked first.
    const bAgain = await (await authedB(`${BASE}/calendar/${SHARED}`)).json();
    const aAgain = await get(`/calendar/${SHARED}`);
    check('and it holds whichever order they ask in',
      bAgain.items.map((e) => e.title).join(',') === "B's own appointment" &&
        aAgain.body.items.map((e) => e.title).join(',') === "A's own appointment",
      `${bAgain.items.map((e) => e.title)} / ${aAgain.body.items.map((e) => e.title)}`);

    // NEITHER OF THEM IS EMPTY, which is the check that stops the three above
    // passing for the wrong reason. Two accounts that both see nothing also
    // never see each other's.
    check('and neither account was simply empty',
      aTitles.length === 1 && bTitles.length === 1, `${aTitles.length} / ${bTitles.length}`);
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
