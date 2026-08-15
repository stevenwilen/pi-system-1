// Building a day: what is already on the calendar, and the plan built beside it.
//
// The calendar is read, shown, and forgotten. Nothing on it is placed into the
// day BY ITSELF, nothing is pinned, and nothing about it is stored. The person
// reads what is already happening and decides what to do about it, which is the
// one decision this system does not make for them.
//
// A row can be pressed to make a block, and that is the decision being made
// rather than taken. The version this replaces fed all-day events into the day
// on its own, and they had to be argued back out; a row that does nothing until
// it is pressed cannot put anything anywhere.
//
// All arithmetic. No model call anywhere behind these routes.

const express = require('express');

const { minutesOfDay, toMinutes, hhmmss, DEFAULT_ZONE } = require('../clock');
const { readCalendar } = require('../tools');
const { ONE_OFF } = require('../entry-shape');
// The same ceiling the Things list applies, and deliberately the same number:
// a note written on a thing is carried onto a block by the confirm below, so
// two ceilings would let this route refuse text the field that wrote it
// accepted. See entry-shape.js.
const { NOTE_MAX } = require('../entry-shape');

const router = express.Router();

// The grid every block lands on. Half an hour, the same step the builder
// steps by and the same one validatePlan below insists on.
const STEP = 30;

/**
 * A calendar event's length, as a block.
 *
 * ROUNDED UP, never down. A 45-minute meeting becomes an hour rather than half
 * of one: the day is a stack of durations, so a block that under-states its own
 * length makes every time below it wrong in the optimistic direction — which is
 * the direction that has you arriving late.
 *
 * CLIPPED TO THIS DAY. An event can run past midnight, and `eventsOn` returns
 * anything overlapping the date, so the raw length of a three-day conference is
 * measured in days. A block that long is not a day gone wrong, it is a day that
 * cannot be laid out at all.
 */
function blockLength(startIso, endIso, startMinutes) {
  const raw = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);
  if (!Number.isFinite(raw) || raw <= 0) return STEP;

  // Both on the grid before they meet. The clip is a number of minutes left in
  // the day, which is not a multiple of anything — taking the smaller of the
  // two without flooring it first is how a 20-minute event at 11:40pm becomes
  // a block of 20 minutes that the confirm then refuses.
  const room = Math.floor((1440 - startMinutes) / STEP) * STEP;
  return Math.max(STEP, Math.min(Math.ceil(raw / STEP) * STEP, room));
}

/**
 * What is on the calendar for one date.
 *
 * ONE calendar, read as reference. There were two, meaning things to know and
 * things to do, and the second fed events into the day as blocks by itself.
 * Both the second feed and the automatic placing are gone: this is a list of
 * what is already happening, shown beside the day so a person can build around
 * it — and press into it, one row at a time, when that is what they want.
 *
 * A timed event carries its time and its length; an all-day entry carries
 * neither.
 */
