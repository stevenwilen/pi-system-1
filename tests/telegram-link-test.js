// Linking a Telegram chat, and what happens to someone who never does.
//
// One bot for everyone: the token is a fact about the deployment. Only the
// chat_id is per person, and it is the thing this suite is about.
//
// NOTHING REAL IS SENT. Telegram's API is served locally and the sender is
// pointed at it, so a run cannot make a stranger's phone buzz — and the suite
// can answer the question that matters, which is what the endpoint does when
// Telegram says no.

const H = require('./harness');
const ROOT = H.ROOT;
process.chdir(ROOT);

const http = require('http');

const PORT = 3588;
const BASE = `http://127.0.0.1:${PORT}`;
const TG_PORT = 3589;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Every sendMessage the server made, and what the fake Telegram answered.
const sent = [];

// Chat ids this stand-in refuses, the way Telegram refuses one that does not
// exist. Everything else is accepted.
const REFUSE = new Set(['999999999']);

let tg;

async function chatIdOf(which) {
  const accounts = await H.setup();
  const { data } = await H.service
    .from('profile')
    .select('telegram_chat_id')
    .eq('user_id', accounts[which].id)
    .maybeSingle();
  return data ? data.telegram_chat_id : undefined;
}

(async () => {
  const { a: A, b: B } = await H.setup();
  await H.assertGuarded();
  await H.cleanup();
  await H.ensureProfile(undefined, undefined, 'a');
  await H.ensureProfile(undefined, undefined, 'b');

  // A stand-in for api.telegram.org. Accepts any bot token in the path.
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
        return res.end(JSON.stringify({
          ok: false, error_code: 400, description: 'Bad Request: chat not found',
        }));
      }
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise((r) => tg.listen(TG_PORT, r));
  tg.unref();

  const server = H.spawnServer(PORT, {
    TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    TELEGRAM_BOT_TOKEN: 'test-token',
  });
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  const asA = H.as(A);
  const asB = H.as(B);
  const post = (as, path, body) =>
    as(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  try {
    console.log('1. linking a chat proves itself');
    {
      sent.length = 0;
      const res = await post(asA, '/telegram', { chat_id: '8906223785' });
      const body = await res.json();

      check('it is accepted', res.status === 200, String(res.status));
      // MASKED ON THE WAY BACK, like everything else the settings route
      // reports. The caller just typed it, so echoing it leaks nothing new —
      // but the sheet renders whatever comes back, and a screen that prints a
      // whole chat id is one screenshot away from someone else's bot.
      check('and reports which chat, without printing it', body.chat_id === '…3785',
        JSON.stringify(body));
      check('and that the message arrived', body.delivered === true, JSON.stringify(body));

      // THE POINT OF THE WHOLE ENDPOINT. A chat id is a number and every typo
      // is a well-formed one, so a link that is merely saved tells you nothing
      // until nine the next morning.
      check('a message really went out', sent.length === 1, JSON.stringify(sent));
      check('to the chat that was just linked', sent[0].chat_id === '8906223785',
        String(sent[0].chat_id));

      check('and the row holds it', (await chatIdOf('a')) === '8906223785',
        String(await chatIdOf('a')));
    }

    console.log('\n2. a chat Telegram refuses is saved AND reported');
    {
      sent.length = 0;
      const res = await post(asA, '/telegram', { chat_id: '999999999' });
      const body = await res.json();

      check('the request itself succeeds', res.status === 200, String(res.status));
      check('but it says the message did not arrive', body.delivered === false,
        JSON.stringify(body));
      check('in Telegram\'s own words', /chat not found/i.test(body.error || ''), body.error);

      // SAVED ANYWAY, and deliberately. The other order — send first, save only
      // on success — leaves someone whose test message arrived but whose row
      // was never written with a bot that answers once and then goes quiet.
      check('the row was still written', (await chatIdOf('a')) === '999999999',
        String(await chatIdOf('a')));

      // AND IT SAYS WHAT TO DO, which Telegram's words do not.
      //
      // THE BUG THIS EXISTS FOR reached the second person who ever used this
      // app. A Telegram bot may not message anyone who has not pressed Start on
      // it; the id comes from @userinfobot, which is a DIFFERENT bot, so
      // following the instructions exactly ended in a saved chat id and
      // "Bad Request: chat not found" — a sentence that reads as "your number
      // is wrong" and gave no reason to suspect the real cause.
      check('it says what to do about it', Boolean(body.fix), JSON.stringify(body));
      check('naming the bot to press Start on', /@pisuite_bot/.test(body.fix || ''),
        body.fix);
      check('and saying why the id alone was not enough',
        /press Start/i.test(body.fix || '') && /@userinfobot/.test(body.fix || ''),
        body.fix);
      // Kept as well as translated. They are exact, and they are what you want
      // in a log — the screen shows both.
      check("Telegram's own words survive alongside it",
        /chat not found/i.test(body.error || ''), body.error);
    }

    console.log('\n2b. a failure nobody has a fix for is not guessed at');
    {
      // A blocked bot is a different instruction, and anything unrecognised
      // gets none at all: a guess about an unknown failure is worse than
      // Telegram's own words, which go out either way.
      const { fixFor } = require(ROOT + '/telegram.js');

      check('a blocked bot says to unblock it',
        /[Uu]nblock/.test(fixFor('Forbidden: bot was blocked by the user', '@x') || ''),
        fixFor('Forbidden: bot was blocked by the user', '@x'));
      check('a bot that cannot start the conversation gets the Start advice',
        /press Start/i.test(fixFor("Forbidden: bot can't initiate conversation with a user", '@x') || ''));
      check('and something nobody has seen before gets no advice at all',
        fixFor('Bad Request: some new thing', '@x') === null,
        String(fixFor('Bad Request: some new thing', '@x')));
      // The screen still has to read as a sentence when the bot cannot be
      // named, which is what a Telegram outage looks like.
      check('with no bot name it still reads as English',
        /the planner's bot/.test(fixFor('Bad Request: chat not found', null) || ''),
        fixFor('Bad Request: chat not found', null));
    }

    console.log('\n3. what is not a chat id');
    {
      for (const [what, chat_id] of [
        ['a name', '@steve'],
        ['a phone number with punctuation', '+1 555 0100'],
        ['nothing at all', ''],
        ['something enormous', '1'.repeat(30)],
      ]) {
        const res = await post(asA, '/telegram', { chat_id });
        check(`${what} is refused`, res.status === 400, String(res.status));
      }

      // Negative ids are groups and channels, and they are real.
      const group = await post(asA, '/telegram', { chat_id: '-1001234567890' });
      check('a group id is accepted', group.status === 200, String(group.status));
    }

    console.log('\n4. clearing');
    {
      sent.length = 0;
      const res = await post(asA, '/telegram/clear');
      const body = await res.json();

      check('it clears', res.status === 200 && body.cleared === true, JSON.stringify(body));
      check('the row is empty', (await chatIdOf('a')) === null, String(await chatIdOf('a')));
      check('and nothing was sent', sent.length === 0, JSON.stringify(sent));

      // Clearing twice is not an error. Nobody should have to check first.
      const again = await post(asA, '/telegram/clear');
      check('clearing again is fine', again.status === 200, String(again.status));
    }

    console.log('\n5. one bot, and only the chat is per person');
    {
      await post(asA, '/telegram', { chat_id: '111111111' });
      await post(asB, '/telegram', { chat_id: '222222222' });

      check('A has their own chat', (await chatIdOf('a')) === '111111111');
      check('B has their own', (await chatIdOf('b')) === '222222222');

      // A cannot link a chat onto B. There is no route that takes a user id —
      // the endpoint writes to whoever the token says and nothing else.
      sent.length = 0;
      await post(asA, '/telegram', { chat_id: '333333333' });
      check("A's link moved A's row", (await chatIdOf('a')) === '333333333');
      check("and left B's alone", (await chatIdOf('b')) === '222222222',
        String(await chatIdOf('b')));

      // routes/settings.js now. The linking endpoints moved there when the setup
      // sheet arrived: one file for everything that sheet writes.
      const src = require('fs').readFileSync(ROOT + '/routes/settings.js', 'utf8');
      check('the token is not per user', !/telegram_bot_token/i.test(src));
      check('and the route names no user but the caller',
        !/req\.body[^\n]*user/i.test(src));
    }

    console.log('\n6. a request with no token cannot link anything');
    {
      const res = await fetch(`${BASE}/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: '444444444' }),
      });
      check('it is refused', res.status === 401, String(res.status));
      check('and nothing changed', (await chatIdOf('a')) === '333333333',
        String(await chatIdOf('a')));
    }
  } finally {
    server.kill();
    tg.closeAllConnections();
    tg.close();
    await H.cleanup();
  }

  console.log(bad === 0 ? '\nLinking holds' : `\n${bad} FAILURE(S)`);
  process.exitCode = bad === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('harness error:', e.message, '\n', (e.stack || '').split('\n').slice(0, 6).join('\n'));
  if (tg) { tg.closeAllConnections(); tg.close(); }
  process.exitCode = 1;
});
