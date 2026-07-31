// After a full suite run: is everyone else's notebook exactly as it was, and
// did the test accounts leave anything behind?
//
// IT USED TO NAME THE OWNER. There was one real user with a fixed id, and this
// counted their rows. That id belongs to nobody now — identity comes from a
// verified token, and the owner is an auth account like any other — so the
// question is asked the other way round: everyone who is NOT a test account is
// somebody this suite must not have touched, whoever they turn out to be.
//
// That is the stronger form anyway. The old version watched one id and would
// have said nothing at all about damage done to a second person's rows.

const H = require('./harness');

const TABLES = ['entries', 'plans', 'blocks', 'messages', 'api_usage', 'sent_log', 'profile'];

/** Every row of a table, grouped by who owns it. */
async function ownership(table) {
  const { data, error } = await H.service.from(table).select('user_id');
  if (error) return { error: error.message, by: {} };
  const by = {};
  for (const r of data || []) by[r.user_id] = (by[r.user_id] || 0) + 1;
  return { by };
}

(async () => {
  const accounts = await H.setup();
  const mine = new Set(Object.values(accounts).map((a) => a.id));

  console.log('everyone else');
  let outsiders = 0;
  for (const table of TABLES) {
    const { by, error } = await ownership(table);
    if (error) {
      console.log(`  ${table.padEnd(12)} unreadable: ${error}`);
      continue;
    }
    const theirs = Object.entries(by).filter(([id]) => !mine.has(id));
    const total = theirs.reduce((n, [, c]) => n + c, 0);
    outsiders += total;
    console.log(`  ${table.padEnd(12)} ${total} row(s) across ${theirs.length} account(s)`);
  }
  console.log(`\n  ${outsiders} row(s) belong to someone who is not a test account.`);

  // The most recently edited rows that are not ours. A suite that reached
  // across would surface here as something touched during the run.
  const { data: recent } = await H.service
    .from('entries')
    .select('title, user_id, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(20);

  const theirs = (recent || []).filter((r) => !mine.has(r.user_id)).slice(0, 3);
  if (theirs.length) {
    console.log('\n  most recently touched, not ours:');
    for (const r of theirs) {
      const changed = r.updated_at.slice(0, 19) !== r.created_at.slice(0, 19);
      console.log(
        `    ${changed ? 'edited ' : 'as new '} ${r.updated_at.slice(0, 19).replace('T', ' ')}  ${String(r.title).slice(0, 40)}`
      );
    }
  }

  console.log('\nthe test accounts');
  let left = 0;
  for (const table of TABLES) {
    const { by } = await ownership(table);
    const ours = Object.entries(by).filter(([id]) => mine.has(id));
    const total = ours.reduce((n, [, c]) => n + c, 0);
    if (total) console.log(`  ${table.padEnd(12)} ${total}`);
    left += total;
  }
  console.log(left ? `  ${left} row(s) left behind, clearing` : '  nothing left behind');

  if (left) {
    await H.cleanup();
    let after = 0;
    for (const table of TABLES) {
      const { by } = await ownership(table);
      after += Object.entries(by)
        .filter(([id]) => mine.has(id))
        .reduce((n, [, c]) => n + c, 0);
    }
    console.log(`  after cleanup: ${after}`);
  }
})();
