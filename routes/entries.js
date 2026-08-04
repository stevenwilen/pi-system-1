// Things: one list of habits, projects and tasks.
//
// Reading rows, counting days, writing what was typed. Nothing here decides
// anything and nothing here calls the model. The warning mark is the only
// derived value on the way out, and it is subtraction.

const express = require('express');

const { todayIn, DEFAULT_ZONE } = require('../clock');
const { create_entry, update_entry } = require('../tools');
const { lastScheduled, daysBetween } = require('../staleness');
const { markFor, slackFor, daysUntil } = require('../warning');
const { TYPES, NOTE_MAX, orNull, validate, toRow } = require('../entry-shape');

const router = express.Router();



/**
 * Habits, projects and tasks in one list, coldest first.
 *
 * A task left three weeks is the same problem as a project left three weeks,
 * so they share a list rather than being filed apart. Anything never scheduled
 * counts from the day it was added, which is the honest answer to "how long has
 * this been sitting there" — and the screen says "since added" rather than
 * "since scheduled" in that case, because those are different claims.
 */
router.get('/entries', async (req, res) => {
  const { db, userId } = req.auth;

  try {
    const { data: profile } = await db
      .from('profile')
      .select('timezone, default_wake_time, plans_in, nudge_hour')
      .eq('user_id', userId)
      .maybeSingle();

    const timeZone = (profile && profile.timezone) || DEFAULT_ZONE;
    const today = todayIn(timeZone);

    const { data: rows, error } = await db
      .from('entries')
      .select('id, type, title, frequency, due, size, note, priority, paused_at, created_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .in('type', TYPES);

    if (error) return res.status(500).json({ error: error.message });

    const latest = await lastScheduled(db, userId);

    const items = (rows || []).map((r) => {
      const seen = latest.get(r.id) || null;
      const since = seen || String(r.created_at).slice(0, 10);

      // Date only. Postgres hands a `date` back as YYYY-MM-DD already, but
      // slicing means a driver that ever decides to widen it to a timestamp
      // cannot shift the day by a timezone on the way through.
      const due = r.due ? String(r.due).slice(0, 10) : null;

      return {
        id: r.id,
        type: r.type,
        title: r.title,
        frequency: r.frequency,
        due,
        size: r.size,
        days_until_due: due ? daysUntil(today, due) : null,
        // '!!!', '!!', '!' or null. Arithmetic on the due date and the size,
        // and nothing else — see warning.js.
        mark: markFor({ due, size: r.size, today }),
        // Days of room left, which is what the order above is made of. Not
        // sent: the screen shows the mark, and a number nothing renders is a
        // field to keep in step with for no one's benefit.
        slack: slackFor({ due, size: r.size, today }),
        // The message waiting for the next time this is scheduled, or null.
        //
        // Sent in full rather than as a "there is one" flag, because swiping
        // the row again is how a note is edited and the field has to open
        // with what is already in it. The screen shows a mark and not the
        // text: the list is a list, and a second line of prose on every row
        // is how it stops being one.
        note: r.note || null,
        // Held at the top of the list by hand. See the order below.
        pinned: Boolean(r.priority),
        // Set down on purpose. These come back under `saved` rather than in
        // the list, and the difference from deleted is the whole point of the
        // column: still cared about, just not now.
        later: Boolean(r.paused_at),
        // Null when this has never been scheduled, which is what lets the
        // screen say "since added" instead of claiming a scheduling that
        // never happened.
        last_scheduled: seen,
        days: Math.max(0, daysBetween(since, today)),
      };
    });

    // TWO HALVES: what is running out of room, then what has gone cold.
    //
    // Anything carrying a mark sits above everything without one, ordered by
    // the least room left — so an overdue thing beats a thing due Friday, and
    // both beat a habit nobody has done in a fortnight. Below the marks it is
    // the old order: longest untouched first, across all three types.
    //
    // The break between them is the mark, not a blended score. A single number
    // mixing "days since" with "days of room" would be a judgement this system
    // does not have the standing to make — it is not told when work happens,
    // only when something was scheduled. Two orders with one plain rule about
    // which wins can be read off the screen; a score cannot.
    //
    // Within the marks the ORDER uses slack rather than the mark itself,
    // because '!!!' covers everything from just-out-of-room to a month
    // overdue, and those are not the same day.
    //
    // Still arithmetic on what the person declared, and still computed here so
    // the screen never has to be told what order to use.
    // THREE HALVES NOW, AND THE FIRST ONE IS DECLARED RATHER THAN COMPUTED.
    //
    // A pin sits above everything, including a deadline that has run out. That
    // is a real cost and worth naming: something genuinely overdue can be
    // pushed below a pinned habit, and the screen will not argue about it.
    //
    // It is not the ranking that was retired, though it uses the column that
    // ranking used. What was refused was a SCORE — a single number blending
    // "days since" with "days of room", which cannot be read off the screen and
    // which the system has no standing to compute. A pin blends nothing. It is
    // a fact the person stated, and §2.1 is that nothing is inferred which can
    // be declared: the arithmetic guesses at what needs attention, and a pin is
    // someone saying it outright.
    //
    // Inside the pinned half the arithmetic is unchanged, so pins are ordered
    // among themselves exactly as the list orders everything else.
    const order = (a, b) =>
      (a.pinned ? 0 : 1) - (b.pinned ? 0 : 1) ||
      (a.mark ? 0 : 1) - (b.mark ? 0 : 1) ||
      (a.mark ? a.slack - b.slack : b.days - a.days) ||
      a.title.localeCompare(b.title);
    res.json({
      today,
      timezone: timeZone,
      wake_time: String((profile && profile.default_wake_time) || '07:00').slice(0, 5),
      // Which day the evening nudge asks about. Null reads as evening, which
      // is what this did before the column existed. It no longer decides which
      // day the screen opens on.
      plans_in: (profile && profile.plans_in) === 'morning' ? 'morning' : 'evening',
      // The hour the system starts asking about tomorrow, which is also the
      // hour the screen starts opening on it. Sent so those two cannot drift:
      // they are the same idea, and a second constant on the page would be a
      // copy of this one waiting to be forgotten.
      nudge_hour: Number.isInteger(profile && profile.nudge_hour) ? profile.nudge_hour : 20,
      // Sorted with slack, sent without it.
      // SET DOWN ON PURPOSE, AND OUT OF THE WAY. A saved thing keeps its row
      // and everything on it; it simply stops competing for attention with the
      // things you are actually working through. That is the difference between
      // this and deleting it, and it is why the staleness clock on a saved
      // thing does not matter — nothing is ranking it.
      //
      // Two lists out of one sort, so the order inside `saved` is the same
      // order it would have had, rather than a second opinion.
      items: items.filter((i) => !i.later).sort(order).map(({ slack, ...item }) => item),
      saved: items.filter((i) => i.later).sort(order).map(({ slack, ...item }) => item),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- writing ----------------------------------------------------------------
// The shape rules live in entry-shape.js, shared with the setup paste. Two
// ways into the same list must not be able to disagree about what belongs
// in it.

router.post('/entries', async (req, res) => {
  const { db, userId } = req.auth;
  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  const row = await create_entry(db, userId, toRow(body));
  if (row.error) return res.status(400).json({ error: row.error });

  res.json({ entry: row });
});

/**
 * Edit an entry.
 *
 * The same rules as creation, applied to what the row will look like
 * afterwards rather than to what was sent. Otherwise a due date could be added
 * to a row with no size one request at a time, each individually valid.
 */
router.post('/entries/:id/update', async (req, res) => {
  const { db, userId } = req.auth;
  const body = req.body || {};

  const { data: current, error: readErr } = await db
    .from('entries')
    .select('type, title, frequency, due, size')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!current) return res.status(404).json({ error: 'entry not found for this user' });

  // The type is fixed once set. Changing it would mean deciding what happens
  // to a frequency on something that is no longer a habit, and the answer is
  // that this is a different thing and should be added as one.
  const merged = {
    type: current.type,
    title: body.title !== undefined ? String(body.title).trim() : current.title,
    frequency: body.frequency !== undefined ? body.frequency : current.frequency,
    due: body.due !== undefined ? orNull(body.due) : current.due,
    size: body.size !== undefined ? orNull(body.size) : current.size,
  };

  // Clearing the date clears the size with it, so nothing is left holding a
  // size that has no deadline to be measured against.
  if (!merged.due) merged.size = null;

  const problem = validate(merged);
  if (problem) return res.status(400).json({ error: problem });

  const row = await update_entry(db, userId, req.params.id, toRow(merged));
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ entry: row });
});

/**
 * The note, written or cleared.
 *
 * Its own route rather than a field on `/update`, because it is not the same
 * kind of edit. `/update` re-validates the whole row — a title, a due date and
 * the size that has to accompany it — and a note has no rules to break beyond
 * a ceiling. Sending it through there would mean a note could be refused for
 * something on the other side of the row, and would mean the edit sheet and a
 * swipe wrote through the same door for no shared reason.
 *
 * Empty is not a note. Clearing the field is how one is removed, which is why
 * null, '' and whitespace all mean the same thing here.
 */
router.post('/entries/:id/note', async (req, res) => {
  const { db, userId } = req.auth;
  const raw = (req.body || {}).note;

  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return res.status(400).json({ error: 'a note must be text' });
  }
  if (String(raw || '').length > NOTE_MAX) {
    return res.status(400).json({
      error: `a note is a line or two, not ${String(raw).length} characters`,
    });
  }

  const note = String(raw || '').trim() || null;

  const row = await update_entry(db, userId, req.params.id, { note });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ id: row.id, note: row.note || null });
});

