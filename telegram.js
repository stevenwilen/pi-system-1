// The messenger. Outbound only.
//
// It sends and it never listens. There is no webhook, no getUpdates polling,
// and no handling of incoming messages anywhere in this file or this project.
// Replies to the bot are ignored by design — all conversation happens in the
// app. Keep it that way.

require('dotenv').config();

const supabase = require('./db');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.ok, status: res.status, body };
}

/**
 * Deliver one message to a user's linked Telegram chat.
 * A user with no linked chat is not an error — nothing is sent.
 */
async function sendTelegram(user_id, text) {
  if (!user_id) return { error: 'user_id is required' };
  if (!text) return { error: 'text is required' };
  if (!TOKEN) return { error: 'TELEGRAM_BOT_TOKEN is not set in .env' };

  const { data, error } = await supabase
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
module.exports = { sendTelegram, toTelegramHtml };
