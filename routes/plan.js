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

const router = express.Router();

// How long a note may be. It is described as a line or two and it is sent
// verbatim in a message, so this is a ceiling rather than a target.
const NOTE_MAX = 500;

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
    .select('id, title, entry_id, start_time, duration_minutes, note, sort_order')
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
      note: b.note,
    })),
  });
});

function validatePlan(date, blocks, wakeMinutes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return 'date must be YYYY-MM-DD';
  if (!Array.isArray(blocks) || !blocks.length) return 'a plan needs at least one block';

  // Required, not optional.
  //
  // This used to fall back to the earliest block when nothing was sent, for
  // the sake of an older client. There are no older clients: the page is
  // served by this same process from this same deploy, so it cannot be a
  // version behind. The fallback was unreachable code, and worse, the
  // behaviour it fell back to is the exact inference this field exists to
  // replace — a 06:00 block does not mean anyone got up at 06:00.
  if (wakeMinutes === undefined || wakeMinutes === null) {
    return 'wake_minutes is required: the hour the day starts is a fact, not something to infer from the first block';
  }

  const w = Number(wakeMinutes);
  if (!Number.isInteger(w) || w < 0 || w > 1439) {
    return 'wake_minutes must be inside the day';
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
    // Every block is built in the builder now — nothing arrives from a
    // calendar at whatever length the calendar said — so every block lands on
    // the step.
    if (duration % 30 !== 0) {
      return `${b.title}: duration must be a multiple of 30 minutes`;
    }

    // The note is free text and stays free text. The only rule is a ceiling,
    // because it goes out verbatim in a message and an unbounded field
    // eventually meets Telegram's own limit somewhere less helpful than here.
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') {
      return `${b.title}: a note must be text`;
    }
    if (String(b.note || '').length > NOTE_MAX) {
      return `${b.title}: a note is a line or two, not ${String(b.note).length} characters`;
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

  // The hour the person set for this day, stored as the fact it is. Never
  // inferred from the blocks: validatePlan has already refused a request that
  // did not say.
  const wake = hhmmss(Number(wake_minutes));

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

    // Nothing is composed here any more. A block message is its own columns,
    // so confirming a day is one insert and no second pass: no model call, no
    // arithmetic, and no `message_text` to write. That column is left in place
    // holding whatever it last held, and read by nothing.
    const rows = blocks.map((b, i) => ({
      user_id: CURRENT_USER,
      plan_id: planId,
      title: String(b.title).trim(),
      entry_id: b.entryId || null,
      start_time: hhmmss(Number(b.start_minutes)),
      duration_minutes: Number(b.duration_minutes),
      sort_order: i,
      // Trimmed, and an empty one is no note rather than an empty string —
      // clearing the field is how a note is removed.
      note: String(b.note || '').trim() || null,
    }));

    const { error: blockErr } = await supabase.from('blocks').insert(rows);
    if (blockErr) throw new Error(blockErr.message);

    res.json({ date, blocks: rows.length, status: 'confirmed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
