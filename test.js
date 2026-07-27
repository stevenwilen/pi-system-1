// Walks the four tools end to end against a fake user.
// Run: node test.js

const {
  search_entries,
  create_entry,
  update_entry,
} = require('./tools');

const USER_ID = '00000000-0000-0000-0000-000000000001';

function show(step, result) {
  console.log(`\n--- ${step} ---`);
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  console.log(`user_id: ${USER_ID}`);

  // 1. A project, with its why. There is no priority any more: the position
  // in the stale list is the ranking.
  const project = await create_entry(USER_ID, {
    type: 'project',
    title: 'Web services business',
    body: 'Build and sell web services to small businesses.',
    why: 'I want income that does not depend on having a job.',
  });
  show('1. create_entry — project', project);

  // 2. A habit.
  const habit = await create_entry(USER_ID, {
    type: 'habit',
    title: 'Morning walk',
    body: 'Thirty minutes outside before the first work block.',
    frequency: 'daily',
  });
  show('2. create_entry — habit', habit);

  // 3. Both should be here.
  show('3. search_entries — all', await search_entries(USER_ID));

  // 4. Soft-delete the habit.
  if (habit.error) {
    show('4. update_entry — soft-delete habit', {
      error: 'skipped, habit was not created',
    });
  } else {
    show(
      '4. update_entry — soft-delete habit',
      await update_entry(USER_ID, habit.id, { status: 'deleted' })
    );
  }

  // 5. Only the project should remain.
  show('5. search_entries — all', await search_entries(USER_ID));
}

main().catch((err) => {
  console.error('\nfailed:', err);
  process.exit(1);
});
