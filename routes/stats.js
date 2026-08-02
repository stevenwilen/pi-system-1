// Where the time went.
//
// Arithmetic on blocks that were actually scheduled, and nothing else. This
// does not know whether any of it happened — the system is never told that —
// so every number here is about what was PLANNED. Saying "you spent" would be
// claiming something no row supports; saying "you gave 4 hours to" is what the
// rows say, because a block that stayed in a confirmed day is time set aside.
//
// THIRTY DAYS, not all time. All time is the honest default at four days of
// history and the wrong one at four hundred, when it becomes a number that
// only ever grows and stops describing this month. The window is stated on
// screen so the figure is never read as more than it is.

const express = require('express');

const { todayIn } = require('../clock');

const router = express.Router();

const WINDOW_DAYS = 30;

// The five biggest. A list of everything would be the Things list again, in a
// different order, and the question this section answers is what took the time
// rather than what exists.
const TOP = 5;

const backFrom = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

router.get('/stats', async (req, res) => {
  const { db, userId } = req.auth;

  try {
    const { data: profile } = await db
      .from('profile')
      .select('timezone')
      .eq('user_id', userId)
      .maybeSingle();

    const today = todayIn((profile && profile.timezone) || 'UTC');
    const from = backFrom(today, WINDOW_DAYS);

    const { data: plans, error: planErr } = await db
      .from('plans')
      .select('id, date')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .gte('date', from)
      .lte('date', today);

    if (planErr) throw new Error(planErr.message);

    // Nothing planned is not zero hours, it is no answer yet, and the screen
    // says something different for each.
    if (!plans || !plans.length) {
      return res.json({ window_days: WINDOW_DAYS, days: 0, blocks: 0, minutes: 0, by_kind: [], top: [] });
    }

    const ids = plans.map((p) => p.id);

    const { data: blocks, error: blockErr } = await db
      .from('blocks')
      .select('entry_id, duration_minutes')
      .eq('user_id', userId)
      .in('plan_id', ids);

    if (blockErr) throw new Error(blockErr.message);

    // Every kind, including the ones that were deleted or finished since. The
    // hours were still given, and dropping them would make the parts stop
    // adding up to the whole.
    const { data: entries, error: entryErr } = await db
      .from('entries')
      .select('id, type, title')
      .eq('user_id', userId);

    if (entryErr) throw new Error(entryErr.message);

    const of = new Map((entries || []).map((e) => [e.id, e]));

    const kinds = { habit: 0, project: 0, task: 0, untagged: 0 };
    const perThing = new Map();
    let minutes = 0;

    for (const b of blocks || []) {
      const mins = b.duration_minutes || 0;
      minutes += mins;

      const entry = b.entry_id ? of.get(b.entry_id) : null;

      // A block typed straight into the day belongs to nothing in the list.
      // It is counted, and counted separately: the difference between planned
      // hours and hours against a thing is worth being able to see.
      if (!entry) {
        kinds.untagged += mins;
        continue;
      }

      if (kinds[entry.type] === undefined) kinds[entry.type] = 0;
      kinds[entry.type] += mins;
      perThing.set(entry.title, (perThing.get(entry.title) || 0) + mins);
    }

    res.json({
      window_days: WINDOW_DAYS,
      days: plans.length,
      blocks: (blocks || []).length,
      minutes,
      // Sorted here so the screen renders what it is given. Zero-minute kinds
      // are dropped: a bar of nothing is a row that says nothing.
      by_kind: Object.entries(kinds)
        .filter(([, m]) => m > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([kind, m]) => ({ kind, minutes: m })),
      top: [...perThing.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP)
        .map(([title, m]) => ({ title, minutes: m })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
