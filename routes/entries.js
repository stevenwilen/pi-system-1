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
const {
  SETUP_PROMPT,
  encodeState,
  decodeState,
  validateImport,
  toRow,
} = require('../plan-intent');

const router = express.Router();

const TYPES = ['habit', 'project', 'task'];
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

// The two that can say where they stand. A habit has a cadence instead: there
// is no "what is left" on something meant to recur.
const STATEFUL = ['project', 'task'];

// Which type may carry a deadline: a task, and only a task.
//
// A habit has a cadence instead. A project has a size — days, weeks or months —
// which says how much work is in it, and that is the useful thing about a
// project. A date on one is a guess about when the work will end rather than a
// fact about the work, and it goes stale without anything having happened.
const DATED = ['task'];

// Which types may say why they matter. A project must; a habit may.
const REASONED = ['project', 'habit'];

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
      .select('id, type, title, why, frequency, due, body, cold, cold_reason, paused_at, created_at')
      .eq('user_id', CURRENT_USER)
      .eq('status', 'active')
      .in('type', TYPES);

    if (error) return res.status(500).json({ error: error.message });

    const latest = await lastScheduled(CURRENT_USER);

    const items = (rows || []).map((r) => {
      const seen = latest.get(r.id) || null;
      const since = seen || String(r.created_at).slice(0, 10);

      // Where this stood when it was last written down, and how long ago that
      // was. The age travels with the claim everywhere it goes: a note about
      // what is left is true on the day it is written and drifts from then on,
      // so nothing is allowed to read the words without reading the date.
      const held = decodeState(r.body);

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
        state: held && held.state,
        size: held && held.size,
        state_captured: held && held.captured,
        state_days_old:
          held && held.captured ? Math.max(0, daysBetween(held.captured, today)) : null,
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
      };
    });

    // Longest left, first, across all three types. The order is arithmetic on
    // the days rather than anything the person arranged, so the server can
    // compute it and the panel does not have to be told.
    const inOrder = (a, b) => b.days - a.days || a.title.localeCompare(b.title);

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

// --- the setup interview ----------------------------------------------------
//
// The same shape as the finance lane's: the app hands over a prompt, the person
// answers it in a chat assistant, and pastes the JSON back. Nothing here calls
// the model. This system writes the question and reads the answer; the
// conversation happens in a tool the person already has.

router.get('/plan-intent/setup-prompt', (req, res) => {
  res.json({ prompt: SETUP_PROMPT });
});

/**
 * Save a whole interview at once.
 *
 * All or nothing. Every item is checked before any is written, so a paste that
 * is half understood leaves nothing behind rather than a list that looks
 * complete. Existing rows are untouched: this appends.
 */
router.post('/plan-intent/import', async (req, res) => {
  const items = (req.body && req.body.items) || [];

  const problem = validateImport(items);
  if (problem) return res.status(400).json({ error: problem });

  const { data: profile } = await supabase
    .from('profile')
    .select('timezone')
    .eq('user_id', CURRENT_USER)
    .maybeSingle();

  // One date for the whole import, read where the person lives. Every state in
  // this paste was described in the same conversation, so they age together.
  const captured = todayIn((profile && profile.timezone) || 'UTC');

  // No position is written. The order these arrive in carries no meaning any
  // more: the list sorts itself by how long each thing has been left, so the
  // sequence the interview happened to produce is not something to preserve.
  const rows = items.map((item) => ({ user_id: CURRENT_USER, ...toRow(item, captured) }));

  const { data, error } = await supabase
    .from('entries')
    .insert(rows)
    .select('id, type, title, why, frequency, due, body');

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    saved: data.length,
    entries: data.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      why: r.why,
      frequency: r.frequency,
      due: r.due,
      ...(decodeState(r.body) || {}),
    })),
  });
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
      return type === 'project'
        ? 'a project has a size rather than a deadline. Say whether it is days, weeks or months of work.'
        : 'only a task can have a due date. A habit has a frequency instead.';
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

// Today where this person lives. Used to date a state note at the moment it is
// written, so its age is measured from their day rather than the server's.
async function todayForUser() {
  const { data } = await supabase
    .from('profile')
    .select('timezone')
    .eq('user_id', CURRENT_USER)
    .maybeSingle();

  return todayIn((data && data.timezone) || 'UTC');
}

router.post('/entries', async (req, res) => {
  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  // Only the fields that belong to this type. A habit carrying a why, or a
  // task carrying a frequency, would be noise nothing reads.
  const fields = { type: body.type, title: String(body.title).trim() };
  if (body.type === 'habit') fields.frequency = body.frequency;

  // A project must say why and a habit may. A habit with only a title and a
  // cadence is a row that cannot be argued for later either, and the interview
  // already asks for one, so the form does too.
  if (REASONED.includes(body.type)) {
    const why = String(body.why || '').trim();
    if (why) fields.why = why;
  }

  if (DATED.includes(body.type)) fields.due = dueOrNull(body.due);

  if (STATEFUL.includes(body.type)) {
    // Stamped with today where the person lives, so a note about where this
    // stands carries the date it was true from the moment it is written.
    fields.body = encodeState({
      state: body.state,
      size: body.size,
      captured: await todayForUser(),
    });
  }

  const row = await create_entry(CURRENT_USER, fields);
  if (row.error) return res.status(400).json({ error: row.error });

  res.json({ entry: row });
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
    .select('type, title, why, frequency, due, body')
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .maybeSingle();

  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!current) return res.status(404).json({ error: 'entry not found for this user' });

  // A project that already carries a deadline from before they were taken off
  // projects is cleaned rather than refused. Validating the merged row would
  // otherwise reject every edit to it, and a row nobody can edit because of a
  // field they can no longer set is a trap rather than a rule.
  if (current.type === 'project' && current.due) fields.due = null;

  const problem = validate({ ...current, ...fields });
  if (problem) return res.status(400).json({ error: problem });

  // Rewriting where something stands re-dates it. That is the point: the claim
  // has just been made again, so its clock starts again. Leaving the old date
  // on new words would be the one thing this must not do — present a fresh
  // statement as an old one, or an old one as fresh.
  if (body.state !== undefined || body.size !== undefined) {
    const held = decodeState(current.body) || {};
    fields.body = encodeState({
      state: body.state !== undefined ? body.state : held.state,
      size: body.size !== undefined ? body.size : held.size,
      captured: await todayForUser(),
    });
  }

  const row = await update_entry(CURRENT_USER, req.params.id, fields);
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ entry: { ...row, ...(decodeState(row.body) || {}) } });
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

/**
 * Finished. Off the list, still in the data.
 *
 * A task is one thing to do, so there has to be a way to say it is done that is
 * not Delete. Without one the only exit was a destructive button, and a
 * finished task stayed on the list, sank to the bottom as its clock reset, then
 * climbed back to the top over the following weeks asking to be done again.
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
