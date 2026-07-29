// After a full suite run: is the owner's notebook exactly as it was, and did
// the test user leave anything behind?
const H = require('./harness');

(async () => {
  console.log('the owner');
  for (const table of ['entries', 'plans', 'blocks', 'messages', 'api_usage', 'sent_log', 'profile']) {
    const { count } = await H.raw
      .from(table).select('*', { count: 'exact', head: true }).eq('user_id', H.REAL_USER_ID);
    console.log(`  ${table.padEnd(12)} ${count}`);
  }

  // The three live types. Everything else in the `type` check constraint is a
  // retired kind kept so old tombstones stay valid, and none of it should be
  // growing.
  const { data: live } = await H.raw
    .from('entries')
    .select('type, status')
    .eq('user_id', H.REAL_USER_ID)
    .eq('status', 'active');
  const counts = {};
  for (const r of live || []) counts[r.type] = (counts[r.type] || 0) + 1;
  console.log(
    `\n  active: ${Object.entries(counts).map(([t, n]) => `${n} ${t}`).join(', ') || 'none'}`
  );

  const { data: touched } = await H.raw
    .from('entries')
    .select('title, updated_at, created_at')
    .eq('user_id', H.REAL_USER_ID)
    .order('updated_at', { ascending: false })
    .limit(3);
  console.log('  most recently touched:');
  for (const r of touched) {
    const changed = r.updated_at.slice(0, 19) !== r.created_at.slice(0, 19);
    console.log(`    ${changed ? 'edited ' : 'as new '} ${r.updated_at.slice(11, 19)}  ${r.title.slice(0, 46)}`);
  }

  console.log('\nthe test user');
  let left = 0;
  for (const table of ['entries', 'plans', 'blocks', 'messages', 'api_usage', 'sent_log', 'profile']) {
    const { count } = await H.raw
      .from(table).select('*', { count: 'exact', head: true }).eq('user_id', H.TEST_USER_ID);
    if (count) console.log(`  ${table.padEnd(12)} ${count}`);
    left += count || 0;
  }
  console.log(left ? `  ${left} row(s) left behind, clearing` : '  nothing left behind');

  if (left) {
    await H.cleanup();
    let after = 0;
    for (const table of ['entries', 'plans', 'blocks', 'messages', 'api_usage', 'sent_log', 'profile']) {
      const { count } = await H.raw
        .from(table).select('*', { count: 'exact', head: true }).eq('user_id', H.TEST_USER_ID);
      after += count || 0;
    }
    console.log(`  after cleanup: ${after}`);
  }
})();
