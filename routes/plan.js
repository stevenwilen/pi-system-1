// Building a day: what is already on the calendar, and the plan built beside it.
//
// The calendar is reference material and nothing more. It is read, shown, and
// forgotten: nothing on it is placed into the day, nothing is pinned, and
// nothing about it is stored. The person reads what is already happening and
// decides what to do about it, which is the one decision this system does not
// make for them.
//
// All arithmetic. No model call anywhere behind these routes.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { minutesOfDay, toMinutes, hhmmss } = require('../clock');
const { readCalendar } = require('../tools');
const { lastScheduled } = require('../staleness');
const { contextLine } = require('../messages');

const router = express.Router();

/**
 * Everything on both calendar feeds for one date.
 *
 * Both feeds together, undifferentiated. They used to mean different things —
 * one was things to know and the other things to do, and the second fed events
 * into the day automatically — and now they are one list of what is already
 * happening. A timed event carries its time; an all-day entry carries none.
 */
router.get('/calendar/:date', async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const { data: profile } = await supabase
    .from('profile')
    .select('timezone')
    .eq('user_id', CURRENT_USER)
    .maybeSingle();

  const timeZone = (profile && profile.timezone) || 'UTC';

  // readCalendar returns what it could read and names what it could not, so a
  // feed that is down costs its own events and never the whole builder — but
  // the failure travels with the answer instead of looking like a quiet day.
  const { events, failed } = await readCalendar(CURRENT_USER, date);

  const items = events.map((e) => ({
    title: e.title,
    // Null for an all-day entry, which claims no hour. The screen shows the
    // title alone rather than inventing a time for it.
    start_minutes: e.all_day ? null : minutesOfDay(e.start, timeZone),
  }));

  // Timed first, in order, then the all-day entries. Something happening at a
  // particular hour is the more useful thing to read first when the question
  // being asked is what the day already looks like.
  items.sort((a, b) => {
    if (a.start_minutes === null && b.start_minutes === null) return 0;
    if (a.start_minutes === null) return 1;
    if (b.start_minutes === null) return -1;
    return a.start_minutes - b.start_minutes;
  });

  res.json({
    date,
    items,
    // Named feeds, so the screen can say which calendar it could not reach
    // rather than leaving an empty day to speak for itself.
    failed,
  });
});

/**
 * A saved plan, if there is one, in the shape the builder holds in memory.
 *
 * Without this a confirmed plan would vanish on the next page load and the
 * person would rebuild it from scratch, which is a good way to stop trusting
 * the button.
 */
router.get('/plan/:date', async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const { data: plan, error } = await supabase
    .from('plans')
    .select('id, date, status, wake_time')
    .eq('user_id', CURRENT_USER)
    .eq('date', date)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!plan) return res.json({ plan: null, blocks: [] });

  const { data: rows, error: blockErr } = await supabase
    .from('blocks')
    .select('id, title, entry_id, start_time, duration_minutes, sort_order')
    .eq('plan_id', plan.id)
    .order('sort_order');

  if (blockErr) return res.status(500).json({ error: blockErr.message });

  res.json({
    plan: {
      date: plan.date,
      status: plan.status,
      wake_minutes: toMinutes(plan.wake_time),
    },
    blocks: (rows || []).map((b) => ({
      title: b.title,
      entryId: b.entry_id,
      start_minutes: toMinutes(b.start_time),
      duration_minutes: b.duration_minutes,
    })),
  });
});

function validatePlan(date, blocks, wakeMinutes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return 'date must be YYYY-MM-DD';
  if (!Array.isArray(blocks) || !blocks.length) return 'a plan needs at least one block';

  if (wakeMinutes !== undefined && wakeMinutes !== null) {
    const w = Number(wakeMinutes);
    if (!Number.isInteger(w) || w < 0 || w > 1439) {
      return 'wake_minutes must be inside the day';
    }
  }

  for (const b of blocks) {
    if (!String(b.title || '').trim()) return 'every block needs a title';

    const start = Number(b.start_minutes);
    const duration = Number(b.duration_minutes);

    if (!Number.isInteger(start) || start < 0 || start > 1439) {
      return `${b.title}: start must be inside the day`;
    }
    if (!Number.isInteger(duration) || duration < 30) {
      return `${b.title}: duration must be at least 30 minutes`;
    }
    // Every block is built with the steppers now — nothing arrives from a
    // calendar at whatever length the calendar said — so every block lands on
    // the step.
    if (duration % 30 !== 0) {
      return `${b.title}: duration must be a multiple of 30 minutes`;
    }
  }
  return null;
}

