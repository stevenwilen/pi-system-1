// How often you got to things.
//
// Arithmetic on what was scheduled, and nothing else. This is never told that
// anything happened — the one exception is an untimed item, which is ticked by
// hand — so every figure here is about what was PLANNED, and the words on the
// screen say so.
//
// IT USED TO COUNT HOURS. "Where your time went": minutes per habit, project
// and task, and the five things given the most. That stopped describing the app
// the day untimed items arrived, because a thing committed to a day without an
// hour contributes nothing to a total made of minutes — the more of your day
// you kept out of the clock, the emptier the section looked.
//
// What replaced it is the question this system is actually built around. A
// habit declares a cadence; the Things list orders by how long since something
// was last scheduled. Neither of those is ever checked against the other, and
// "you said daily and you got to it nine times in thirty days" is the one thing
// that list cannot say.
//
// THIRTY DAYS, not all time. All time is the honest default at four days of
// history and the wrong one at four hundred, when it becomes a number that only
// ever grows and stops describing this month. The window is stated on screen so
// the figure is never read as more than it is.

const express = require('express');

const { todayIn, DEFAULT_ZONE } = require('../clock');
const { daysBetween } = require('../staleness');

const router = express.Router();

const WINDOW_DAYS = 30;

// The five biggest. A list of everything would be the Things list again in a
// different order, and the question this answers is what got worked on rather
// than what exists.
const TOP = 5;

/**
 * What share of the days a cadence asks for.
 *
 * The four frequencies `entry-shape.js` allows, and the plainest reading of
 * each. "few times a week" is three: the phrase covers two to four, three is
 * the middle, and taking the low end would flatter every habit carrying it.
 */
const PER_DAY = {
  daily: 1,
  'few times a week': 3 / 7,
  weekly: 1 / 7,
  monthly: 1 / 30,
};

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

    // Every entry, finished and deleted ones included. A task done last week
    // was worked on last week, and dropping it would make the record of a month
    // depend on what the list happens to hold today.
    const { data: entries, error: entryErr } = await db
      .from('entries')
      .select('id, type, title, frequency, status, created_at, updated_at')
      .eq('user_id', userId);

    if (entryErr) throw new Error(entryErr.message);

    const { data: plans, error: planErr } = await db
      .from('plans')
      .select('id, date')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .gte('date', from)
      .lte('date', today);

    if (planErr) throw new Error(planErr.message);

    const live = (entries || []).filter((e) => e.status === 'active');

    // WHAT THE LIST HOLDS RIGHT NOW, which is a different question from the
    // window and does not pretend otherwise: these count what exists, not what
    // happened in thirty days. `finished` is the exception and says so.
    const counts = {
      habits: live.filter((e) => e.type === 'habit').length,
      projects: live.filter((e) => e.type === 'project').length,
      tasks: live.filter((e) => e.type === 'task').length,
      // Finished IN THE WINDOW, by when the row was last written. `updated_at`
      // is the nearest thing to a completion date this schema has — there is no
      // `done_at` — and it is right for the ordinary case, where a task is
      // finished and never touched again. One edited afterwards would count
      // from the edit: the known cost of not having the column, and smaller
      // than dropping the figure.
      finished: (entries || []).filter(
        (e) => e.type === 'task' && e.status === 'done' &&
          String(e.updated_at).slice(0, 10) >= from
      ).length,
    };

    if (!plans || !plans.length) {
      return res.json({
        window_days: WINDOW_DAYS, days: 0, counts, habits: [], top: [],
      });
    }

    const dateOf = new Map(plans.map((p) => [p.id, p.date]));

    const { data: blocks, error: blockErr } = await db
      .from('blocks')
      .select('entry_id, plan_id, completed')
      .eq('user_id', userId)
      .in('plan_id', plans.map((p) => p.id))
      .not('entry_id', 'is', null)
      // THE SAME FILTER STALENESS USES, and deliberately the same one. A timed
      // block is true because it stayed in the day; an untimed item is true
      // only once it has been ticked. Counting them differently here would let
      // two screens disagree about whether you got to something.
      .eq('completed', true);

    if (blockErr) throw new Error(blockErr.message);

    // DAYS, not blocks. Scheduling one thing twice on a Tuesday is one Tuesday
    // you got to it, and counting it twice would let a single busy day stand in
    // for a cadence it says nothing about.
    const daysFor = new Map();
    for (const b of blocks || []) {
      const date = dateOf.get(b.plan_id);
      if (!date) continue;
      if (!daysFor.has(b.entry_id)) daysFor.set(b.entry_id, new Set());
      daysFor.get(b.entry_id).add(date);
    }

    const scheduledDays = (id) => (daysFor.get(id) || new Set()).size;

    const habits = live
      .filter((e) => e.type === 'habit' && PER_DAY[e.frequency])
      .map((e) => {
        // NEVER LONGER THAN IT HAS EXISTED. A habit added five days ago and
        // measured against thirty is one that cannot help but look abandoned,
        // and the first thing a new one would do is report a failure nobody
        // had been given the chance to commit.
        const since = String(e.created_at).slice(0, 10);
        const known = Math.min(WINDOW_DAYS, Math.max(1, daysBetween(since, today) + 1));

        return {
          title: e.title,
          frequency: e.frequency,
          days_known: known,
          // Never below one: every cadence asks for something.
          expected: Math.max(1, Math.round(known * PER_DAY[e.frequency])),
          scheduled: scheduledDays(e.id),
        };
      })
      // FURTHEST BEHIND FIRST, the order every other list on this screen uses.
      // It is also the half that is not already visible: the Things list says
      // how long since something was last scheduled and says nothing at all
      // about the cadence it was meant to keep.
      .sort((a, b) =>
        a.scheduled / a.expected - b.scheduled / b.expected ||
        a.title.localeCompare(b.title));

    // Everything with no declared cadence. There is nothing to measure them
    // against, so the figure is the plain one: how many days you gave them.
    const top = (entries || [])
      .filter((e) => e.type !== 'habit')
      .map((e) => ({ title: e.title, type: e.type, days: scheduledDays(e.id) }))
      .filter((e) => e.days > 0)
      .sort((a, b) => b.days - a.days || a.title.localeCompare(b.title))
      .slice(0, TOP);

    res.json({
      window_days: WINDOW_DAYS,
      days: plans.length,
      counts,
      habits,
      top,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
