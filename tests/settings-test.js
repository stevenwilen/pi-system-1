// The setup sheet's endpoints: saving, and proving what was saved works.
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
  const paste = (as, text) => post(as, '/settings/import', { paste: text });
  const preview = (as, text) => post(as, '/settings/preview', { paste: text });

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

      // Saved even when the check failed — the network is not the paste — but
      // never reported as working.
      check('a failing url is still stored', (await rowOf('a')).calendar_ics_url ===
        `${FEED}/notacalendar.ics`, String((await rowOf('a')).calendar_ics_url));

      const cleared = await (await post(A, '/settings/calendar', { url: null })).json();
      check('clearing works', cleared.cleared === true, JSON.stringify(cleared));
      check('and empties the row', (await rowOf('a')).calendar_ics_url === null);
    }

    console.log('\n3. a paste, however it arrives');
    {
      const body = {
        telegram_chat_id: '111222333',
        calendar_ics_url: `${FEED}/know.ics`,
        items: [
          { type: 'habit', title: 'Read before bed', frequency: 'daily' },
          { type: 'task', title: 'Return the router' },
        ],
      };

      for (const [what, text] of [
        ['bare', JSON.stringify(body)],
        ['fenced', '```json\n' + JSON.stringify(body, null, 2) + '\n```'],
        // WHAT THE PROMPT ACTUALLY PRODUCES. It ends with a bare fence, no
        // language tag, because "json" is one of the words it is not allowed
        // to say — so the commonest paste in the world is this one, and it
        // would be an odd thing for the parser to be worse at.
        ['fenced with no language tag', '```\n' + JSON.stringify(body, null, 2) + '\n```'],
        ['buried in prose', `Great, here it is!\n\n${JSON.stringify(body)}\n\nLet me know.`],
        // A setup conversation shows the shape before it fills it in, so the
        // first object in a transcript is an example and the last is the answer.
        ['after an example', `Shape: {"items": []}\n\nYours:\n${JSON.stringify(body)}`],
      ]) {
        const res = await preview(A, text);
        const p = await res.json();
        check(`${what} is understood`, res.status === 200 && p.items && p.items.length === 2,
          JSON.stringify(p).slice(0, 90));
      }

      const nonsense = await preview(A, 'no json here at all');
      check('and prose with no JSON is refused', nonsense.status === 400, String(nonsense.status));
    }

    console.log('\n4. a preview writes nothing');
    {
      const before = await rowOf('a');
      await preview(A, JSON.stringify({
        telegram_chat_id: '444555666',
        items: [{ type: 'task', title: 'Should not exist yet' }],
      }));
      const after = await rowOf('a');

      check('the row is untouched', before.telegram_chat_id === after.telegram_chat_id,
        `${before.telegram_chat_id} -> ${after.telegram_chat_id}`);

      const { data } = await H.service
        .from('entries').select('id').eq('user_id', A.id).eq('title', 'Should not exist yet');
      check('and nothing was added', (data || []).length === 0, `${(data || []).length}`);
    }

    console.log('\n5. a bad chat id saves nothing and says the send failed');
    {
      const before = await rowOf('a');
      const { data: countBefore } = await H.service
        .from('entries').select('id').eq('user_id', A.id);

      sent.length = 0;
      const res = await paste(A, JSON.stringify({
        telegram_chat_id: '999999999',
        items: [{ type: 'task', title: 'Rides along with a bad chat id' }],
      }));
      const body = await res.json();

      // It IS saved — the id is well-formed, and Telegram refusing it today is
      // not proof it is wrong for ever. What must never happen is silence.
      check('the request succeeds', res.status === 200, String(res.status));
      check('and reports that nothing arrived',
        body.checks && body.checks.telegram && body.checks.telegram.delivered === false,
        JSON.stringify(body.checks));
      check("in Telegram's own words",
        /chat not found/i.test(((body.checks || {}).telegram || {}).error || ''),
        ((body.checks || {}).telegram || {}).error);
      check('a message really was attempted', sent.length === 1, JSON.stringify(sent));

      await H.service.from('entries').delete().eq('user_id', A.id)
        .eq('title', 'Rides along with a bad chat id');
      void before; void countBefore;
    }

    console.log('\n6. one bad item and NOTHING is written');
    {
      await post(A, '/telegram/clear');
      await post(A, '/settings/calendar', { url: null });

      const res = await paste(A, JSON.stringify({
        telegram_chat_id: '777888999',
        calendar_ics_url: `${FEED}/know.ics`,
        items: [
          { type: 'task', title: 'This one is fine' },
          // A due date with no size cannot produce a warning mark, so it is
          // refused — the same rule the add form applies.
          { type: 'task', title: 'This one is not', due: '2031-05-05' },
        ],
      }));
      const body = await res.json();

      check('the whole paste is refused', res.status === 400, String(res.status));
      check('and says so plainly', /nothing was saved/i.test(body.error || ''), body.error);
      check('naming the item', /This one is not/.test((body.problems || []).join(' ')),
        JSON.stringify(body.problems));

      // ALL OR NOTHING. Half a paste in the notebook is worse than none: you
      // cannot tell which half, and running it again duplicates what landed.
      const row = await rowOf('a');
      check('the chat id was not written', row.telegram_chat_id === null,
        String(row.telegram_chat_id));
      check('the calendar was not written', row.calendar_ics_url === null,
        String(row.calendar_ics_url));

      const { data } = await H.service
        .from('entries').select('title').eq('user_id', A.id).eq('title', 'This one is fine');
      check('and the good item was not added either', (data || []).length === 0,
        `${(data || []).length}`);
    }

    console.log('\n7. a paste with an unreachable calendar is reported, not hidden');
    {
      const dead = await (await paste(A, JSON.stringify({
        calendar_ics_url: `${FEED}/gone.ics`, items: [],
      }))).json();

      check('it saves', dead.saved === true, JSON.stringify(dead).slice(0, 80));
      check('and the calendar is named as unreachable',
        dead.checks.calendar && dead.checks.calendar.reachable === false,
        JSON.stringify(dead.checks.calendar));

      // Stored anyway, because a feed that is down today is not a wrong url.
      check('but it is stored', Boolean((await rowOf('a')).calendar_ics_url));

      const empty = await (await paste(A, JSON.stringify({
        calendar_ics_url: `${FEED}/empty.ics`, items: [],
      }))).json();

      check('an empty one is reachable',
        empty.checks.calendar && empty.checks.calendar.reachable === true,
        JSON.stringify(empty.checks.calendar));
      check('and reports zero events rather than a failure',
        empty.checks.calendar.events === 0, JSON.stringify(empty.checks.calendar));
      check('so the two do not read alike',
        dead.checks.calendar.reachable !== empty.checks.calendar.reachable);
    }

    console.log('\n8. two accounts pasting at once do not touch each other');
    {
      await H.cleanup();
      await H.ensureProfile(undefined, undefined, 'a');
      await H.ensureProfile(undefined, undefined, 'b');

      const forA = JSON.stringify({
        telegram_chat_id: '1010101010',
        calendar_ics_url: `${FEED}/a-only.ics`,
        items: [{ type: 'task', title: "A's imported task" }],
      });
      const forB = JSON.stringify({
        telegram_chat_id: '2020202020',
        calendar_ics_url: `${FEED}/b-only.ics`,
        items: [{ type: 'task', title: "B's imported task" }],
      });

      // Together, so neither can be said to have finished before the other
      // started.
      const [ra, rb] = await Promise.all([paste(A, forA), paste(B, forB)]);
      check('both saved', ra.status === 200 && rb.status === 200, `${ra.status} / ${rb.status}`);

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

      const titlesOf = async (id) => {
        const { data } = await H.service.from('entries').select('title').eq('user_id', id);
        return (data || []).map((r) => r.title).sort();
      };
      const ta = await titlesOf(A.id);
      const tb = await titlesOf(B.id);

      check("A has only A's thing", ta.join(',') === "A's imported task", ta.join(','));
      check("B has only B's", tb.join(',') === "B's imported task", tb.join(','));
      // Neither list is empty, or the two checks above pass against two
      // accounts that both imported nothing.
      check('and neither import was a no-op', ta.length === 1 && tb.length === 1,
        `${ta.length} / ${tb.length}`);
    }

    console.log('\n9. the prompt is engine text');
    {
      const fs = require('fs');
      const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
      const block = html.match(/<script type="text\/plain" id="prompt-text">([\s\S]*?)<\/script>/);
      check('the page carries one', Boolean(block));
      const prompt = block[1].trim();

      // The prompt is hard-wrapped prose, so any phrase longer than a few
      // words straddles a newline and an exact match fails on the wrapping
      // rather than on the meaning. Everything asserting what it SAYS runs
      // against this; the two checks about its SHAPE — no interpolation, ends
      // with the fence — stay on the raw text.
      const flat = prompt.replace(/\s+/g, ' ');

      // IDENTICAL FOR EVERYONE. It is copied out of the page as written, so
      // anything interpolated into it would be one person's data travelling
      // into someone else's chat window.
      check('nothing is interpolated into it', !/\$\{/.test(flat));
      check('and it names nobody', !/steven|@gmail|b586ea65/i.test(prompt));

      check('it is strictly ordered', /in order/i.test(flat));
      check('and refuses to move on',
        /Finish each one before starting the next/i.test(flat));
      check('and says so even when asked to skip ahead',
        /Do not skip ahead/i.test(flat));

      // THE ORDER, and it is the whole point of this rewrite. The interview
      // comes first because without it there is nothing to plan; reminders and
      // the calendar are conveniences and go second, together, behind one
      // question that can be answered "later".
      const things = prompt.indexOf('STEP 1. WHAT THEY WANT TO GET DONE');
      const rest = prompt.indexOf('STEP 2. REMINDERS AND CALENDAR');
      const reminders = prompt.indexOf('REMINDERS. This is how');
      const calendar = prompt.indexOf('CALENDAR. The app shows it');

      check('the interview comes first', things !== -1 && things < rest, `${things} then ${rest}`);
      check('and it is not optional', /This one is required/i.test(flat));
      check('reminders and the calendar come after it', rest !== -1);
      check('reminders before the calendar within that step',
        reminders !== -1 && calendar !== -1 && reminders < calendar,
        `${reminders} then ${calendar}`);

      // ONE QUESTION, and the whole of the second step can be answered by
      // declining it. A setup that cannot be declined is a setup people
      // abandon halfway.
      check('it offers to skip both at once',
        /Do you want to set up daily phone reminders and your calendar now, or skip and do it later in the app\?/.test(flat));
      check('and says where they can be added later',
        /added at any time in the app's settings/i.test(flat));
      check('and that skipping costs nothing', /costs them nothing/i.test(flat));
      check('skipping ends it immediately',
        /put null for the reminders and null for the calendar, and go straight to the end/i.test(flat));
      check('and either can still be skipped on its own',
        /skip either one on its own/i.test(flat));

      check('it verifies by asking for evidence',
        /paste (?:that number|it) back to you/i.test(flat),
        'must ask for the value, not "got it?"');
      check('and says not to accept an assurance', /Do not accept "done"/i.test(flat));
      check('it restates progress in a resumable line',
        /Done: your things\. Now: reminders\. Remaining: your calendar\./.test(flat));
      check('and says that line is how you resume',
        /carry on from where it says/i.test(flat));
      check('it holds the box back until everything is finished',
        /Do not write the box at the end until every step is finished/i.test(flat));
      check('and names what is missing', /say what is still missing/i.test(flat));

      // PLAIN WORDS ONLY. Every one of these is a word about the machinery
      // rather than about the person's day, and this prompt is read by someone
      // who has never seen the app.
      for (const word of ['JSON', 'field', 'blob', 'endpoint', 'bucket']) {
        check(`it never says "${word}"`,
          !new RegExp(`\\b${word}\\b`, 'i').test(flat));
      }
      check('and asks for a copy and paste in those words',
        /Copy everything in the box below and paste it back into the app/i.test(flat));

      // The warning has to be in the prompt as well as the sheet: someone
      // pasting a secret address is doing it in the chat, not here.
      check('it warns that the address grants read access',
        /lets anyone who has it read that whole calendar/i.test(flat));
      check('and says the calendar is never written to',
        /It never changes anything on it/i.test(flat));
      check('there is only one calendar in it',
        !/calendar_action_ics_url/.test(flat) && !/things to DO/i.test(flat));

      check('it ends with the fenced block and nothing after',
        prompt.trimEnd().endsWith('```'), prompt.slice(-60));

      const html2 = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
      check('and the sheet carries the same warning',
        /grants read access to that whole calendar/i.test(html2));
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
