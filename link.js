// One-time: connect a Telegram chat to an account.
// Run: node link.js <user_id> <chat_id>
//
// The user is an argument now. It used to be a constant in this file, back
// when there was one account and its id was a fact about the system rather
// than about a person. Sign-in decides who exists; a utility cannot know.

require('dotenv').config();

const { service: supabase } = require('./db');

async function main() {
  const userId = (process.argv[2] || '').trim();
  const chatId = (process.argv[3] || '').trim();

  if (!userId || !chatId) {
    console.error('usage: node link.js <user_id> <chat_id>');
    console.error('find your user_id in Supabase under Authentication > Users');
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
      { user_id: userId, telegram_chat_id: chatId },
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
