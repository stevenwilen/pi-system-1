// The list: everything the person is keeping track of.
//
// Habits, projects and tasks in one place, in the order they put them in.
// Reading rows, counting days, writing what was typed. Nothing here decides
// anything and nothing here calls the model.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { todayIn } = require('../clock');
const { create_entry, update_entry } = require('../tools');
const { lastScheduled, daysBetween } = require('../staleness');

const router = express.Router();

const TYPES = ['habit', 'project', 'task'];
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

// Which types may carry a deadline. A habit has a cadence instead, and a habit
// with a due date would be two different ideas in one row.
const DATED = ['project', 'task'];

/**
 * Habits, projects and tasks in one list, in the person's own order.
 *
 * A task left three weeks is the same problem as a project left three weeks,
 * so they share a list rather than being filed apart. Anything never scheduled
 * counts from the day it was added, which is the honest answer to "how long has
 * this been sitting there".
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
      .select('id, type, title, why, frequency, due, sort_order, cold, cold_reason, paused_at, created_at')
      .eq('user_id', CURRENT_USER)
      .eq('status', 'active')
      .in('type', TYPES);

    if (error) return res.status(500).json({ error: error.message });

    const latest = await lastScheduled(CURRENT_USER);

    const items = (rows || []).map((r) => {
      const seen = latest.get(r.id) || null;
      const since = seen || String(r.created_at).slice(0, 10);
      return {
        id: r.id,
        type: r.type,
        title: r.title,
        why: r.why,
        frequency: r.frequency,
        // Date only. Postgres hands a `date` back as YYYY-MM-DD already, but
        // slicing means a driver that ever decides to widen it to a timestamp
        // cannot shift the day by a timezone on the way through.
        due: r.due ? String(r.due).slice(0, 10) : null,
        paused: Boolean(r.paused_at),
        // A paused item is never cold, whatever the last verdict said. The
        // person declared it set down, and 2.7 means that is not reopened.
        //
        // The reason is still returned. The judge is asked to say plainly that
        // a paused item is paused, so it is the explanation for the false
        // rather than a stale argument for a true, and dropping it would throw
        // away the only thing that says why the row is quiet.
        cold: Boolean(r.cold) && !r.paused_at,
        cold_reason: r.cold_reason,
        last_scheduled: seen,
        days: Math.max(0, daysBetween(since, today)),
        sort_order: r.sort_order,
      };
    });

    // The list is the person's ranking, so it is returned in their order and
    // in no other. A row with no position yet sorts to the end rather than
    // jumping the queue on a null.
    const inOrder = (a, b) =>
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title);

    res.json({
      today,
      timezone: timeZone,
      wake_time: String((profile && profile.default_wake_time) || '07:00').slice(0, 5),
      // Paused items are kept out of the main list but returned, so unpausing
      // is one tap. Hiding them would turn a pause into an accidental delete.
      items: items.filter((i) => !i.paused).sort(inOrder),
      paused: items.filter((i) => i.paused).sort(inOrder),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- writing ----------------------------------------------------------------

// What the form is allowed to leave out, and what it is not. Checked here
// rather than in the database so the message can name the field.
function validate({ type, title, why, frequency, due }) {
  if (!TYPES.includes(type)) return `type must be one of ${TYPES.join(', ')}`;
  if (!String(title || '').trim()) return 'a title is required';

  if (type === 'habit') {
    if (!FREQUENCIES.includes(frequency)) {
      return `a habit needs a frequency: ${FREQUENCIES.join(', ')}`;
    }
  }
  if (type === 'project' && !String(why || '').trim()) {
    return 'a project needs a why. Without one it cannot be argued for later.';
  }

  // A due date is optional everywhere it is allowed at all, so only its shape
  // and the type carrying it are checked.
  if (due !== null && due !== undefined && due !== '') {
    if (!DATED.includes(type)) {
      return 'only a project or a task can have a due date. A habit has a frequency instead.';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due))) return 'a due date must be YYYY-MM-DD';
    // Rejects 2026-02-31, which matches the pattern and is not a day.
    const parsed = new Date(`${due}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== due) {
      return `${due} is not a real date`;
    }
  }
  return null;
}

// '' and null both mean "no date". The form sends '' when the field is
// cleared, and the column takes null.
const dueOrNull = (value) => (String(value || '').trim() ? String(value).trim() : null);

router.post('/entries', async (req, res) => {
  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  // Only the fields that belong to this type. A habit carrying a why, or a
  // task carrying a frequency, would be noise nothing reads.
  const fields = { type: body.type, title: String(body.title).trim() };
  if (body.type === 'habit') fields.frequency = body.frequency;
  if (body.type === 'project') fields.why = String(body.why).trim();
  if (DATED.includes(body.type)) fields.due = dueOrNull(body.due);

  const row = await create_entry(CURRENT_USER, fields);
  if (row.error) return res.status(400).json({ error: row.error });

  // New things go to the top: adding something is thinking about it now.
  //
  // Taking one below the current minimum rather than renumbering the list
  // means nothing else moves, so a position the person chose cannot be
  // disturbed by an unrelated addition.
  //
  // The minimum is taken over the ranked types only. Habits are ordered by how
  // long they have been left, not by position, so their sort_order is a value
  // nothing reads, and letting it set the floor here would drag the priorities'
  // numbering further negative on every habit added.
  const { data: first } = await supabase
    .from('entries')
    .select('sort_order')
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .in('type', DATED)
    .not('sort_order', 'is', null)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();

  const top = first && first.sort_order !== null ? first.sort_order - 1 : 0;

  const { data: placed } = await supabase
    .from('entries')
    .update({ sort_order: top })
    .eq('id', row.id)
    .eq('user_id', CURRENT_USER)
    .select()
    .maybeSingle();

  res.json({ entry: placed || row });
});

/**
 * The whole list, in the order the person just put it in.
 *
 * Takes every id rather than a moved one and its neighbour: the client already
 * holds the order it is showing, and sending it entire means the stored order
 * cannot drift from the visible one through a dropped update.
 */
