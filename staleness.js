// How long since something was last actually done.
//
// Shared by the stale panel and by block message generation. They ask the same
// question and must not answer it differently, which is what two copies of
// this query would eventually do.

// No client of its own, deliberately. Whoever calls this hands one over, so a
// route asks with the caller's connection and the scheduler asks with the
// service key — the same question, asked as two different people. A module
// that imported its own client could only ever be one of them, and it would be
// the one that bypasses row level security.

/**
 * entry_id -> the most recent plan date it was done on.
 *
 * **A block that stayed in the plan counts.** Saying something did not happen
 * is taking its block out of the day, so the blocks that are left are the ones
 * that stand — there is nothing else to filter on and nothing to correct after
 * the fact.
 *
 * The `completed` filter below is therefore inert, and kept on purpose. The
 * column still exists and still defaults to true, so every row passes it; there
 * used to be a screen that set it to false, and if anything ever sets it again
 * this query already means the right thing. Removing the filter would be a
 * second change to make later, in the place hardest to notice it was needed.
 *
 * `excludePlanId` matters more than it looks. At confirm time the plan has
 * already been written, so including it would report every entry as scheduled
 * today and every message would claim zero days. The caller generating
 * messages for a plan must exclude that plan.
 */
async function lastScheduled(db, user_id, { excludePlanId = null } = {}) {
  const { data: blocks, error: blockErr } = await db
    .from('blocks')
    .select('entry_id, plan_id')
    .eq('user_id', user_id)
    .not('entry_id', 'is', null)
    .eq('completed', true);

  if (blockErr) throw new Error(`could not read blocks: ${blockErr.message}`);
  if (!blocks || !blocks.length) return new Map();

  const { data: plans, error: planErr } = await db
    .from('plans')
    .select('id, date')
    .eq('user_id', user_id);

  if (planErr) throw new Error(`could not read plans: ${planErr.message}`);

  const dateOf = new Map((plans || []).map((p) => [p.id, p.date]));
  const latest = new Map();

  for (const b of blocks) {
    if (excludePlanId && b.plan_id === excludePlanId) continue;
    const date = dateOf.get(b.plan_id);
    if (!date) continue;
    const seen = latest.get(b.entry_id);
    if (!seen || date > seen) latest.set(b.entry_id, date);
  }

  return latest;
}

const daysBetween = (from, to) =>
  Math.round(
    (new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000
  );

module.exports = { lastScheduled, daysBetween };
