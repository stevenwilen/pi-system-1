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
    // WHICH BOT THIS IS. Asked rather than configured, so a name on the screen
    // cannot disagree with the token that sends. The real API answers this on
    // a GET; the stand-in has to as well or the suite exercises only the
    // path where Telegram could not be reached.
    if (/\/getMe$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, result: { username: 'pisuite_bot' } }));
    }

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

      // AND THE STEP THAT WAS MISSING FROM THEM, which broke this for
      // everybody who followed the rest exactly. A Telegram bot may not message
      // anyone who has not pressed Start on it, and @userinfobot — the one
      // these steps named — is a different bot, so starting it grants nothing
      // here. The number saved, the test message came back "chat not found",
      // and nothing on the screen gave a reason to suspect why.
      check('they say to start THIS bot first', /id="bot-name"/.test(html));
      check('and say why, rather than leaving it as a step to obey',
        /cannot message you until you do/i.test(html));

      // The name is filled in from the server, which asks Telegram. A hardcoded
      // one could name a different bot from the token that sends — the exact
      // failure the step exists to prevent.
      const s = await (await H.as(A)(`${BASE}/settings`)).json();
      check('the server says which bot it is', s.bot === '@pisuite_bot', String(s.bot));
      check('and the markup carries wording for when it cannot',
        /the planner's bot/.test(html));
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

      // FIRST, A DAY HOLDING ONLY A BLOCK THAT BELONGS TO NOTHING. This is
      // the third state: days were planned, but none of the time was given to
      // anything in the list, so there is no answer to the question the
      // section asks. It must not read as an empty account, and it must not
      // read as half an hour of anything.
      await H.db.from('blocks').insert({
        user_id: A.id, plan_id: plan.id, title: 'Dentist', entry_id: null,
        start_time: '14:00:00', duration_minutes: 30, sort_order: 2,
      });

      const loose = await stats(A);
      check('a day of nothing-in-particular still counts as a day planned',
        loose.days === 1, String(loose.days));
      check('but none of its minutes are counted',
        loose.minutes === 0, String(loose.minutes));
      check('and no bar is drawn for it',
        loose.by_kind.length === 0, JSON.stringify(loose.by_kind));

      await H.db.from('blocks').insert([
        { user_id: A.id, plan_id: plan.id, title: 'Gym', entry_id: gym.id,
          start_time: '08:00:00', duration_minutes: 60, sort_order: 0 },
        { user_id: A.id, plan_id: plan.id, title: 'Rewire the study', entry_id: study.id,
          start_time: '09:00:00', duration_minutes: 120, sort_order: 1 },
      ]);

      const mine = await stats(A);
      check('one day planned', mine.days === 1, String(mine.days));
      // Two, not three. The Dentist block is still sitting in the day.
      check('two blocks count, the third belonging to nothing',
        mine.blocks === 2, String(mine.blocks));
      check('and three hours, not three and a half',
        mine.minutes === 180, String(mine.minutes));

      const kind = Object.fromEntries(mine.by_kind.map((k) => [k.kind, k.minutes]));
      check('the project took the most', kind.project === 120, JSON.stringify(kind));
      check('the habit next', kind.habit === 60, JSON.stringify(kind));
      // The half hour typed straight into the day is gone from every figure,
      // not moved to a share of its own. The question is what the time was
      // given TO, and that block answers it with nothing.
      check('and the untagged half hour is nowhere',
        kind.untagged === undefined, JSON.stringify(kind));
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
        still.minutes === 180 && still.days === 1,
        `${still.minutes} minutes across ${still.days} day(s)`);

      // AND IT IS ONLY EVER YOUR OWN TIME. The route reads with the caller's
      // client, so this is row level security being asked the question one
      // more way — but a stats screen totalling somebody else's hours is a
      // leak that would look like a plausible number rather than an error.
      const theirs = await stats(B);
      check('B sees none of it', theirs.days === 0 && theirs.minutes === 0,
        JSON.stringify(theirs));
      check('and A still sees their own', (await stats(A)).minutes === 180);
    }

    console.log('\n6. an account with no profile row, which is every new account');
    {
      // NO ensureProfile() IN THIS SECTION, and that is the entire point of it.
      // Every other section in this file — and every other suite — seeds a
      // profile row with the service key before it starts, because the harness
      // has to: nothing in the app ever created one. So the suite only ever
      // exercised these routes against an account that had been set up by hand,
      // and the state every real person is in on their first day was the one
      // state never tested.
      //
      // What that hid: the writes were UPDATEs, an UPDATE matching no row
      // reports success-with-nothing-changed, and so linking Telegram on a
      // fresh signup answered `no profile for this account`, stored nothing,
      // and sent nothing.
      await H.cleanup();

      const profileOf = async (which) => {
        const accounts = await H.setup();
        const { data } = await H.service
          .from('profile')
          .select('user_id, telegram_chat_id, calendar_ics_url, timezone, default_wake_time')
          .eq('user_id', accounts[which].id)
          .maybeSingle();
        return data;
      };

      // THE PRECONDITION, CHECKED RATHER THAN ASSUMED. Everything below passes
      // trivially against an account that already has a row, so if cleanup ever
      // stops deleting these this check fails here instead of quietly turning
      // the whole section into a second copy of section 1.
      check('the account starts with no profile row at all',
        (await profileOf('a')) === null && (await profileOf('b')) === null);

      const before = sent.length;
      const linked = await post(A, '/telegram', { chat_id: '3141592653' });
      const linkedBody = await linked.json();

      check('linking a chat is not a 404', linked.status === 200, String(linked.status));
      check('and does not answer "no profile for this account"',
        linkedBody.error !== 'no profile for this account', JSON.stringify(linkedBody));
      check('it reports the chat as delivered', linkedBody.delivered === true,
        JSON.stringify(linkedBody));

      // Saved AND proved. The old failure returned before sendToChat, so a
      // check on the stored row alone would not notice a route that stopped
      // sending, and a check on the message alone would not notice one that
      // stopped storing.
      const rowA = await profileOf('a');
      check('the row now exists', Boolean(rowA));
      check('holding the chat id that was sent', rowA && rowA.telegram_chat_id === '3141592653',
        String(rowA && rowA.telegram_chat_id));
      check('and the test message actually went out', sent.length === before + 1,
        `${before} then ${sent.length}`);
      check('to that chat', String((sent[sent.length - 1] || {}).chat_id) === '3141592653',
        String((sent[sent.length - 1] || {}).chat_id));

      // The row a route creates is the row the schema describes. Nothing here
      // guesses at a timezone, so a new account is UTC until it says otherwise
      // — and 07:00 is what the column defaults to, not something this route
      // decided.
      check('the created row carries the schema defaults',
        rowA && rowA.timezone === 'UTC' && String(rowA.default_wake_time).slice(0, 5) === '07:00',
        `${rowA && rowA.timezone} / ${rowA && rowA.default_wake_time}`);

      // Creating one account's row is not creating anybody else's. B has done
      // nothing and must still have nothing.
      check('and B, who did nothing, still has no row', (await profileOf('b')) === null);

      // THE SAME QUESTION OF THE OTHER ENDPOINT, on the other account, still
      // with no row of its own. The calendar save is the worse version of this
      // bug: it probes the feed first, so before the fix a new account waited
      // out the fetch and was then told it had no profile.
      const saved = await post(B, '/settings/calendar', { url: `${FEED}/b-first.ics` });
      const savedBody = await saved.json();

      check('saving a calendar is not a 404 either', saved.status === 200, String(saved.status));
      check('the feed was read, and the answer says so', savedBody.reachable === true,
        JSON.stringify(savedBody));

      // `|| {}` on every row read from here down, because a regression puts a
      // null here and reading a column off it throws — which ends the section
      // on a stack trace and takes the checks below it with it. The thing you
      // want when this breaks again is the whole list of what broke.
      const firstB = (await profileOf('b')) || {};
      check('and the url is on the row', firstB.calendar_ics_url === `${FEED}/b-first.ics`,
        String(firstB.calendar_ics_url));

      // WHAT AN UPSERT COULD BREAK THAT AN UPDATE COULD NOT. A second write
      // must update its own column and leave the rest of the row alone; a
      // payload that carried the whole row would blank whatever it omitted.
      await post(B, '/telegram', { chat_id: '2718281828' });
      const rowB = (await profileOf('b')) || {};
      check('a second save keeps the first', rowB.calendar_ics_url === `${FEED}/b-first.ics`,
        String(rowB.calendar_ics_url));
      check('as well as its own', rowB.telegram_chat_id === '2718281828',
        String(rowB.telegram_chat_id));
      check('and leaves the timezone alone', rowB.timezone === 'UTC', String(rowB.timezone));

      // Clearing something that was never set, on an account that has no row to
      // clear it from. Answering this any way other than "cleared" would mean
      // the screen has to know which state it is in before it can offer the
      // button.
      await H.cleanup();
      const clearedChat = await post(A, '/telegram/clear', {});
      const clearedChatBody = await clearedChat.json();
      check('clearing a chat on an account with no row is not a 404',
        clearedChat.status === 200, String(clearedChat.status));
      check('it says cleared', clearedChatBody.cleared === true, JSON.stringify(clearedChatBody));

      const clearedCal = await post(A, '/settings/calendar', { url: null });
      const clearedCalBody = await clearedCal.json();
      check('and so is clearing a calendar', clearedCal.status === 200, String(clearedCal.status));
      check('it says cleared too', clearedCalBody.cleared === true, JSON.stringify(clearedCalBody));

      // The settings screen an untouched account loads. It answered this
      // correctly even while every save was failing — which is exactly how the
      // bug survived: the sheet said "Not linked", the person pressed Save, and
      // only then did anything go wrong.
      await H.cleanup();
      const fresh = await (await H.as(A)(`${BASE}/settings`)).json();
      check('a brand new account can read its own empty settings',
        fresh.telegram.set === false && fresh.calendar.set === false, JSON.stringify(fresh));
      check('and is told the timezone it actually has', fresh.timezone === 'UTC', fresh.timezone);
    }

    console.log('\n7. when the day happens');
    {
      // THE ROW THE SIGNUP TRIGGER WRITES, AND NOTHING ELSE. ensureProfile
      // fills in a zone and a wake time, which is right for every other
      // section and wrong for this one — the whole subject here is what an
      // account that has never said anything is sitting on, and a fixture that
      // says it for them would have made the first two checks below assert the
      // harness's own defaults.
      await H.cleanup();
      const bareRows = await H.setup();
      await H.db.from('profile').insert([
        { user_id: bareRows.a.id },
        { user_id: bareRows.b.id },
      ]);

      const settingsOf = async (who) => (await H.as(who)(`${BASE}/settings`)).json();
      const entriesOf = async (who) => (await H.as(who)(`${BASE}/entries`)).json();
      const rowOfA = async () => {
        const accounts = await H.setup();
        const { data } = await H.service
          .from('profile')
          .select('timezone, default_wake_time')
          .eq('user_id', accounts.a.id)
          .maybeSingle();
        return data || {};
      };

      // WHAT AN UNTOUCHED ACCOUNT IS, and it is not "unset": the column is NOT
      // NULL with a default, so there is no state that means "has not said".
      // UTC is what the screen has to work with, and the reason it compares
      // against the device rather than looking for an empty field.
      const before = await settingsOf(A);
      check('a new account is on UTC', before.timezone === 'UTC', before.timezone);
      check('and starts its day at seven', before.wake_minutes === 420,
        String(before.wake_minutes));
      check('the screen is told the window it may offer',
        before.wake_min === 240 && before.wake_max === 720 && before.wake_step === 30,
        JSON.stringify([before.wake_min, before.wake_max, before.wake_step]));

      // TWO ZONES THAT ARE NEVER ON THE SAME DATE. Kiritimati is +14 and Niue
      // is -11, a twenty-five hour spread, so this comparison cannot pass by
      // being run at a lucky hour — which is the failure mode of every "the
      // date changed" test written against two ordinary zones.
      const EAST = 'Pacific/Kiritimati';
      const WEST = 'Pacific/Niue';

      const east = await (await post(A, '/settings/timezone', { timezone: EAST })).json();
      check('a zone is accepted', east.timezone === EAST, JSON.stringify(east));
      check('and the answer carries the date under it', /^\d{4}-\d{2}-\d{2}$/.test(east.today || ''),
        JSON.stringify(east));

      const eastEntries = await entriesOf(A);
      check('the list reports the new zone', eastEntries.timezone === EAST, eastEntries.timezone);

      const west = await (await post(A, '/settings/timezone', { timezone: WEST })).json();
      const westEntries = await entriesOf(A);
      check('and the other one', westEntries.timezone === WEST, westEntries.timezone);

      // THE POINT OF THE WHOLE SETTING. Everything that decides which day a
      // block belongs to, and which day the nudge asks about, is this boundary.
      check('THE DAY BOUNDARY MOVES WITH IT',
        eastEntries.today !== westEntries.today,
        `${eastEntries.today} vs ${westEntries.today}`);
      check('and both are the date the server would compute for that zone',
        eastEntries.today === east.today && westEntries.today === west.today,
        `${eastEntries.today}/${east.today} ${westEntries.today}/${west.today}`);

      // STORED CANONICAL. Intl takes several spellings of one place; the column
      // holds one of them, or nothing downstream can match on it.
      const alias = await (await post(A, '/settings/timezone', { timezone: 'us/eastern' })).json();
      check('an alias is stored as the name it resolves to',
        alias.timezone === 'America/New_York', JSON.stringify(alias));
      check('and that is what is on the row',
        (await rowOfA()).timezone === 'America/New_York',
        String((await rowOfA()).timezone));

      // REFUSED, AND NOT STORED. The second half is the half worth checking:
      // a route that answers 400 and writes anyway is a route that looks
      // correct from the screen and has already broken the scheduler.
      const good = (await rowOfA()).timezone;
      for (const bad of ['Mars/Olympus', 'America/New_Yrok', '', '   ', null, 42, { a: 1 }]) {
        const r = await post(A, '/settings/timezone', { timezone: bad });
        const body = await r.json();
        check(`${JSON.stringify(bad)} is refused`, r.status === 400, `${r.status} ${JSON.stringify(body)}`);
      }
      check('and none of them changed the row', (await rowOfA()).timezone === good,
        String((await rowOfA()).timezone));

      // AN OFFSET IS NOT A ZONE, and Intl accepts it — which is why this is
      // checked by name. '+05:00' never changes its clocks, so whoever stored
      // it in January is an hour out in April and nothing can notice.
      const offset = await post(A, '/settings/timezone', { timezone: '+05:00' });
      check('an offset is refused, though Intl would take it', offset.status === 400,
        String(offset.status));
      check('the message says why', /clocks change/.test((await offset.json()).error || ''));
      check('and the row is still the last good one', (await rowOfA()).timezone === good,
        String((await rowOfA()).timezone));

      console.log('   the hour a day starts at');

      const woke = await (await post(A, '/settings/wake', { minutes: 330 })).json();
      check('half past five is accepted', woke.wake_minutes === 330, JSON.stringify(woke));
      check('the row holds it', String((await rowOfA()).default_wake_time).slice(0, 5) === '05:30',
        String((await rowOfA()).default_wake_time));
      check('and the day screen is told', (await entriesOf(A)).wake_time === '05:30',
        (await entriesOf(A)).wake_time);

      const stored = (await rowOfA()).default_wake_time;
      for (const [minutes, why] of [
        [345, 'off the half hour'], [180, 'before the window'], [780, 'after it'],
        [-30, 'before the day'], ['seven', 'not a number'], [null, 'nothing at all'],
      ]) {
        const r = await post(A, '/settings/wake', { minutes });
        check(`${JSON.stringify(minutes)} is refused: ${why}`, r.status === 400,
          `${r.status} ${JSON.stringify(await r.json())}`);
      }
      check('and the stored hour survived all of them',
        (await rowOfA()).default_wake_time === stored, String((await rowOfA()).default_wake_time));

      // The bounds are the ones the screen is handed, so the two cannot
      // disagree about what is offerable.
      const edges = await settingsOf(A);
      const low = await post(A, '/settings/wake', { minutes: edges.wake_min });
      const high = await post(A, '/settings/wake', { minutes: edges.wake_max });
      check('both ends of the window it advertises are accepted',
        low.status === 200 && high.status === 200, `${low.status} ${high.status}`);

      console.log('   whose day it is');

      // Neither field is anybody else's. B has done nothing to their own and
      // must still be sitting on the defaults.
      const theirs = await settingsOf(B);
      check('B is untouched by any of it',
        theirs.timezone === 'UTC' && theirs.wake_minutes === 420, JSON.stringify(theirs));

      await post(B, '/settings/timezone', { timezone: 'Europe/Berlin' });
      check('and setting B\'s does not move A\'s',
        (await settingsOf(A)).timezone === 'America/New_York',
        (await settingsOf(A)).timezone);
      check('while B has their own', (await settingsOf(B)).timezone === 'Europe/Berlin',
        (await settingsOf(B)).timezone);

      // THE UPSERT PATH, for the account that has no row at all. This is the
      // case section 6 exists for, asked of the two new routes.
      await H.cleanup();
      const bare = await post(A, '/settings/timezone', { timezone: 'Asia/Tokyo' });
      check('an account with no profile row can still set a zone', bare.status === 200,
        `${bare.status} ${JSON.stringify(await bare.json())}`);
      check('and the row it created holds it', (await rowOfA()).timezone === 'Asia/Tokyo',
        String((await rowOfA()).timezone));
      check('with the wake time still at the column default',
        String((await rowOfA()).default_wake_time).slice(0, 5) === '07:00',
        String((await rowOfA()).default_wake_time));

      await H.cleanup();
      const bareWake = await post(A, '/settings/wake', { minutes: 480 });
      check('and one with no row can set a wake time', bareWake.status === 200,
        String(bareWake.status));
      check('leaving the zone at the column default',
        (await rowOfA()).timezone === 'UTC', String((await rowOfA()).timezone));
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