router.post('/entries/reorder', async (req, res) => {
  const ids = (req.body && req.body.ids) || [];

  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'ids must not repeat' });
  }

  // Only rows this person owns, so an id from anywhere else moves nothing.
  const { data: owned, error: readErr } = await supabase
    .from('entries')
    .select('id')
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .in('id', ids);

  if (readErr) return res.status(500).json({ error: readErr.message });

  const mine = new Set((owned || []).map((r) => r.id));
  const unknown = ids.filter((id) => !mine.has(id));
  if (unknown.length) {
    return res.status(400).json({ error: `${unknown.length} id(s) are not yours or not active` });
  }

  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase
      .from('entries')
      .update({ sort_order: i })
      .eq('id', ids[i])
      .eq('user_id', CURRENT_USER);

    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ordered: ids.length });
});

/**
 * Edit an entry.
 *
 * The same rules as creation, applied to what the row will look like
 * afterwards rather than to what was sent. Otherwise a project could be
 * emptied of its why one field at a time, each request individually valid.
 */
router.post('/entries/:id/update', async (req, res) => {
  const body = req.body || {};
  const fields = {};

  for (const key of ['title', 'why', 'frequency']) {
    if (body[key] !== undefined) fields[key] = String(body[key]).trim();
  }

  // Handled apart from the others because clearing it is a real edit. The
  // loop above turns a missing value into '', which is right for text and
  // wrong for a date column, and null is how a deadline is removed.
  if (body.due !== undefined) fields.due = dueOrNull(body.due);

  const { data: current, error: readErr } = await supabase
    .from('entries')
    .select('type, title, why, frequency, due')
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .maybeSingle();

  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!current) return res.status(404).json({ error: 'entry not found for this user' });

  const problem = validate({ ...current, ...fields });
  if (problem) return res.status(400).json({ error: problem });

  const row = await update_entry(CURRENT_USER, req.params.id, fields);
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ entry: row });
});

/**
 * Pause and unpause.
 *
 * Written straight to the column rather than through update_entry, and
 * `paused_at` is deliberately absent from the tools whitelist. Pausing is the
 * person declaring that a gap is on purpose, and SPEC 2.7 says intent is
 * declared and never inferred. Leaving it out of the whitelist is what makes
 * that structural rather than a rule in a prompt: the brain has no way to
 * decide on someone's behalf that they meant to set something down.
 */
router.post('/entries/:id/pause', async (req, res) => {
  const paused = req.body && req.body.paused === false ? null : new Date().toISOString();

  const { data, error } = await supabase
    .from('entries')
    .update({ paused_at: paused })
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .select('id, paused_at')
    .maybeSingle();

  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'entry not found' });
  res.json({ id: data.id, paused: Boolean(data.paused_at) });
});

router.post('/entries/:id/delete', async (req, res) => {
  const row = await update_entry(CURRENT_USER, req.params.id, { status: 'deleted' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

module.exports = router;
