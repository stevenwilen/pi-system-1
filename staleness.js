// How long since something was last actually done.
//
// Shared by the stale panel and by block message generation. They ask the same
// question and must not answer it differently, which is what two copies of
// this query would eventually do.

const supabase = require('./db');

/**
 * entry_id -> the most recent plan date it was done on.
 *
 * **A block that was missed does not count.** This used to count any block at
 * all, which meant planning something and not doing it reset its clock exactly
 * as much as doing it did: something dodged four weeks running read as fresh
 * every Monday, and the panel, the temperature bar, the cold verdict and the
 * evening nudge all inherited that, because all four read this map.
 *
 * The number claims to say how long something has been neglected. Counting the
 * writing-down rather than the doing made it say how long since it was last
 * mentioned, and those two agree right up until the moment someone skips
 * something, which is exactly when it needs to be right.
 *
 * `completed` defaults to true — a day is assumed to have gone as planned and
 * the review only corrects it (SPEC 3.5) — so this excludes what was explicitly
 * marked missed and nothing else. A block in a plan nobody has reviewed yet
 * still counts, which is the same assumption the review screen makes.
 *
 * `excludePlanId` matters more than it looks. At confirm time the plan has
 * already been written, so including it would report every entry as scheduled
 * today and every message would claim zero days. The caller generating
 * messages for a plan must exclude that plan.
 */
async function lastScheduled(user_id, { excludePlanId = null } = {}) {
  const { data: blocks, error: blockErr } = await supabase
    .from('blocks')
    .select('entry_id, plan_id')
    .eq('user_id', user_id)
    .not('entry_id', 'is', null)
    .eq('completed', true);

  if (blockErr) throw new Error(`could not read blocks: ${blockErr.message}`);
  if (!blocks || !blocks.length) return new Map();

  const { data: plans, error: planErr } = await supabase
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
