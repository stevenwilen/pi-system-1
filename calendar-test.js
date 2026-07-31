// Print a day's calendar events, to confirm the ICS feed is being read.
// Run: node calendar-test.js <user_id>            (today)
//      node calendar-test.js <user_id> 2026-07-28 (a specific date)
//
// The user is an argument now. It used to be a constant in this file, back
// when there was one account and its id was a fact about the system rather
// than about a person. Sign-in decides who exists; a utility cannot know.
//
// The service client, because this is a command line utility with no caller
// to be. Nothing that serves a request may hold it.

const { get_calendar } = require('./tools');
const { service } = require('./db');

async function main() {
  const userId = (process.argv[2] || '').trim();
  if (!userId) {
    console.error('usage: node calendar-test.js <user_id> [date]');
    process.exit(1);
  }
  const date = process.argv[3] || new Date().toISOString().slice(0, 10);

  const events = await get_calendar(service, userId, date);
  console.log(`${date} — ${events.length} event(s)\n`);
  console.log(JSON.stringify(events, null, 2));

  if (events.length === 0) {
    console.log(
      '\nEmpty means either no events that day, or the feed could not be read.'
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
