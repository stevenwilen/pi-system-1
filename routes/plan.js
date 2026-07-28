// Building a day: the hours already claimed, and the plan laid out around them.
//
// The calendar route says which hours are gone. The plan routes save and read
// back what the person built in the remaining ones. All arithmetic; the one
// model call this triggers is fired and forgotten after the answer is sent.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { minutesOfDay, toMinutes, hhmmss } = require('../clock');
const { readCalendar } = require('../tools');
const { generateForPlan } = require('../messages');

const router = express.Router();

// How long an auto-placed block is, before the person changes it. Half an hour
// is the smallest thing the steppers can express, so it is the least the
// system can assume on someone's behalf.
const AUTO_BLOCK_MINUTES = 30;

// The sent_log job name for "this event has been offered to this day".
//
// Prefixed so it cannot collide with a real job, and carrying the event's own
// id so two things on the same date are tracked apart. sent_log is keyed
// (user_id, job, sent_for_date), which is exactly this question.
const placementJob = (eventId) => `placed:${eventId}`;

/**
 * The day's fixed commitments, as pinned blocks.
 *
 * These hours are already gone. The builder lays everything else out around
 * them and never moves them.
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

  const timed = [];
  const allDay = [];
  const toPlace = [];

  for (const e of events) {
    // An all-day entry claims no hours. What happens to it depends entirely on
    // which calendar it is on: a thing to know is shown, a thing to do is
    // offered to the day as a block.
    if (e.all_day) {
      if (e.source === 'action') toPlace.push({ id: e.id, title: e.title });
      else allDay.push({ title: e.title });
      continue;
    }

    // A timed event is an appointment on either feed. It is pinned and it
    // cannot move, because the hour is already spoken for either way.
    const start = minutesOfDay(e.start, timeZone);
    const length = Math.round((new Date(e.end) - new Date(e.start)) / 60000);

    timed.push({
      title: e.title,
      start_minutes: start,
      // Clamped to the end of the day: an event running past midnight would
      // otherwise push the running end time into nonsense.
      duration_minutes: Math.max(15, Math.min(length, 1440 - start)),
    });
  }

  timed.sort((a, b) => a.start_minutes - b.start_minutes);

  res.json({
    date,
    events: timed,
    all_day: allDay,
    // What the action feed is offering for this day. Reported here so the
    // builder can show it; nothing is claimed until the placement route is
    // called, because reporting must stay repeatable and placing must not.
    to_place: toPlace,
    // Named feeds, so the screen can say which calendar it could not reach
    // rather than leaving an empty day to speak for itself.
    failed,
  });
});

/**
 * Claim the action feed's all-day events for this date, and hand them back.
 *
 * Separate from the read above, and a POST, because it has a side effect: each
 * event it returns is recorded as placed and will never be returned again for
 * this date. That is the whole point. Without it, deleting an auto-added block
 * and reopening the builder would put it straight back, and the person would
 * have no way to say no.
 *
 * sent_log already holds exactly this shape — a thing that happened once, for
 * one user, on one date — and its unique constraint is the lock, so two
 * builders opening at once cannot both place the same event.
 */
router.post('/calendar/:date/place', async (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const { events, failed } = await readCalendar(CURRENT_USER, date);
  const candidates = events.filter((e) => e.source === 'action' && e.all_day);

  const placed = [];

  for (const e of candidates) {
    const job = placementJob(e.id);

    // The insert is the claim. Asking first and writing after would leave a
    // gap two requests could both pass through; letting the constraint refuse
    // the second one cannot.
    const { error } = await supabase
      .from('sent_log')
      .insert({ user_id: CURRENT_USER, job, sent_for_date: date });

    // 23505 is unique_violation: already placed, on a previous open. Not a
    // failure, and the reason this route is safe to call every time.
    if (error) {
      if (error.code !== '23505') {
        console.error(`[CALENDAR] could not claim "${e.title}": ${error.message}`);
      }
      continue;
    }

    placed.push({ title: e.title, duration_minutes: AUTO_BLOCK_MINUTES });
  }

  res.json({ date, placed, failed });
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
    .select('id, title, entry_id, start_time, duration_minutes, pinned, sort_order')
    .eq('plan_id', plan.id)
    .order('sort_order');

  if (blockErr) return res.status(500).json({ error: blockErr.message });

  res.json({
    // The hour this day was actually built to start at, which is not the same
    // as the profile default and not the same as the first block either: a
    // calendar event at 6am does not mean anyone got up then.
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
      pinned: b.pinned,
    })),
  });
});

function validatePlan(date, blocks, wakeMinutes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return 'date must be YYYY-MM-DD';
  if (!Array.isArray(blocks) || !blocks.length) return 'a plan needs at least one block';

  // Optional: a client that does not send one gets the old behaviour below.
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
    if (!Number.isInteger(duration) || duration < 15) {
      return `${b.title}: duration must be at least 15 minutes`;
    }
    // Pinned blocks are calendar events and are whatever length the calendar
    // says. Only what the person built with steppers has to land on the step.
    if (!b.pinned && duration % 30 !== 0) {
      return `${b.title}: duration must be a multiple of 30 minutes`;
    }
  }
  return null;
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

  // The hour the person set for this day, stored as the fact it is.
  //
  // It used to be inferred from the earliest block, which is wrong whenever a
  // pinned calendar event sits before the day is meant to start: a 6am
  // appointment would have this day on record as a 6am start. Falling back to
  // that inference only when nothing was sent, so an older client still works.
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

    const rows = blocks.map((b, i) => ({
      user_id: CURRENT_USER,
      plan_id: planId,
      title: String(b.title).trim(),
      entry_id: b.entryId || null,
      start_time: hhmmss(Number(b.start_minutes)),
      duration_minutes: Number(b.duration_minutes),
      pinned: Boolean(b.pinned),
      sort_order: i,
    }));

    const { error: blockErr } = await supabase.from('blocks').insert(rows);
    if (blockErr) throw new Error(blockErr.message);

    // The plan is saved. Answer now.
    res.json({ date, blocks: rows.length, status: 'confirmed' });

    // Then write the block messages, which takes a model call and the better
    // part of a minute. Deliberately not awaited: the person confirmed a day
    // and should not watch a spinner while a language model composes, and the
    // plan does not depend on this succeeding. If it fails, message_text stays
    // null and delivery sends the block title and time on its own.
    generateForPlan(CURRENT_USER, planId).catch((err) =>
      console.error(`[MESSAGES] unexpected: ${err.message}`)
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