router.get('/calendar/:date', async (req, res) => {
  const { db, userId } = req.auth;
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const { data: profile } = await db
    .from('profile')
    .select('timezone')
    .eq('user_id', userId)
    .maybeSingle();

  const timeZone = (profile && profile.timezone) || DEFAULT_ZONE;

  // readCalendar returns what it could read and says whether it failed, so a
  // feed that is down never costs the builder — but the failure travels with
  // the answer instead of leaving an empty list to speak for itself.
  const { events, failed, configured } = await readCalendar(db, userId, date);

  const items = events.map((e) => {
    const start = e.all_day ? null : minutesOfDay(e.start, timeZone);
    return {
      title: e.title,
      // Null for an all-day entry, which claims no hour. The screen shows the
      // title alone rather than inventing a time for it.
      start_minutes: start,
      // How long it runs, for the tap that turns it into a block. Sent because
      // it is the one thing about a calendar event this day model can hold
      // exactly: an hour is an hour wherever the block ends up sitting. The
      // start is not — blocks stack from the wake time and have no fixed
      // hours — so the time above is shown and never used as a start.
      duration_minutes: e.all_day ? null : blockLength(e.start, e.end, start),
    };
  });

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
    // A fact, not a list. There is one calendar, and the only thing the screen
    // needs to know is whether this empty list means a quiet day or a feed it
    // could not reach. Those are the same list and must not be the same
    // sentence.
    failed,
    // And the third case: an account with no calendar set up at all, which is
    // not having a quiet day either.
    configured,
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
  const { db, userId } = req.auth;
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const { data: plan, error } = await db
    .from('plans')
    .select('id, date, status, wake_time')
    .eq('user_id', userId)
    .eq('date', date)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!plan) return res.json({ plan: null, blocks: [] });

  const { data: rows, error: blockErr } = await db
    .from('blocks')
    .select('id, title, entry_id, start_time, duration_minutes, note, completed, sort_order, message_sent_at')
    .eq('plan_id', plan.id)
    .order('sort_order');

  if (blockErr) return res.status(500).json({ error: blockErr.message });

  res.json({
    plan: {
      date: plan.date,
      status: plan.status,
      wake_minutes: toMinutes(plan.wake_time),
    },
    blocks: (rows || []).map((b) => untimedSafe(b)),
  });
});

/**
 * One block, in the shape the builder holds it.
 *
 * NULL RATHER THAN NaN, which is what this exists for. `toMinutes(null)` is
 * `Number('null') * 60`, and that is NaN — a value that compares false against
 * everything, so a screen holding one lays the block out at no position, draws
 * no time, and reports no error. Untimed is a state; NaN is a bug wearing its
 * clothes.
 */
const untimedSafe = (b) => {
  const timed = b.start_time !== null && b.start_time !== undefined;
  return {
    // The row's own id, handed to the client so it can hand it back. This is
    // what lets a re-confirm update the day rather than rebuild it, and it is
    // the only reason identity survives at all: nothing here matches blocks by
    // title or by time, because reordering and retiming are exactly what
    // re-confirming is for.
    id: b.id,
    title: b.title,
    entryId: b.entry_id,
    start_minutes: timed ? toMinutes(b.start_time) : null,
    duration_minutes: timed ? b.duration_minutes : null,
    note: b.note,
    // Only ever meaningful on an untimed item, which is inserted false and set
    // true by hand. A timed block is true because it stayed in the day.
    done: Boolean(b.completed),
    // Already gone out, so the screen can refuse to offer the things that
    // would rewrite it: a delivered block cannot be moved or resized. It can
    // still be removed, and its title and note can still be changed.
    sent: Boolean(b.message_sent_at),
  };
};

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

    // AN UNTIMED ITEM IS BOTH OR NEITHER. A block with a start and no length,
    // or a length and no start, is not a state this system has a meaning for:
    // the day could not lay it out and the end time could not decide whether
    // to count it. Refused here rather than stored as half of something.
    const noStart = b.start_minutes === null || b.start_minutes === undefined;
    const noLength = b.duration_minutes === null || b.duration_minutes === undefined;

    if (noStart !== noLength) {
      return `${b.title}: a block has a start and a length, or neither. Untimed means both are empty.`;
    }

    // The note is free text and stays free text. The only rule is a ceiling,
    // because it goes out verbatim in a message and an unbounded field
    // eventually meets Telegram's own limit somewhere less helpful than here.
    //
    // ABOVE THE UNTIMED SHORTCUT, deliberately. An untimed item carries a note
    // like any other block — it is the whole of what a row says beyond its
    // title — and checking the ceiling only on the timed ones would leave the
    // rule true of half the table.
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') {
      return `${b.title}: a note must be text`;
    }
    if (String(b.note || '').length > NOTE_MAX) {
      return `${b.title}: a note is a line or two, not ${String(b.note).length} characters`;
    }

    // Untimed. Nothing below applies: there is no hour to be inside the day
    // and no length to land on the step.
    if (noStart) continue;

    const start = Number(b.start_minutes);
    const duration = Number(b.duration_minutes);

    if (!Number.isInteger(start) || start < 0 || start > 1439) {
      return `${b.title}: start must be inside the day`;
    }
    if (!Number.isInteger(duration) || duration < 30) {
      return `${b.title}: duration must be at least 30 minutes`;
    }
    // Every block lands on the step. A calendar event can be pressed into the
    // day and brings its own length, but that length is put on the grid before
    // it is ever sent — see blockLength above. Nothing arrives here at whatever
    // length the calendar happened to say.
    if (duration % 30 !== 0) {
      return `${b.title}: duration must be a multiple of 30 minutes`;
    }
  }
  return null;
}

