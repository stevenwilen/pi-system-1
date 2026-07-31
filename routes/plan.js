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
    .select('id, title, entry_id, start_time, duration_minutes, note, sort_order, message_sent_at')
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
      // The row's own id, handed to the client so it can hand it back. This
      // is what lets a re-confirm update the day rather than rebuild it, and
      // it is the only reason identity survives at all: nothing here matches
      // blocks by title or by time, because reordering and retiming are
      // exactly what re-confirming is for.
      id: b.id,
      title: b.title,
      entryId: b.entry_id,
      start_minutes: toMinutes(b.start_time),
      duration_minutes: b.duration_minutes,
      note: b.note,
      // Already gone out, so the screen can refuse to offer the things that
      // would rewrite it: a delivered block cannot be moved or resized. It can
      // still be removed, and its title and note can still be changed.
      sent: Boolean(b.message_sent_at),
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

/** The columns a confirm owns. Everything else on a block belongs to the day. */
const blockFields = (b, i) => ({
  title: String(b.title).trim(),
  entry_id: b.entryId || null,
  start_time: hhmmss(Number(b.start_minutes)),
  duration_minutes: Number(b.duration_minutes),
  sort_order: i,
  // Trimmed, and an empty one is no note rather than an empty string —
  // clearing the field is how a note is removed.
  note: String(b.note || '').trim() || null,
});

/**
 * Confirm tomorrow.
 *
 * Re-confirming reconciles the day against what is already stored. Blocks that
 * came back with their id are updated in place, blocks with no id are new, and
 * rows the payload no longer mentions are removed.
 *
 * This used to delete every block for the date and insert the whole day again.
 * The rows that came back were new rows, so every column the confirm does not
 * set fell to its schema default — including `message_sent_at`, which went null
 * again, putting a block that had already gone out back in the delivery queue
 * to be re-sent if it had started within the last half hour.
 *
 * It is not carried forward by hand here. The rows are never recreated, so
 * there is nothing to carry: the column is simply not in the update.
 *
 * Identity comes from the client, which was handed each row's id when it
 * loaded the plan. Nothing is matched by title or by time, because reordering
 * and retiming are exactly what re-confirming is for and any such guess would
 * be wrong precisely when the day changed most.
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

    let planId = existing ? existing.id : null;
    let stored = [];

    if (planId) {
      const { data: rows, error } = await supabase
        .from('blocks')
        .select('id, title, start_time, duration_minutes, message_sent_at')
        .eq('user_id', CURRENT_USER)
        .eq('plan_id', planId);
      if (error) throw new Error(error.message);
      stored = rows || [];
    }

    // --- everything that can be refused, refused before anything is written --

    const known = new Map(stored.map((b) => [b.id, b]));
    const claimed = new Set();

    for (const b of blocks) {
      if (!b.id) continue;

      if (!known.has(b.id)) {
        return res.status(400).json({
          error: `block ${b.id} is not part of the plan for ${date}`,
        });
      }
      if (claimed.has(b.id)) {
        return res.status(400).json({ error: `block ${b.id} appears twice` });
      }
      claimed.add(b.id);

      // A block that has already gone out is history. The message named a
      // start time and a length, and both were true when it was sent, so
      // neither can be edited afterwards. The title and the note still can.
      //
      // Retiming and resizing only. Removing a delivered block is allowed, and
      // is handled below.
      const was = known.get(b.id);
      if (
        was.message_sent_at &&
        (toMinutes(was.start_time) !== Number(b.start_minutes) ||
          was.duration_minutes !== Number(b.duration_minutes))
      ) {
        return res.status(400).json({
          error: `"${was.title}" was already sent at ${String(was.start_time).slice(0, 5)} and cannot be moved or resized. Its title and note can still be changed.`,
        });
      }
    }

    // Rows the day no longer mentions. Computed here, with the rest of the
    // refusals, so a request that cannot go through has not written anything
    // by the time it is turned away.
    //
    // Nothing is refused on this list. A delivered block used to be
    // unremovable on the grounds that the day that happened is not editable —
    // which was true while a removed block and a missed block meant different
    // things. They no longer do: taking a block out IS how you say it did not
    // happen, and a rule that let you say it about a block whose message had
    // not gone out but not about one whose had was drawing the line at the
    // half hour the delivery job last ran.
    const dropped = stored.filter((b) => !claimed.has(b.id));

    // --- writes ------------------------------------------------------------

    if (planId) {
      const { error: upErr } = await supabase
        .from('plans')
        .update({ status: 'confirmed', wake_time: wake })
        .eq('id', planId)
        .eq('user_id', CURRENT_USER);
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

    if (dropped.length) {
      const { error } = await supabase
        .from('blocks')
        .delete()
        .eq('user_id', CURRENT_USER)
        .in('id', dropped.map((b) => b.id));
      if (error) throw new Error(error.message);
    }

    // The ids of the day as it now stands, in the order it was sent, so the
    // client can hand them back on the next confirm. Without this a day
    // confirmed twice in one session would send no ids the second time, and
    // every block would be dropped and re-inserted — the same bug by a
    // different route.
    const ids = new Array(blocks.length).fill(null);

    for (const [i, b] of blocks.entries()) {
      if (!b.id) continue;
      const { error } = await supabase
        .from('blocks')
        .update(blockFields(b, i))
        .eq('user_id', CURRENT_USER)
        .eq('id', b.id);
      if (error) throw new Error(error.message);
      ids[i] = b.id;
    }

    const freshAt = blocks.map((b, i) => i).filter((i) => !blocks[i].id);

    if (freshAt.length) {
      const { data: made, error } = await supabase
        .from('blocks')
        .insert(
          freshAt.map((i) => ({
            user_id: CURRENT_USER,
            plan_id: planId,
            ...blockFields(blocks[i], i),
          }))
        )
        .select('id, sort_order');
      if (error) throw new Error(error.message);

      // Mapped back by sort_order rather than by position, because nothing
      // promises a bulk insert returns its rows in the order they were sent.
      // Every sort_order in one batch is a distinct payload index, so it is a
      // key here even though the column is not unique in general.
      const bySort = new Map((made || []).map((r) => [r.sort_order, r.id]));
      for (const i of freshAt) ids[i] = bySort.get(i) || null;
    }

    res.json({ date, blocks: blocks.length, status: 'confirmed', ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
