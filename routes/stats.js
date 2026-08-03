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

const { todayIn, DEFAULT_ZONE } = require('../clock');

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

    const today = todayIn((profile && profile.timezone) || DEFAULT_ZONE);
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
      .in('plan_id', ids)
      // Untimed items are left out, and the section's own name is the reason:
      // this answers where the time went, and an item committed to a day
      // without an hour took no measured time. Counting it would add a row to
      // the block count and nothing to the hours, which is a figure that only
      // ever makes the average per day look smaller.
      .not('start_time', 'is', null);

    if (blockErr) throw new Error(blockErr.message);

    // Every status, including deleted and finished. The hours were still given
    // to it, and a project that got twelve hours and was then finished should
    // not vanish out of the month it took.
    const { data: entries, error: entryErr } = await db
      .from('entries')
      .select('id, type, title')
      .eq('user_id', userId);

    if (entryErr) throw new Error(entryErr.message);

    const of = new Map((entries || []).map((e) => [e.id, e]));

    const kinds = { habit: 0, project: 0, task: 0 };
    const perThing = new Map();
    let minutes = 0;
    let counted = 0;

    for (const b of blocks || []) {
      const entry = b.entry_id ? of.get(b.entry_id) : null;

      // A BLOCK TIED TO NOTHING IS NOT COUNTED AT ALL. It was shown for a
      // while as its own share, on the grounds that the parts should add up to
      // the planned total. But this section answers "what did I give my time
      // to", and a block typed straight into a day answers it with nothing —
      // so including those hours only inflated a figure about things in the
      // list with hours that were not about them.
      //
      // The total is therefore hours on your things, not hours planned, and
      // the screen says so.
      if (!entry) continue;

      const mins = b.duration_minutes || 0;
      minutes += mins;
      counted += 1;

      if (kinds[entry.type] === undefined) kinds[entry.type] = 0;
      kinds[entry.type] += mins;
      perThing.set(entry.title, (perThing.get(entry.title) || 0) + mins);
    }

    res.json({
      window_days: WINDOW_DAYS,
      days: plans.length,
      // Blocks that count, which is blocks tied to something in the list.
      blocks: counted,
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