/** Is this payload block one committed to a day but not to an hour? */
const isUntimed = (b) => b.start_minutes === null || b.start_minutes === undefined;

/** The columns a confirm owns. Everything else on a block belongs to the day. */
const blockFields = (b, i) => ({
  title: String(b.title).trim(),
  entry_id: b.entryId || null,
  start_time: isUntimed(b) ? null : hhmmss(Number(b.start_minutes)),
  duration_minutes: isUntimed(b) ? null : Number(b.duration_minutes),
  sort_order: i,
  // Trimmed, and an empty one is no note rather than an empty string —
  // clearing the field is how a note is removed.
  note: String(b.note || '').trim() || null,
  // WHAT MAKES STALENESS WORK, and the whole reason this column came back to
  // life. A timed block counts for staleness by staying in the day — nothing
  // sets this false and it is true here for the same reason it defaults true.
  // An untimed item has no hour to have passed, so it counts only when the
  // person says it is done, and it is written false until they do.
  //
  // Sent by the day rather than only by the marking route so that an item
  // ticked before the day was ever confirmed is not un-ticked by confirming
  // it — the screen holds the tick, and this is where the screen is written.
  completed: isUntimed(b) ? Boolean(b.done) : true,
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
  const { db, userId } = req.auth;
  const { date, blocks, wake_minutes } = req.body || {};

  const problem = validatePlan(date, blocks, wake_minutes);
  if (problem) return res.status(400).json({ error: problem });

  // The hour the person set for this day, stored as the fact it is. Never
  // inferred from the blocks: validatePlan has already refused a request that
  // did not say.
  const wake = hhmmss(Number(wake_minutes));

  try {
    const { data: existing } = await db
      .from('plans')
      .select('id')
      .eq('user_id', userId)
      .eq('date', date)
      .maybeSingle();

    let planId = existing ? existing.id : null;
    let stored = [];

    if (planId) {
      const { data: rows, error } = await db
        .from('blocks')
        .select('id, title, start_time, duration_minutes, message_sent_at')
        .eq('user_id', userId)
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

      // A block with no hour was never in the delivery queue, so there is no
      // message to have contradicted. Skipped by name rather than left to the
      // arithmetic below, which would compare `toMinutes(null)` — NaN — against
      // a number, find them unequal, and refuse every untimed item on the
      // grounds that it had been moved.
      if (was.start_time === null && isUntimed(b)) continue;

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

    // --- the messages waiting on the things being scheduled ----------------
    //
    // A note on a thing is written for the next time it is put in a day, and
    // this is that moment: it moves onto the block and is cleared from the
    // thing, spent once delivered. A note that stayed behind would be read
    // again on every future scheduling, which is how a sentence about one
    // morning becomes a standing instruction nobody meant to give.
    //
    // HERE AND NOT ON THE SCREEN, because a block does not exist until this
    // request. The tap that puts a thing in the day writes nothing, and a
    // person who taps a row and then changes their mind must not have spent
    // the note on a block that was never saved.
    //
    // NEW BLOCKS ONLY, and the first one per thing. Scheduling something twice
    // in a day is two sessions of the same work, not the same message twice;
    // and a block that already exists was delivered its note by whichever
    // confirm created it.
    const firstNewFor = new Map();
    for (const [i, b] of blocks.entries()) {
      if (b.id || !b.entryId) continue;
      if (!firstNewFor.has(b.entryId)) firstNewFor.set(b.entryId, i);
    }

    // Block position -> the text moving onto it.
    const delivered = new Map();

    if (firstNewFor.size) {
      const { data: waiting, error } = await db
        .from('entries')
        .select('id, note')
        .eq('user_id', userId)
        .in('id', [...firstNewFor.keys()]);
      if (error) throw new Error(error.message);

      for (const e of waiting || []) {
        const text = String(e.note || '').trim();
        if (!text) continue;

        const at = firstNewFor.get(e.id);

        // The block's own words win, and the thing keeps its note.
        //
        // Nothing is overwritten and nothing is thrown away: someone who wrote
        // on the block itself has said something more recent about this
        // session, and the message waiting on the thing is still waiting for a
        // scheduling that has room for it.
        if (String(blocks[at].note || '').trim()) continue;

        delivered.set(at, text);
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
      const { error: upErr } = await db
        .from('plans')
        .update({ status: 'confirmed', wake_time: wake })
        .eq('id', planId)
        .eq('user_id', userId);
      if (upErr) throw new Error(upErr.message);
    } else {
      const { data: made, error: insErr } = await db
        .from('plans')
        .insert({ user_id: userId, date, wake_time: wake, status: 'confirmed' })
        .select('id')
        .single();
      if (insErr) throw new Error(insErr.message);
      planId = made.id;
    }

    if (dropped.length) {
      const { error } = await db
        .from('blocks')
        .delete()
        .eq('user_id', userId)
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
      const { error } = await db
        .from('blocks')
        .update(blockFields(b, i))
        .eq('user_id', userId)
        .eq('id', b.id);
      if (error) throw new Error(error.message);
      ids[i] = b.id;
    }

    const freshAt = blocks.map((b, i) => i).filter((i) => !blocks[i].id);

    if (freshAt.length) {
      const { data: made, error } = await db
        .from('blocks')
        .insert(
          freshAt.map((i) => {
            const fields = blockFields(blocks[i], i);
            // The thing's note, arriving on the block that schedules it.
            if (delivered.has(i)) fields.note = delivered.get(i);
            return { user_id: userId, plan_id: planId, ...fields };
          })
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

    // THE THING KEEPS ITS NOTE. It used to be cleared here — spent, on the
    // reasoning that a sentence about one morning would otherwise be read again
    // on every future scheduling and become a standing instruction nobody meant
    // to give.
    //
    // That reasoning describes a real risk and got the trade the wrong way
    // round. What it cost was the thing the note was for: you write on a thing
    // in advance so the words are there when you come to schedule it, and a
    // note that is spent the first time is a note you have to write again every
    // time. The note now stays on the row until the thing itself leaves the
    // list — which for a task or a project is when it is finished, and for a
    // habit is never, because a habit has no end to reach (§2.3). A standing
    // note on a habit is exactly what a habit's note is.
    //
    // Copying rather than moving, so both ends hold the words: the block has
    // its own copy from the moment it is made and can be edited freely, and
    // editing it says nothing about the thing.

    res.json({
      date,
      blocks: blocks.length,
      status: 'confirmed',
      ids,
      // The notes this confirm moved onto blocks, by position, null everywhere
      // else. Sent so the screen can show the arrival without reloading the
      // day: the person wrote those words and the block they landed on is on
      // screen in front of them.
      notes: blocks.map((b, i) => (delivered.has(i) ? delivered.get(i) : null)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Tick an untimed item off, or untick it.
 *
 * WRITTEN AT ONCE, unlike everything else about a day. Every other change to a
 * block waits for Confirm, which is right for building a plan and wrong for
 * this: ticking things off happens all through the day, hours after the last
 * Confirm, and a person who ticked three things and closed the app would have
 * lost all three — along with the staleness those ticks were the only record
 * of. There is nothing to weigh up here that a Confirm would be confirming.
 *
 * UNTIMED ONLY, and refused on anything else by name. `completed` on a timed
 * block means something this system decided long ago it would not track: a
 * timed block counts because it stayed in the day, and taking it out is how
 * you say it did not happen. A route that could set it false would be a second,
 * quieter answer to that question — and staleness reads this column, so the two
 * answers would disagree about how long ago you last did something.
 */
router.post('/plan/block/:id/done', async (req, res) => {
  const { db, userId } = req.auth;
  const done = (req.body || {}).done;

  if (typeof done !== 'boolean') {
    return res.status(400).json({ error: 'done must be true or false' });
  }

  const { data: block, error: readErr } = await db
    .from('blocks')
    .select('id, start_time, entry_id')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!block) return res.status(404).json({ error: 'block not found for this user' });

  if (block.start_time !== null) {
    return res.status(400).json({
      error: 'a block with an hour is not ticked off. Take it out of the day to say it did not happen.',
    });
  }

  const { data, error } = await db
    .from('blocks')
    .update({ completed: done })
    .eq('id', block.id)
    .eq('user_id', userId)
    .select('id, completed')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'block not found for this user' });

  // A ONE-OFF IS OVER THE MOMENT IT IS TICKED, and this is the whole of what
  // that frequency buys. Anything else on the list is still on it after a
  // session — a habit recurs, a project takes more than one sitting — so the
  // thing behind the block outlives the block. A one-off has nothing left to
  // come back for, and being asked to finish it a second time by hand, on a
  // list, after already doing it, is the chore that teaches people to stop
  // keeping the list.
  //
  // AND UNTICKING BRINGS IT BACK. A tick is a statement, not a transaction, and
  // this one is reachable by a thumb on a row — the row it was aimed at is the
  // one directly under it half the time. `done` rather than `deleted` all the
  // way through, so the row is never destroyed by either direction (§2.3).
  const finished = await settleOneOff(db, userId, block.entry_id, done);

  res.json({
    id: data.id,
    done: Boolean(data.completed),
    // Named only when it moved, so the page can take the row off the list
    // without waiting for the next load.
    ...(finished ? { entry: finished } : {}),
  });
});

/**
 * Finish the thing behind a ticked block, or bring it back.
 *
 * Only ever a one-off, and only ever between 'active' and 'done' — the two
 * states that mean "still carrying it" and "work that happened". A tombstone
 * stays a tombstone: `deleted` is not in either filter, so a row someone
 * removed cannot be resurrected by a tick on a block that outlived it.
 *
 * Its own failures are swallowed on purpose. The tick itself has already been
 * written and answered; a list that is one row out of date is corrected by the
 * next load, and a 500 here would report a successful tick as a failure and
 * invite a second press.
 */
async function settleOneOff(db, userId, entryId, done) {
  if (!entryId) return null;

  const { data: entry } = await db
    .from('entries')
    .select('id, type, frequency, status')
    .eq('id', entryId)
    .eq('user_id', userId)
    .in('status', ['active', 'done'])
    .maybeSingle();

  // A TASK, AND ONLY A TASK. A habit recurs, which is the opposite of happening
  // once, and a project is not finished by one sitting — the type check is what
  // stops a habit's cadence being read as a one-off flag, since the two share
  // the column.
  if (!entry || entry.type !== 'task' || entry.frequency !== ONE_OFF) return null;

  const want = done ? 'done' : 'active';
  if (entry.status === want) return null;

  const { data: moved } = await db
    .from('entries')
    .update({ status: want })
    .eq('id', entry.id)
    .eq('user_id', userId)
    .select('id, status')
    .maybeSingle();

  return moved ? { id: moved.id, status: moved.status } : null;
}

module.exports = router;
