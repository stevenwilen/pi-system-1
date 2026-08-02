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