/**
 * Set down on purpose, or picked back up.
 *
 * `paused_at` is the column, and it is the third retired one to come back
 * after `completed` and `priority`. It was described exactly this way before
 * it was retired — "a paused entry is still active and still cared about; it
 * drops out of the stale list until unpaused" — so this is the same feature
 * returning under a name that says what it is.
 *
 * A TIMESTAMP RATHER THAN A FLAG, because the column already is one and
 * because "since when" is worth having: a thing set down in March and a thing
 * set down on Tuesday are not in the same state, even if nothing reads that
 * yet.
 */
router.post('/entries/:id/later', async (req, res) => {
  const { db, userId } = req.auth;
  const later = (req.body || {}).later;

  if (typeof later !== 'boolean') {
    return res.status(400).json({ error: 'later must be true or false' });
  }

  const row = await update_entry(db, userId, req.params.id, {
    paused_at: later ? new Date().toISOString() : null,
  });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ id: row.id, later: Boolean(row.paused_at) });
});

/**
 * Held at the top of the list, or let go of.
 *
 * Its own route rather than a field on `/update`, for the reason the note has
 * one: `/update` re-validates the whole row — a title, a due date, the length
 * that has to accompany it — and a pin has no rules to break at all. Sending it
 * through there would mean a pin could be refused for something on the far side
 * of the row it has nothing to do with.
 *
 * `priority` is the column, holding 1 or null. It was the hand-ordering field
 * this list retired, every row still holds null, and it is coming back for the
 * one thing it was always for.
 */
