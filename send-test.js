// Confirm a message actually lands in Telegram.
// Run: node send-test.js <user_id>
//
// The user is an argument now. It used to be a constant in this file, back
// when there was one account and its id was a fact about the system rather
// than about a person. Sign-in decides who exists; a utility cannot know.

const { sendTelegram } = require('./telegram');
const { service } = require('./db');

async function main() {
  const userId = (process.argv[2] || '').trim();
  if (!userId) {
    console.error('usage: node send-test.js <user_id>');
    process.exit(1);
  }

  const result = await sendTelegram(service, userId, 'Test from your system');
  console.log(JSON.stringify(result, null, 2));

  if (result.skipped) {
    console.log('\nNo chat linked yet. Link one from the app: POST /telegram');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
