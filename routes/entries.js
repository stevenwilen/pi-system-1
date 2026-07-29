// Things: one list of habits, projects and tasks.
//
// Reading rows, counting days, writing what was typed. Nothing here decides
// anything and nothing here calls the model. The warning mark is the only
// derived value on the way out, and it is subtraction.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { todayIn } = require('../clock');
const { create_entry, update_entry } = require('../tools');
const { lastScheduled, daysBetween } = require('../staleness');
const { SIZES, markFor, daysUntil } = require('../warning');

const router = express.Router();

const TYPES = ['habit', 'project', 'task'];
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

// Which types may carry a deadline. A habit has a cadence instead, and a habit
// with a deadline would be two different ideas in one row.
const DATED = ['project', 'task'];

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
  try {
    const { data: profile } = await supabase
      .from('profile')
      .select('timezone, default_wake_time')
      .eq('user_id', CURRENT_USER)
      .maybeSingle();

    const timeZone = (profile && profile.timezone) || 'UTC';
    const today = todayIn(timeZone);

    const { data: rows, error } = await supabase
      .from('entries')
      .select('id, type, title, frequency, due, size, created_at')
      .eq('user_id', CURRENT_USER)
      .eq('status', 'active')
      .in('type', TYPES);

    if (error) return res.status(500).json({ error: error.message });

    const latest = await lastScheduled(CURRENT_USER);

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
        // Null when this has never been scheduled, which is what lets the
        // screen say "since added" instead of claiming a scheduling that
        // never happened.
        last_scheduled: seen,
        days: Math.max(0, daysBetween(since, today)),
      };
    });

    // Longest left, first, across all three types. The order is arithmetic on
    // the days rather than anything the person arranged, so the server can
    // compute it and the screen does not have to be told.
    res.json({
      today,
      timezone: timeZone,
      wake_time: String((profile && profile.default_wake_time) || '07:00').slice(0, 5),
      items: items.sort((a, b) => b.days - a.days || a.title.localeCompare(b.title)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- writing ----------------------------------------------------------------

// '' and null both mean "no date". The form sends '' when the field is
// cleared, and the column takes null.
const orNull = (value) => (String(value || '').trim() ? String(value).trim() : null);

/**
 * What the form is allowed to leave out, and what it is not.
 *
 * Checked here rather than only in the database so the message can name the
 * field. The one rule with any depth to it is the last: a due date without a
 * size cannot produce a warning mark, so the pair is required together or not
 * at all.
 */
function validate({ type, title, frequency, due, size }) {
  if (!TYPES.includes(type)) return `type must be one of ${TYPES.join(', ')}`;
  if (!String(title || '').trim()) return 'a title is required';

  if (type === 'habit' && !FREQUENCIES.includes(frequency)) {
    return `a habit needs a frequency: ${FREQUENCIES.join(', ')}`;
  }

  const hasDue = Boolean(orNull(due));

  if (hasDue) {
    if (!DATED.includes(type)) {
      return 'only a project or a task can have a due date. A habit has a frequency instead.';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due).trim())) return 'a due date must be YYYY-MM-DD';
    // Rejects 2026-02-31, which matches the pattern and is not a day.
    const clean = String(due).trim();
    const parsed = new Date(`${clean}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clean) {
      return `${clean} is not a real date`;
    }
  }

  // The size exists to be measured against the due date. Without one it has
  // nothing to say, and with a due date and no size the row cannot be marked
  // at all — which would look on screen exactly like a comfortable deadline.
  if (hasDue && !SIZES.includes(size)) {
    return `something with a due date needs a size: ${SIZES.join(', ')}`;
  }
  if (!hasDue && orNull(size)) {
    return 'a size only means something against a due date. Set a date, or leave the size off.';
  }

  return null;
}

/**
 * The row a validated form becomes.
 *
 * Only the fields that belong to this type. A habit carrying a size, or a task
 * carrying a frequency, would be noise nothing reads.
 */
function toRow(body) {
  const fields = { type: body.type, title: String(body.title).trim() };

  if (body.type === 'habit') {
    fields.frequency = body.frequency;
  } else {
    fields.due = orNull(body.due);
    fields.size = fields.due ? body.size : null;
  }

  return fields;
}

router.post('/entries', async (req, res) => {
  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  const row = await create_entry(CURRENT_USER, toRow(body));
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
  const body = req.body || {};

  const { data: current, error: readErr } = await supabase
    .from('entries')
    .select('type, title, frequency, due, size')
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
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

  const row = await update_entry(CURRENT_USER, req.params.id, toRow(merged));
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ entry: row });
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
  const { data: entry, error: readErr } = await supabase
    .from('entries')
    .select('id, type')
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .maybeSingle();

  if (readErr) return res.status(400).json({ error: readErr.message });
  if (!entry) return res.status(404).json({ error: 'entry not found' });

  if (entry.type !== 'task') {
    return res.status(400).json({ error: `a ${entry.type} is not finished in one go` });
  }

  const row = await update_entry(CURRENT_USER, req.params.id, { status: 'done' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ done: row.id });
});

router.post('/entries/:id/delete', async (req, res) => {
  const row = await update_entry(CURRENT_USER, req.params.id, { status: 'deleted' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

module.exports = router;
