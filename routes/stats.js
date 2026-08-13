// How long since you got to each habit, against how often you meant to.
//
// Arithmetic on what was scheduled, and nothing else. This is never told that
// anything happened — an untimed item ticked off is the one exception — so
// every figure here is about what was PLANNED, and the words on screen say so.
//
// IT COUNTED HOURS ONCE, then ratios, and both were wrong in the same way: they
// presented thin data as though it were a trend. Hours stopped describing the
// app the day untimed items arrived. The ratios that replaced them — 0/1, 2/7,
// 2/3 — could not be compared down the column, because every row had a
// different denominator and the eye has nothing to rest on.
//
// What is left is one number per habit that means the same thing on every row:
// DAYS SINCE, beside the cadence it was meant to keep. Those two can be read
// against each other without arithmetic, and sorted by how far past its own
// frequency each one is.
//
// THIRTY DAYS, not all time. All time is the honest default at four days of
// history and the wrong one at four hundred, when it becomes a number that only
// ever grows and stops describing this month. The window is stated on screen so
// the figure is never read as more than it is.

const express = require('express');

const { todayIn, DEFAULT_ZONE } = require('../clock');
const { daysBetween } = require('../staleness');
const { CADENCE_DAYS } = require('../warning');

const router = express.Router();

const WINDOW_DAYS = 30;

/**
 * Below this, the window has not got enough in it to describe anything.
 *
 * Five days out of thirty is not a habit that is slipping, it is a month that
 * was barely planned — and a screen that ranked habits off it would be dressing
 * up a sample of five as a verdict. It says so instead.
 */
const THIN_DAYS = 10;

/**
 * How many days a cadence allows to pass before it has been missed.
 *
 * THE SAME TABLE THE MARKS ARE MADE OF, imported rather than repeated. It was
 * written out again here, which is the kind of second copy this codebase warns
 * about everywhere else: the two agreed for as long as nobody touched either,
 * and the moment 'monthly' was retired from one they would have disagreed about
 * what a monthly habit even is — this panel still ranking rows by a cadence the
 * rest of the system no longer offers.
 *
 * A ONE-OFF IS ABSENT FROM IT, and the filter below turns that into the right
 * behaviour for free: this panel is about rhythms being kept, and a thing that
 * happens once has no rhythm to keep.
 */
const EVERY = CADENCE_DAYS;

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

    const { data: entries, error: entryErr } = await db
      .from('entries')
      .select('id, type, title, frequency, status, created_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .eq('type', 'habit')
      // A HABIT SET DOWN ON PURPOSE IS NOT ONE YOU ARE BEHIND ON. Saved for
      // later means still cared about and not now, so reporting it as weeks
      // past its cadence would be the screen arguing with a decision the
      // person made deliberately.
      .is('paused_at', null);

    if (entryErr) throw new Error(entryErr.message);

    const { data: plans, error: planErr } = await db
      .from('plans')
      .select('id, date')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .gte('date', from)
      .lte('date', today);

    if (planErr) throw new Error(planErr.message);

    const days = (plans || []).length;

    // THE HEADLINE FIRST, AND IT EXPLAINS EVERYTHING UNDER IT. How much of the
    // month was planned at all is the fact the rest depends on, so it is not a
    // footnote — and when it is small the screen says less rather than ranking
    // habits off five days of history.
    const base = { window_days: WINDOW_DAYS, days, thin: days < THIN_DAYS, habits: [] };

    if (!days) return res.json(base);

    const dateOf = new Map(plans.map((p) => [p.id, p.date]));

    const { data: blocks, error: blockErr } = await db
      .from('blocks')
      .select('entry_id, plan_id, completed')
      .eq('user_id', userId)
      .in('plan_id', plans.map((p) => p.id))
      .not('entry_id', 'is', null)
      // THE SAME FILTER STALENESS USES. A timed block is true because it stayed
      // in the day; an untimed item is true only once it has been ticked.
      // Counting them differently here would let two screens disagree about
      // whether you got to something.
      .eq('completed', true);

    if (blockErr) throw new Error(blockErr.message);

    // The most recent day each thing was got to, inside the window.
    const lastOf = new Map();
    for (const b of blocks || []) {
      const date = dateOf.get(b.plan_id);
      if (!date) continue;
      const seen = lastOf.get(b.entry_id);
      if (!seen || date > seen) lastOf.set(b.entry_id, date);
    }

    const habits = (entries || [])
      .filter((e) => EVERY[e.frequency])
      .map((e) => {
        const last = lastOf.get(e.id) || null;

        // NEVER LONGER THAN IT HAS EXISTED. A habit added five days ago has not
        // been neglected for thirty, and reporting that would be the first
        // thing a new one ever said about itself.
        const since = last
          ? daysBetween(last, today)
          : Math.min(WINDOW_DAYS, daysBetween(String(e.created_at).slice(0, 10), today));

        const every = EVERY[e.frequency];

        return {
          title: e.title,
          frequency: e.frequency,
          days: Math.max(0, since),
          // Whether it has been seen at all in the window, so the screen can
          // say "not in the last 30 days" rather than a number that reads as a
          // measurement when it is really a floor.
          ever: Boolean(last),
          // How far past its own cadence it is. This is what the order is made
          // of, and it is the only figure here that compares two habits with
          // different frequencies on the same scale: days late, not a ratio.
          over: Math.max(0, since) - every,
        };
      })
      .sort((a, b) => b.over - a.over || a.title.localeCompare(b.title));

    res.json({ ...base, habits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
