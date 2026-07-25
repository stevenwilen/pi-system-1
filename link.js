// One-time: connect a Telegram chat to the account.
// Run: node link.js <chat_id>

require('dotenv').config();

const supabase = require('./db');

const USER_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  const chatId = (process.argv[2] || '').trim();

  if (!chatId) {
    console.error('usage: node link.js <chat_id>');
    console.error('find your chat_id by messaging @userinfobot on Telegram');
    process.exit(1);
  }

  // Personal chats are positive, groups and channels negative.
  if (!/^-?\d+$/.test(chatId)) {
    console.error(`not a numeric chat_id: ${chatId}`);
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('profile')
    .upsert(
      { user_id: USER_ID, telegram_chat_id: chatId },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) {
    console.error(`failed: ${error.message}`);
    process.exit(1);
  }

  console.log('linked');
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
