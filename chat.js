// Talk to the brain from the terminal, before any app exists.
// Run: node chat.js

const readline = require('readline');
const { runBrain } = require('./brain');

const USER_ID = '00000000-0000-0000-0000-000000000001';

// The whole conversation, held here in the client. The brain is given it on
// every call and keeps none of it.
const history = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function main() {
  console.log(`user_id: ${USER_ID}`);
  console.log('type your message, or "exit" to quit\n');
  process.stdout.write('you > ');

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      process.stdout.write('you > ');
      continue;
    }
    if (input === 'exit' || input === 'quit') break;

    try {
      const reply = await runBrain(USER_ID, input, history);
      history.push({ role: 'user', content: input });
      history.push({ role: 'assistant', content: reply });
      console.log(`\nbrain > ${reply}\n`);
    } catch (err) {
      console.error(`\nfailed: ${err.message}\n`);
    }

    process.stdout.write('you > ');
  }

  rl.close();
  console.log('bye');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
