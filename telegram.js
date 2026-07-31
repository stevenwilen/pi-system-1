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

  // Telegram's own words. "chat not found" and "bot was blocked by the user"
  // are the two a person can actually act on, and paraphrasing them would cost
  // exactly the detail that makes them useful.
  return { error: result.body.description || `telegram returned ${result.status}` };
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
module.exports = { sendTelegram, sendToChat, toTelegramHtml };