/**
 * The context line for each block, composed in code.
 *
 * Written at confirm time and stored on the block, because delivery happens
 * hours later in a different process and has to survive a restart. This used to
 * be a model call fired and forgotten after the response went out; it is now
 * subtraction on two dates, so it happens inline and the plan is not saved
 * until it has.
 */
async function linesFor(user_id, planId, date, blocks) {
  const ids = [...new Set(blocks.map((b) => b.entryId).filter(Boolean))];
  if (!ids.length) return new Map();

  const { data: rows, error } = await supabase
    .from('entries')
    .select('id, due')
    .eq('user_id', user_id)
    .in('id', ids);

  if (error) throw new Error(error.message);

  const entries = new Map((rows || []).map((r) => [r.id, r]));

  // Excluding this plan matters: its old blocks are deleted by the time this
  // runs, but a re-confirm that failed halfway could leave some behind, and
  // counting them would report every entry as scheduled today.
  const latest = await lastScheduled(user_id, { excludePlanId: planId });

  const lines = new Map();
  for (const id of ids) {
    const line = contextLine({
      entry: entries.get(id),
      lastSeen: latest.get(id) || null,
      date,
    });
    if (line) lines.set(id, line);
  }
  return lines;
}

/**
 * Confirm tomorrow.
 *
 * Re-confirming replaces the day rather than appending to it: the builder
 * holds the whole plan, so what it sends is the plan, and merging two
 * versions of the same day would only invent a third nobody asked for.
 */
router.post('/plan', async (req, res) => {
  const { date, blocks, wake_minutes } = req.body || {};

  const problem = validatePlan(date, blocks, wake_minutes);
  if (problem) return res.status(400).json({ error: problem });

  // The hour the person set for this day, stored as the fact it is. Falls back
  // to the first block only when nothing was sent, so an older client still
  // works.
  const wake =
    wake_minutes === undefined || wake_minutes === null
      ? hhmmss(Math.min(...blocks.map((b) => Number(b.start_minutes))))
      : hhmmss(Number(wake_minutes));

  try {
    const { data: existing } = await supabase
      .from('plans')
      .select('id')
      .eq('user_id', CURRENT_USER)
      .eq('date', date)
      .maybeSingle();

    let planId;

    if (existing) {
      planId = existing.id;
      // Clear first. If the insert below fails the day is left empty rather
      // than holding a mix of two plans, which is the safer wrong answer.
      const { error: delErr } = await supabase.from('blocks').delete().eq('plan_id', planId);
      if (delErr) throw new Error(delErr.message);

      const { error: upErr } = await supabase
        .from('plans')
        .update({ status: 'confirmed', wake_time: wake })
        .eq('id', planId);
      if (upErr) throw new Error(upErr.message);
    } else {
      const { data: made, error: insErr } = await supabase
        .from('plans')
        .insert({ user_id: CURRENT_USER, date, wake_time: wake, status: 'confirmed' })
        .select('id')
        .single();
      if (insErr) throw new Error(insErr.message);
      planId = made.id;
    }

    const lines = await linesFor(CURRENT_USER, planId, date, blocks);

    const rows = blocks.map((b, i) => ({
      user_id: CURRENT_USER,
      plan_id: planId,
      title: String(b.title).trim(),
      entry_id: b.entryId || null,
      start_time: hhmmss(Number(b.start_minutes)),
      duration_minutes: Number(b.duration_minutes),
      sort_order: i,
      // Null for a buffer block, and for anything whose entry had nothing
      // worth saying. Delivery sends the title and times on their own.
      message_text: (b.entryId && lines.get(b.entryId)) || null,
    }));

    const { error: blockErr } = await supabase.from('blocks').insert(rows);
    if (blockErr) throw new Error(blockErr.message);

    res.json({ date, blocks: rows.length, status: 'confirmed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
