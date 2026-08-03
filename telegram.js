// The messenger. Outbound only.
//
// It sends and it never listens. There is no webhook, no getUpdates polling,
// and no handling of incoming messages anywhere in this file or this project.
// Replies to the bot are ignored by design — all conversation happens in the
// app. Keep it that way.

require('dotenv').config();

// No client of its own. sendTelegram takes one, the same way tools.js and
// staleness.js do, and for a sharper reason here: this module is reachable
// from a route — the linking endpoint uses sendToChat — and a module a route
// can reach must not be holding the key that bypasses row level security.
// tests/service-key-check.js is what said so, on the first run after the
// endpoint existed.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Where the API lives. Overridable for one reason: so the suite can serve a
// stand-in and assert on what this file sends, without a test run being able
// to make a real phone buzz. Unset everywhere else, which is production.
const API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

// Telegram's HTML mode is used instead of MarkdownV2, which rejects
// unescaped '.', '-', '(', ')' and '!' — characters every schedule is full of.
//
// Escape all three HTML-special characters first, then put back only the two
// tags this system is allowed to use. A stray '<' in ordinary prose therefore
// renders literally instead of breaking the whole message.
//
// `pre` was on this list briefly, for a schedule message that used a monospace
// block to line its times into a column. That message is plain text now, so
// the tag came back off: an allowlist that grants more than anything asks for
// is the kind of thing nobody removes later.
//
// It is an allowlist and it has the allowlist's known consequence — a title
// containing the literal text "<b>" comes out bold. The failure is soft:
// Telegram rejects unbalanced tags, and the caller below resends the same text
// with no parse_mode at all.
function toTelegramHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
}

