// Building a day: the hours already claimed, and the plan laid out around them.
//
// The calendar route says which hours are gone. The plan routes save and read
// back what the person built in the remaining ones. All arithmetic; the one
// model call this triggers is fired and forgotten after the answer is sent.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { minutesOfDay, toMinutes, hhmmss } = require('../clock');
const { get_calendar } = require('../tools');
const { generateForPlan } = require('../messages');

const router = express.Router();

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

  // get_calendar swallows its own failures and returns [], so a feed that is
  // down costs the pinned blocks and never the whole builder.
  const raw = await get_calendar(CURRENT_USER, date);
  if (!Array.isArray(raw)) return res.json({ date, events: [], all_day: [] });

  const timed = [];
  const allDay = [];

  for (const e of raw) {
    const start = minutesOfDay(e.start, timeZone);
    const length = Math.round((new Date(e.end) - new Date(e.start)) / 60000);

    // An all-day entry is a reminder, not an appointment. It claims no hours,
    // and treating it as one would pin a 24 hour block at midnight and push
    // the whole day past the end of it. Reported separately so it is still
    // visible without owning any time.
    if (start === 0 && length >= 1440) {
      allDay.push({ title: e.title });
      continue;
    }

    timed.push({
      title: e.title,
      start_minutes: start,
      // Clamped to the end of the day: an event running past midnight would
      // otherwise push the running end time into nonsense.
      duration_minutes: Math.max(15, Math.min(length, 1440 - start)),
    });
  }

  timed.sort((a, b) => a.start_minutes - b.start_minutes);
  res.json({ date, events: timed, all_day: allDay });
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
    .select('id, date, status')
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
    plan: { date: plan.date, status: plan.status },
    blocks: (rows || []).map((b) => ({
      title: b.title,
      entryId: b.entry_id,
      start_minutes: toMinutes(b.start_time),
      duration_minutes: b.duration_minutes,
      pinned: b.pinned,
    })),
  });
});

function validatePlan(date, blocks) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return 'date must be YYYY-MM-DD';
  if (!Array.isArray(blocks) || !blocks.length) return 'a plan needs at least one block';

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
  const { date, blocks } = req.body || {};

  const problem = validatePlan(date, blocks);
  if (problem) return res.status(400).json({ error: problem });

  const wake = hhmmss(Math.min(...blocks.map((b) => Number(b.start_minutes))));

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