router.post('/entries/:id/pin', async (req, res) => {
  const { db, userId } = req.auth;
  const pinned = (req.body || {}).pinned;

  if (typeof pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be true or false' });
  }

  const row = await update_entry(db, userId, req.params.id, { priority: pinned ? 1 : null });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ id: row.id, pinned: Boolean(row.priority) });
});

/**
 * Finished. Off the list, still in the data.
 *
 * Tasks only. A habit recurring is the whole point of a habit, and a project is
 * not finished by one session of work on it; offering Done on either would be
 * offering to retire something that has not ended.
 *
 * `done` is a separate state from `deleted` because they mean opposite things:
 * one is work that happened, the other is a row that should not have existed.
 * Both drop out of every read, which all filter on status = 'active'.
 */
router.post('/entries/:id/done', async (req, res) => {
  const { db, userId } = req.auth;

  const { data: entry, error: readErr } = await db
    .from('entries')
    .select('id, type')
    .eq('id', req.params.id)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (readErr) return res.status(400).json({ error: readErr.message });
  if (!entry) return res.status(404).json({ error: 'entry not found' });

  if (entry.type !== 'task') {
    return res.status(400).json({ error: `a ${entry.type} is not finished in one go` });
  }

  const row = await update_entry(db, userId, req.params.id, { status: 'done' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ done: row.id });
});

router.post('/entries/:id/delete', async (req, res) => {
  const { db, userId } = req.auth;
  const row = await update_entry(db, userId, req.params.id, { status: 'deleted' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

module.exports = router;
