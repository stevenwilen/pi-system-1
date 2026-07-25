// The messenger. Outbound only.
//
// It sends and it never listens. There is no webhook, no getUpdates polling,
// and no handling of incoming messages anywhere in this file or this project.
// Replies to the bot are ignored by design — all conversation happens in the
// app. Keep it that way.

require('dotenv').config();

const supabase = require('./db');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: data.telegram_chat_id,
        // Sent as plain text on purpose. Telegram's MarkdownV2 rejects
        // unescaped '.', '-', '!' and friends, which ordinary prose is full
        // of — a parse_mode here would turn normal sentences into 400s.
        text,
      }),
    });
  } catch (err) {
    return { error: `could not reach telegram: ${err.message}` };
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.ok) {
    return { error: body.description || `telegram returned ${res.status}` };
  }

  return { sent: true, message_id: body.result.message_id };
}

module.exports = { sendTelegram };