async function post(chat_id, text, parse_mode) {
  const payload = { chat_id, text };
  if (parse_mode) payload.parse_mode = parse_mode;

  const res = await fetch(`${API_BASE}/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.ok, status: res.status, body };
}

/**
 * Send to a chat this caller already has in hand.
 *
 * The difference from sendTelegram is one database read, and it is the reason
 * this exists: sendTelegram looks the chat up with the SERVICE client, which
 * throws inside a request by design. A route cannot call it.
 *
 * The linking endpoint has the chat_id — it is what the person just typed —
 * so there is nothing to look up, and the send is the whole point: a chat_id
 * that is well-formed and wrong looks identical to a correct one until 9am.
 */
async function sendToChat(chat_id, text) {
  if (!chat_id) return { error: 'chat_id is required' };
  if (!text) return { error: 'text is required' };
  if (!TOKEN) return { error: 'TELEGRAM_BOT_TOKEN is not set in .env' };

  let result;
  try {
    result = await post(chat_id, toTelegramHtml(text), 'HTML');
  } catch (err) {
    return { error: `could not reach telegram: ${err.message}` };
  }

  if (result.ok) return { sent: true, message_id: result.body.result.message_id };

  // Telegram's own words, kept verbatim. They are precise and they are what
  // you want in a log — but they are not instructions, which is what the
  // screen needs. `fixFor` below is that half. See routes/settings.js.
  return { error: result.body.description || `telegram returned ${result.status}` };
}

/**
 * Which bot this is, as @name.
 *
 * ASKED RATHER THAN CONFIGURED. A `TELEGRAM_BOT_USERNAME` in the environment
 * is one more thing to set and one more thing to set wrongly — and a name that
 * disagrees with the token would send people to press Start on the wrong bot,
 * which is exactly the failure this exists to explain.
 *
 * Once per process. It is asked when the setup screen is opened and when a send
 * fails, neither of which should pay for it twice, and it cannot change without
 * a new token.
 *
 * Null when it cannot be had. Every caller must read as "we do not know which
 * bot" rather than breaking: a setup screen that will not load because Telegram
 * is down is worse than one that says "the planner's bot".
 */
let botNamePromise = null;

function botName() {
  if (!TOKEN) return Promise.resolve(null);

  if (!botNamePromise) {
    botNamePromise = fetch(`${API_BASE}/bot${TOKEN}/getMe`, {
      signal: AbortSignal.timeout(4000),
    })
      .then((r) => r.json())
      .then((b) => (b && b.ok && b.result && b.result.username ? `@${b.result.username}` : null))
      .catch(() => null)
      // Not cached when it failed, so a Telegram outage does not leave this
      // process saying "the planner's bot" for ever.
      .then((name) => {
        if (!name) botNamePromise = null;
        return name;
      });
  }

  return botNamePromise;
}

/**
 * What to do about a failed send, in words a person can act on.
 *
 * THE COMMON ONE IS NOT WHAT IT LOOKS LIKE. "chat not found" reads as "your
 * number is wrong", and it usually means something else entirely: a Telegram
 * bot may not message anyone who has not pressed Start on it. Getting your id
 * from @userinfobot does not do that — @userinfobot is a different bot — so
 * every person who followed the instructions and stopped there got a saved
 * chat id and a message that never arrived.
 *
 * The instructions on the screen now say to start this bot first. This is the
 * other half: the person who has already hit it needs to be told why.
 *
 * Null for anything not recognised. A guess about an unknown failure is worse
 * than Telegram's own words, which the caller shows either way.
 */
function fixFor(error, name) {
  const said = String(error || '');
  const bot = name || 'the planner\'s bot';

  if (/chat not found|can'?t initiate conversation|user not found/i.test(said)) {
    return `Open ${bot} in Telegram and press Start, then save this again. A bot cannot message you until you have started it — the id from @userinfobot is not enough on its own. If you have started it, check the number.`;
  }

  if (/blocked by the user/i.test(said)) {
    return `${bot} is blocked in your Telegram. Unblock it and save this again.`;
  }

  if (/deactivated/i.test(said)) {
    return 'That Telegram account is deactivated.';
  }

  return null;
}

/**
 * Deliver one message to a user's linked Telegram chat.
 * A user with no linked chat is not an error — nothing is sent.
 */
async function sendTelegram(db, user_id, text) {
  if (!user_id) return { error: 'user_id is required' };
  if (!text) return { error: 'text is required' };
  if (!TOKEN) return { error: 'TELEGRAM_BOT_TOKEN is not set in .env' };

  const { data, error } = await db
    .from('profile')
    .select('telegram_chat_id')
    .eq('user_id', user_id)
    .maybeSingle();

  if (error) return { error: `could not read profile: ${error.message}` };

  // No profile row, or no chat linked. Return quietly.
  if (!data || !data.telegram_chat_id) {
    return { skipped: 'no telegram_chat_id for this user' };
  }

  const chat_id = data.telegram_chat_id;

  let result;
  try {
    result = await post(chat_id, toTelegramHtml(text), 'HTML');
  } catch (err) {
    return { error: `could not reach telegram: ${err.message}` };
  }

  if (result.ok) {
    return { sent: true, message_id: result.body.result.message_id };
  }

  const description =
    result.body.description || `telegram returned ${result.status}`;

  // A formatting mistake must never cost the message. Show exactly what broke,
  // then send the same text again with no parse_mode at all.
  if (/parse|entit/i.test(description)) {
    console.error(`[TELEGRAM] HTML parse error: ${description}`);
    console.error(`[TELEGRAM] raw text was:\n${text}`);

    try {
      const retry = await post(chat_id, text, null);
      if (retry.ok) {
        console.error('[TELEGRAM] resent as plain text');
        return {
          sent: true,
          message_id: retry.body.result.message_id,
          degraded: 'html parse failed, sent as plain text',
        };
      }
      return {
        error: retry.body.description || `telegram returned ${retry.status}`,
      };
    } catch (err) {
      return { error: `could not reach telegram: ${err.message}` };
    }
  }

  return { error: description };
}

// toTelegramHtml is exported for one reason: it is the only place tags are
// allowed back in after escaping, and that allowlist is worth a test rather
// than a reading. Nothing in production imports it.
module.exports = { sendTelegram, sendToChat, toTelegramHtml, botName, fixFor };
