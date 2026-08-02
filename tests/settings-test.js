// The setup screen's two endpoints: saving, and proving what was saved works.
//
// THE VERIFICATION IS THE FEATURE. Every value here is one that looks correct
// when it is wrong — a mistyped chat id is still ten digits, a revoked
// calendar url is still a url — so the thing worth testing is not "was it
// stored" but "was the person told the truth about it".
//
// Three outcomes are kept apart throughout, and the middle one is the reason:
//
//   reachable with events   it works
//   reachable and empty     it works, and there is nothing on it
//   unreachable             it does not work
//
// An empty calendar and a dead url both show nothing on the day screen. A
// setup sheet that reports them the same way sends someone looking for a bug
// in the wrong place.
//
// Nothing real is sent: Telegram's API is served locally.

const H = require('./harness');
const ROOT = H.ROOT;
process.chdir(ROOT);

const http = require('http');

const PORT = 3576;
const BASE = `http://127.0.0.1:${PORT}`;
const TG_PORT = 3577;
const FEED_PORT = 3578;
const FEED = `http://127.0.0.1:${FEED_PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const sent = [];
const REFUSE = new Set(['999999999']);

const ics = (events) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const event = (uid, summary) =>
  ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTART;VALUE=DATE:20310401',
    'DTEND;VALUE=DATE:20310402', `SUMMARY:${summary}`, 'END:VEVENT'].join('\r\n');

let tg;
let feeds;

async function rowOf(which) {
  const accounts = await H.setup();
  const { data } = await H.service
    .from('profile')
    .select('telegram_chat_id, calendar_ics_url, calendar_action_ics_url')
    .eq('user_id', accounts[which].id)
    .maybeSingle();
  return data || {};
}

(async () => {
  const { a: A, b: B } = await H.setup();
  await H.assertGuarded();
  await H.cleanup();
  await H.ensureProfile(undefined, undefined, 'a');
  await H.ensureProfile(undefined, undefined, 'b');

  tg = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      sent.push(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (REFUSE.has(String(payload.chat_id))) {
        return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }));
      }
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise((r) => tg.listen(TG_PORT, r));
  tg.unref();

  feeds = http.createServer((req, res) => {
    if (req.url.includes('empty')) {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      return res.end(ics([]));
    }
    if (req.url.includes('notacalendar')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>this is a login page, not a feed</html>');
    }
    if (req.url.includes('gone')) {
      res.writeHead(404);
      return res.end('nope');
    }
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(ics([event('e-1', 'Something'), event('e-2', 'Another')]));
  });
  await new Promise((r) => feeds.listen(FEED_PORT, r));
  feeds.unref();

  const server = H.spawnServer(PORT, {
    TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    TELEGRAM_BOT_TOKEN: 'test-token',
  });
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  const post = (as, path, body) =>
    H.as(as)(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  try {
    console.log('1. what is set, without saying what it is');
    {
      await post(A, '/telegram', { chat_id: '8906223785' });
      await post(A, '/settings/calendar', { url: `${FEED}/secret-abc123/basic.ics` });

      const s = await (await H.as(A)(`${BASE}/settings`)).json();

      check('it says the chat is set', s.telegram.set === true);
      check('showing only the last four', s.telegram.hint === '…3785', s.telegram.hint);
      check('it says the calendar is set', s.calendar.set === true);

      // THE POINT. A secret iCal address is a bearer credential — whoever holds
      // the string reads that calendar for ever, with no sign-in. It must not
      // come back out of the server, or the settings screen becomes the easiest
      // place in the system to photograph one.
      const whole = JSON.stringify(s);
      check('the secret path segment never leaves the server',
        !whole.includes('secret-abc123'), whole);
      check('nor the whole url', !whole.includes(`${FEED}/secret-abc123/basic.ics`));
      check('but it is recognisable', /basic\.ics/.test(s.calendar.hint),
        s.calendar.hint);

      // ONE CALENDAR. The second column is still in the schema and the settings
      // route must not offer it: a screen that can still fill it would keep the
      // dead feed alive in the data long after it left the code.
      check('there is no second calendar to set',
        s.calendar_action_ics_url === undefined, JSON.stringify(Object.keys(s)));
    }

    console.log('\n2. a calendar url that works, is empty, or is dead');
    {
      const full = await (await post(A, '/settings/calendar', { url: `${FEED}/full.ics` })).json();
      check('a working feed is reachable', full.reachable === true, JSON.stringify(full));
      check('and says how much is on it', full.events === 2, String(full.events));

      const empty = await (await post(A, '/settings/calendar', { url: `${FEED}/empty.ics` })).json();
      check('an empty feed is still reachable', empty.reachable === true, JSON.stringify(empty));
      check('with nothing on it', empty.events === 0, String(empty.events));

      const dead = await (await post(A, '/settings/calendar', { url: `${FEED}/gone.ics` })).json();
      check('a dead feed is not reachable', dead.reachable === false, JSON.stringify(dead));
      check('and says what it answered', /404/.test(dead.error || ''), dead.error);

      // THE DISTINCTION, stated as a check rather than left to the reader.
      check('empty and unreachable do not read alike',
        empty.reachable !== dead.reachable, `${empty.reachable} vs ${dead.reachable}`);

      const html = await (await post(A, '/settings/calendar', { url: `${FEED}/notacalendar.ics` })).json();
      check('a page that is not a calendar is refused too', html.reachable === false,
        JSON.stringify(html));

      // Saved even when the check failed — the network is not the url — but
      // never reported as working.
      check('a failing url is still stored', (await rowOf('a')).calendar_ics_url ===
        `${FEED}/notacalendar.ics`, String((await rowOf('a')).calendar_ics_url));

      const cleared = await (await post(A, '/settings/calendar', { url: null })).json();
      check('clearing works', cleared.cleared === true, JSON.stringify(cleared));
      check('and empties the row', (await rowOf('a')).calendar_ics_url === null);
    }

    console.log('\n3. two accounts setting up at once do not touch each other');
    {
      // The paste that used to do this in one request is gone. The same
      // question, asked of the two endpoints that replaced it.
      await H.cleanup();
      await H.ensureProfile(undefined, undefined, 'a');
      await H.ensureProfile(undefined, undefined, 'b');

      await Promise.all([
        post(A, '/telegram', { chat_id: '1010101010' }),
        post(B, '/telegram', { chat_id: '2020202020' }),
        post(A, '/settings/calendar', { url: `${FEED}/a-only.ics` }),
        post(B, '/settings/calendar', { url: `${FEED}/b-only.ics` }),
      ]);

      const rowA = await rowOf('a');
      const rowB = await rowOf('b');

      check('A kept their own chat id', rowA.telegram_chat_id === '1010101010',
        String(rowA.telegram_chat_id));
      check('B kept theirs', rowB.telegram_chat_id === '2020202020',
        String(rowB.telegram_chat_id));
      check('A kept their own calendar', rowA.calendar_ics_url === `${FEED}/a-only.ics`,
        String(rowA.calendar_ics_url));
      check('B kept theirs', rowB.calendar_ics_url === `${FEED}/b-only.ics`,
        String(rowB.calendar_ics_url));

      // Neither row is empty, or the four checks above pass just as well
      // against two accounts that both saved nothing.
      check('and neither save was a no-op',
        Boolean(rowA.telegram_chat_id && rowB.telegram_chat_id));
    }

    console.log('\n4. there is no paste to make any more');
    {
      // The prompt, the box, the preview and the import are gone. What is left
      // is two fields that each prove themselves, which is what the paste was
      // wrapping.
      for (const path of ['/settings/preview', '/settings/import']) {
        const res = await post(A, path, { paste: '{}' });
        check(`${path} is gone`, res.status === 404, String(res.status));
      }

      const html = require('fs').readFileSync(ROOT + '/public/index.html', 'utf8');
      check('and the page carries no prompt to copy', !/prompt-text/.test(html));
      check('nor a box to paste into', !/id="paste"/.test(html));

      // WHAT REPLACED IT. Instructions a person can follow with the app in one
      // hand, naming the exact words they will see on the other screen.
      check('the Telegram steps name the bot', /@userinfobot<\/b>/.test(html));
      check('the calendar steps name the panel', /Integrate calendar<\/b>/.test(html));
      check('and the row to copy', /Secret address in iCal format<\/b>/.test(html));
      check('and say the phone app cannot do it', /phone app cannot/i.test(html));

      const figures = html.match(/class="figure"/g) || [];
      check('both steps are drawn as well as written', figures.length === 2,
        String(figures.length));
      // A drawing that says nothing to a screen reader is decoration sitting
      // in the middle of an instruction.
      const described = html.match(/class="figure"[\s\S]{0,200}?aria-label="/g) || [];
      check('and each drawing says what it shows', described.length === 2,
        String(described.length));

      check('the calendar warning is still on the screen',
        /read your whole calendar/i.test(html));
    }


    console.log('\n5. where the time went');
    {
      await H.cleanup();
      await H.ensureProfile(undefined, undefined, 'a');
      await H.ensureProfile(undefined, undefined, 'b');

      const stats = async (who) => (await H.as(who)(`${BASE}/stats`)).json();

      // NOTHING PLANNED IS NOT ZERO HOURS. An account that has not started and
      // a month of empty days are different facts, and the screen says
      // something different for each.
      const bare = await stats(A);
      check('an account with no plans reports no days', bare.days === 0, JSON.stringify(bare));
      check('and no bars to draw', bare.by_kind.length === 0, JSON.stringify(bare.by_kind));
      check('while still saying what window it looked at',
        bare.window_days === 30, String(bare.window_days));

      // A day with three blocks: one habit, one project, one typed straight
      // into the day and belonging to nothing.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
        .format(new Date());

      const mk = async (type, title, extra = {}) => {
        const { data } = await H.db.from('entries')
          .insert({ user_id: A.id, type, title, ...extra }).select().single();
        return data;
      };
      const gym = await mk('habit', 'Gym', { frequency: 'daily' });
      const study = await mk('project', 'Rewire the study');

      const { data: plan } = await H.db.from('plans')
        .insert({ user_id: A.id, date: today, wake_time: '08:00:00', status: 'confirmed' })
        .select().single();

      await H.db.from('blocks').insert([
        { user_id: A.id, plan_id: plan.id, title: 'Gym', entry_id: gym.id,
          start_time: '08:00:00', duration_minutes: 60, sort_order: 0 },
        { user_id: A.id, plan_id: plan.id, title: 'Rewire the study', entry_id: study.id,
          start_time: '09:00:00', duration_minutes: 120, sort_order: 1 },
        { user_id: A.id, plan_id: plan.id, title: 'Dentist', entry_id: null,
          start_time: '14:00:00', duration_minutes: 30, sort_order: 2 },
      ]);

      const mine = await stats(A);
      check('one day planned', mine.days === 1, String(mine.days));
      check('three blocks', mine.blocks === 3, String(mine.blocks));
      check('and three and a half hours', mine.minutes === 210, String(mine.minutes));

      const kind = Object.fromEntries(mine.by_kind.map((k) => [k.kind, k.minutes]));
      check('the project took the most', kind.project === 120, JSON.stringify(kind));
      check('the habit next', kind.habit === 60, JSON.stringify(kind));
      // A block typed straight into the day belongs to no thing in the list,
      // and is counted apart rather than dropped: the parts have to add up to
      // the whole or the bars are lying about the total above them.
      check('and the untagged half hour is kept apart',
        kind.untagged === 30, JSON.stringify(kind));
      check('the parts add up to the whole',
        mine.by_kind.reduce((n, k) => n + k.minutes, 0) === mine.minutes);
      check('and nothing empty is drawn',
        mine.by_kind.every((k) => k.minutes > 0), JSON.stringify(mine.by_kind));

      check('the top list is by time, biggest first',
        mine.top.map((t) => t.title).join(',') === 'Rewire the study,Gym',
        JSON.stringify(mine.top));
      check('and holds nothing that was not tagged',
        !mine.top.some((t) => t.title === 'Dentist'), JSON.stringify(mine.top));

      // A day outside the window is outside the figures.
      const old = new Date(`${today}T12:00:00Z`);
      old.setUTCDate(old.getUTCDate() - 60);
      const { data: oldPlan } = await H.db.from('plans')
        .insert({ user_id: A.id, date: old.toISOString().slice(0, 10),
          wake_time: '08:00:00', status: 'confirmed' })
        .select().single();
      await H.db.from('blocks').insert({
        user_id: A.id, plan_id: oldPlan.id, title: 'Long ago', entry_id: gym.id,
        start_time: '08:00:00', duration_minutes: 600, sort_order: 0,
      });

      const still = await stats(A);
      check('a day two months back is outside the window',
        still.minutes === 210 && still.days === 1,
        `${still.minutes} minutes across ${still.days} day(s)`);

      // AND IT IS ONLY EVER YOUR OWN TIME. The route reads with the caller's
      // client, so this is row level security being asked the question one
      // more way — but a stats screen totalling somebody else's hours is a
      // leak that would look like a plausible number rather than an error.
      const theirs = await stats(B);
      check('B sees none of it', theirs.days === 0 && theirs.minutes === 0,
        JSON.stringify(theirs));
      check('and A still sees their own', (await stats(A)).minutes === 210);
    }

  } finally {
    server.kill();
    tg.closeAllConnections();
    tg.close();
    feeds.closeAllConnections();
    feeds.close();
    await H.cleanup();
  }

  console.log(bad === 0 ? '\nSetup holds' : `\n${bad} FAILURE(S)`);
  process.exitCode = bad === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('harness error:', e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
  if (tg) { tg.closeAllConnections(); tg.close(); }
  if (feeds) { feeds.closeAllConnections(); feeds.close(); }
  process.exitCode = 1;
});
