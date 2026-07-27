// The money screen: what was spent, and what the person has declared.
//
// Two unrelated things behind one word. The summary counts a sheet and keeps
// nothing. The intent routes store what the person said about their own
// situation, in their own words.
//
// No amount, account or threshold is written into this file. That is rule 2.4:
// every figure here comes from the sheet or from a row the person wrote.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { todayIn } = require('../clock');
const { create_entry, update_entry } = require('../tools');
const { readTransactions } = require('../sheet');
const { summarise } = require('../money');
const {
  INTENT_KINDS,
  RESERVE_MODES,
  encodeIntent,
  decodeIntent,
  validateIntent,
  SETUP_PROMPT,
} = require('../finance-intent');

const router = express.Router();

// --- the numbers ------------------------------------------------------------

/**
 * The finance screen, counted.
 *
 * Reads the sheet, counts, answers, and keeps nothing. No transaction reaches
 * the database and none is cached. Pure arithmetic: no model call, and no
 * judgment about what any of it means.
 */
router.get('/finance-summary', async (req, res) => {
  const days = Number(req.query.days) || 60;

  const { data: profile } = await supabase
    .from('profile')
    .select('timezone')
    .eq('user_id', CURRENT_USER)
    .maybeSingle();

  const today = todayIn((profile && profile.timezone) || 'UTC');

  // readTransactions never throws and returns [] on any failure, so a sheet
  // that cannot be read costs the numbers and never the request.
  const rows = await readTransactions(days);

  if (!rows.length) {
    return res.json({
      days,
      today,
      connected: false,
      ...summarise([], today),
    });
  }

  res.json({ days, today, connected: true, ...summarise(rows, today) });
});

// --- what they have declared ------------------------------------------------

// The prompt is engine text and lives with the rest of it. Served rather than
// kept in the page so there is one copy of it, and so the client only ever
// repeats what it was given.
router.get('/finance-intent/setup-prompt', (req, res) => {
  res.json({ prompt: SETUP_PROMPT });
});

/**
 * Save a whole interview at once.
 *
 * All or nothing. Every row is validated before any is written, so a paste
 * that is half understood leaves nothing behind rather than a partial picture
 * that looks complete. Existing rows are untouched: this appends.
 */
router.post('/finance-intent/import', async (req, res) => {
  const intents = (req.body && req.body.intents) || [];

  if (!Array.isArray(intents) || !intents.length) {
    return res.status(400).json({ error: 'nothing to save' });
  }
  if (intents.length > 40) {
    return res.status(400).json({ error: 'that is more entries than an interview produces' });
  }

  const rows = [];

  for (const [i, raw] of intents.entries()) {
    const kind = String((raw && raw.kind) || '').trim().toLowerCase();
    const label = String((raw && raw.title) || '').trim();
    const body = String((raw && raw.body) || '').trim();

    if (!INTENT_KINDS.includes(kind)) {
      return res.status(400).json({ error: `entry ${i + 1}: "${kind}" is not one of ${INTENT_KINDS.join(', ')}` });
    }
    if (!label) {
      return res.status(400).json({ error: `entry ${i + 1}: needs a title` });
    }

    // A reserve is useless without knowing which it is. A wall has to be
    // crossed on purpose and a floor can be reached by doing nothing, and the
    // message treats them differently, so the word has to be there.
    let mode = null;
    if (kind === 'reserve') {
      const said = body.toLowerCase();
      const wall = /\bwall\b/.test(said);
      const floor = /\bfloor\b/.test(said);
      if (wall === floor) {
        return res.status(400).json({
          error: `entry ${i + 1} ("${label}"): a reserve must say whether it is a wall or a floor`,
        });
      }
      mode = wall ? 'wall' : 'floor';
    }

    rows.push({
      user_id: CURRENT_USER,
      type: 'finance_intent',
      title: encodeIntent(kind, mode, label),
      body: body || null,
    });
  }

  const { data, error } = await supabase.from('entries').insert(rows).select('id, title, body');
  if (error) return res.status(500).json({ error: error.message });

  res.json({
    saved: data.length,
    entries: data.map((r) => ({ id: r.id, ...decodeIntent(r.title), body: r.body || '' })),
  });
});

router.get('/finance-intent', async (req, res) => {
  const { data, error } = await supabase
    .from('entries')
    .select('id, title, body, created_at')
    .eq('user_id', CURRENT_USER)
    .eq('type', 'finance_intent')
    .eq('status', 'active')
    .order('created_at');

  if (error) return res.status(500).json({ error: error.message });

  const items = [];
  for (const row of data || []) {
    const parsed = decodeIntent(row.title);
    // A row whose title does not parse is skipped rather than guessed at. It
    // would have to have been written by something other than this endpoint.
    if (!parsed) continue;
    items.push({ id: row.id, ...parsed, body: row.body || '' });
  }

  res.json({ kinds: INTENT_KINDS, modes: RESERVE_MODES, items });
});

router.post('/finance-intent', async (req, res) => {
  const body = req.body || {};
  const problem = validateIntent(body);
  if (problem) return res.status(400).json({ error: problem });

  const row = await create_entry(CURRENT_USER, {
    type: 'finance_intent',
    title: encodeIntent(body.kind, body.mode, String(body.label).trim()),
    body: String(body.body || '').trim() || null,
  });

  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ entry: { id: row.id, ...decodeIntent(row.title), body: row.body || '' } });
});

router.post('/finance-intent/:id/update', async (req, res) => {
  const body = req.body || {};

  // The kind is fixed once written. Changing a target into a slip is not an
  // edit, it is a different declaration, and silently rewriting it would leave
  // no trace of what was originally said.
  const { data: current, error: readErr } = await supabase
    .from('entries')
    .select('title')
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .eq('type', 'finance_intent')
    .eq('status', 'active')
    .maybeSingle();

  if (readErr) return res.status(500).json({ error: readErr.message });
  if (!current) return res.status(404).json({ error: 'not found' });

  const existing = decodeIntent(current.title);
  if (!existing) return res.status(400).json({ error: 'this row cannot be read' });

  const next = {
    kind: existing.kind,
    mode: body.mode !== undefined ? body.mode : existing.mode,
    label: body.label !== undefined ? String(body.label).trim() : existing.label,
  };

  const problem = validateIntent(next);
  if (problem) return res.status(400).json({ error: problem });

  const fields = { title: encodeIntent(next.kind, next.mode, next.label) };
  if (body.body !== undefined) fields.body = String(body.body).trim() || null;

  const row = await update_entry(CURRENT_USER, req.params.id, fields);
  if (row.error) return res.status(400).json({ error: row.error });

  res.json({ entry: { id: row.id, ...decodeIntent(row.title), body: row.body || '' } });
});

router.post('/finance-intent/:id/delete', async (req, res) => {
  const row = await update_entry(CURRENT_USER, req.params.id, { status: 'deleted' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

module.exports = router;
