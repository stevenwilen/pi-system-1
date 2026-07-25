// Confirm a message actually lands in Telegram.
// Run: node send-test.js

const { sendTelegram } = require('./telegram');

const USER_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  const result = await sendTelegram(USER_ID, 'Test from your system');
  console.log(JSON.stringify(result, null, 2));

  if (result.skipped) {
    console.log('\nNo chat linked yet. Run: node link.js <chat_id>');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
