// Print today's calendar events, to confirm the ICS feed is being read.
// Run: node calendar-test.js            (today)
//      node calendar-test.js 2026-07-28 (a specific date)

const { get_calendar } = require('./tools');

const USER_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);

  const events = await get_calendar(USER_ID, date);
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
