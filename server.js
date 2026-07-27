// Web layer. Carries data, does no thinking.
//
// Everything here is arithmetic: reading rows, counting days, writing what the
// person typed. Nothing in this file calls the model.

require('dotenv').config();

const path = require('path');
const express = require('express');

const supabase = require('./db');
const { create_entry, update_entry, get_calendar } = require('./tools');
const { lastScheduled, daysBetween } = require('./staleness');
const { generateForPlan } = require('./messages');
const { readTransactions } = require('./sheet');
const { summarise } = require('./money');

// Requiring the scheduler starts its cron loop as a side effect, which is how
// delivery runs in this one process. Nothing is imported from it.
require('./scheduler');

// Until there is real auth, every request is this one person.
const CURRENT_USER = '00000000-0000-0000-0000-000000000001';

// Railway (and most hosts) assign the port at runtime and route only to it.
// Falls back to 3000 when running locally.
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // not just localhost, so the phone can reach it

const TYPES = ['habit', 'project', 'task'];
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

const app = express();

app.use(express.json());
// The page is revalidated on every load, the assets are not.
//
// index.html is the whole app: markup, styles and script in one file. Letting
// a browser reuse it without asking means a fixed bug keeps rendering, which
// has already happened twice. `no-cache` is not "do not store", it is "ask
// first", so an unchanged page still costs one 304 rather than a download.
// Icons carry hashes in name only, but they change rarely and are cheap.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// The `messages` table is no longer read or written. It is deliberately left
// in place with its rows: dropping a table is the one move that cannot be
// undone, and an unread table costs nothing.

// --- which build is this ----------------------------------------------------

const STARTED_AT = new Date().toISOString();

/**
 * What is actually running.
 *
 * "Has it deployed yet" has cost several rounds of guessing, answered only by
 * probing for a route that happens to be new and inferring from a 404. The
 * host sets the commit it built, so this reports it directly.
 */
app.get('/version', (req, res) => {
  res.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    deployed: process.env.RAILWAY_DEPLOYMENT_ID || null,
    started_at: STARTED_AT,
    node: process.version,
    // Named so a stale build is obvious without knowing any commit hash.
    lanes: ['planner', 'money'],
    scheduler: process.env.SCHEDULER_DISABLED === '1' ? 'DISABLED' : 'running',
  });
});

// --- staleness --------------------------------------------------------------

// Today where this person lives. Counting days against the server's date would
// be off by one for most of their evening, which is exactly when they open it.
function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Habits, projects and tasks in one list, coldest first.
 *
 * A task left three weeks is the same problem as a project left three weeks,
 * so they share a list rather than being filed apart. Anything never scheduled
 * counts from the day it was added, which is the honest answer to "how long has
 * this been sitting there".
 */
app.get('/entries', async (req, res) => {
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
      .select('id, type, title, why, frequency, sort_order, cold, cold_reason, paused_at, created_at')
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

// --- calendar ---------------------------------------------------------------

// Wall-clock minutes past midnight, where this person lives.
//
// get_calendar returns UTC instants. Converting them here rather than in the
// browser keeps the app doing pure arithmetic: it lays blocks out on a number
// line and never has to know what a timezone is.
function minutesOfDay(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(iso))
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  return Number(parts.hour) * 60 + Number(parts.minute);
}

/**
 * The day's fixed commitments, as pinned blocks.
 *
 * These hours are already gone. The builder lays everything else out around
 * them and never moves them.
 */
app.get('/calendar/:date', async (req, res) => {
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

// --- the plan ---------------------------------------------------------------

const hhmmss = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;

const toMinutes = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

/**
 * A saved plan, if there is one, in the shape the builder holds in memory.
 *
 * Without this a confirmed plan would vanish on the next page load and the
 * person would rebuild it from scratch, which is a good way to stop trusting
 * the button.
 */
app.get('/plan/:date', async (req, res) => {
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
app.post('/plan', async (req, res) => {
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

// --- review -----------------------------------------------------------------

const yesterdayOf = (date) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Yesterday, for marking what did not happen.
 *
 * Blocks are assumed done. The posture is trust: nothing here asks the person
 * to confirm the ordinary case, only to correct it. An empty answer means
 * yesterday was never planned, which is not a failure and is not scolded.
 */
app.get('/review', async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profile')
      .select('timezone')
      .eq('user_id', CURRENT_USER)
      .maybeSingle();

    const date = yesterdayOf(todayIn((profile && profile.timezone) || 'UTC'));

    const { data: plan, error: planErr } = await supabase
      .from('plans')
      .select('id')
      .eq('user_id', CURRENT_USER)
      .eq('date', date)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (planErr) return res.status(500).json({ error: planErr.message });
    if (!plan) return res.json({ date, blocks: [] });

    const { data: rows, error } = await supabase
      .from('blocks')
      .select('id, title, start_time, duration_minutes, pinned, completed, miss_reason')
      .eq('plan_id', plan.id)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });

    res.json({
      date,
      blocks: (rows || []).map((b) => ({
        id: b.id,
        title: b.title,
        start_minutes: toMinutes(b.start_time),
        duration_minutes: b.duration_minutes,
        pinned: b.pinned,
        completed: b.completed,
        miss_reason: b.miss_reason,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Mark a block missed, or put it back.
 *
 * The reason is optional and always has been. A miss with no explanation is
 * still worth recording, and demanding one is how a review stops being done.
 */
app.post('/blocks/:id/miss', async (req, res) => {
  const body = req.body || {};
  const missed = body.missed !== false;
  const reason = String(body.reason || '').trim();

  const { data, error } = await supabase
    .from('blocks')
    .update({
      completed: !missed,
      // Clearing the flag clears the reason with it, so an un-marked block
      // cannot keep an explanation for something that did happen.
      miss_reason: missed ? reason || null : null,
    })
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .select('id, completed, miss_reason')
    .maybeSingle();

  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'block not found' });

  res.json({ id: data.id, completed: data.completed, miss_reason: data.miss_reason });
});

// --- finance numbers --------------------------------------------------------

/**
 * The finance screen, counted.
 *
 * Reads the sheet, counts, answers, and keeps nothing. No transaction reaches
 * the database and none is cached. Pure arithmetic: no model call, and no
 * judgment about what any of it means.
 */
app.get('/finance-summary', async (req, res) => {
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

// --- finance intent ---------------------------------------------------------
//
// What the person has declared about their own situation, held as ordinary
// entries. Nothing here reaches a prompt or the model, and no amount, account
// or threshold appears anywhere in this file. That is rule 2.4: the engine is
// byte-identical for someone with three hundred dollars and someone with three
// hundred thousand, and the only thing that differs is their rows.
//
// The kind lives in the title, encoded as `kind: label`, or `reserve/wall:` and
// `reserve/floor:` where the distinction matters. A wall has to be crossed
// deliberately; a floor can be reached by doing nothing, and the two are worth
// different messages. Encoding it here rather than adding a column keeps the
// lane inside the existing schema.

const INTENT_KINDS = ['situation', 'reserve', 'target', 'declared', 'slip'];
const RESERVE_MODES = ['wall', 'floor'];

const encodeIntent = (kind, mode, label) =>
  kind === 'reserve' ? `${kind}/${mode}: ${label}` : `${kind}: ${label}`;

function decodeIntent(title) {
  const m = String(title || '').match(/^([a-z]+)(?:\/(wall|floor))?:\s*([\s\S]+)$/);
  if (!m || !INTENT_KINDS.includes(m[1])) return null;
  return { kind: m[1], mode: m[2] || null, label: m[3].trim() };
}

function validateIntent({ kind, mode, label }) {
  if (!INTENT_KINDS.includes(kind)) {
    return `kind must be one of ${INTENT_KINDS.join(', ')}`;
  }
  if (!String(label || '').trim()) return 'a label is required';
  if (kind === 'reserve' && !RESERVE_MODES.includes(mode)) {
    return 'a reserve is either a wall, crossed on purpose, or a floor, reached by doing nothing. Say which.';
  }
  return null;
}

/**
 * The setup interview, as a prompt to take elsewhere.
 *
 * Engine text: identical for every user, and containing nothing about anyone.
 * Served rather than kept in the page so there is one copy of it, and so the
 * client only ever repeats what it was given.
 */
const SETUP_PROMPT = `I want you to interview me about my finances so another system can understand my situation. Act as a financial advisor taking someone on: curious, direct, and not judgemental about anything I tell you.

Ask me about all of these, but conversationally, one or two questions at a time. Wait for my answers before moving on. Do not present this as a form or a wall of questions.

1. Income. How much, how regular, and when it arrives. If it is irregular or has not started yet, get the timing.
2. What is in the bank now, and anything owed to me that has not arrived.
3. Any account or amount I treat as off limits. For each one, establish whether reaching it would need a deliberate transfer, or whether it could be reached passively by ordinary spending. This distinction matters, so ask about it directly.
4. What I am building toward. What the money is for.
5. Spending I have consciously chosen and do not want questioned. Things I have already decided are worth it.
6. Categories I already know I overspend on. I know about these; the point is that nobody needs to discover them for me.

Follow up where an answer is vague. Numbers are useful. If I do not know something, record that rather than guessing.

When we are done, output a single fenced json block and nothing after it. No summary, no closing remarks, just the block:

\`\`\`json
{
  "intents": [
    { "kind": "situation", "title": "short label", "body": "the detail in my own words" },
    { "kind": "reserve", "title": "short label", "body": "the detail, and state explicitly whether this is a wall or a floor" },
    { "kind": "target", "title": "short label", "body": "the detail" },
    { "kind": "declared", "title": "short label", "body": "the detail" },
    { "kind": "slip", "title": "short label", "body": "the detail" }
  ]
}
\`\`\`

Rules for the block:
- kind must be exactly one of: situation, reserve, target, declared, slip.
- One entry per distinct thing I told you. Several of the same kind is fine and expected.
- Every reserve entry must say the word wall or the word floor in its body.
- Leave out any kind I had nothing to say about.
- title is a few words. body is the substance.`;

app.get('/finance-intent/setup-prompt', (req, res) => {
  res.json({ prompt: SETUP_PROMPT });
});

/**
 * Save a whole interview at once.
 *
 * All or nothing. Every row is validated before any is written, so a paste
 * that is half understood leaves nothing behind rather than a partial picture
 * that looks complete. Existing rows are untouched: this appends.
 */
app.post('/finance-intent/import', async (req, res) => {
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

app.get('/finance-intent', async (req, res) => {
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

app.post('/finance-intent', async (req, res) => {
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

app.post('/finance-intent/:id/update', async (req, res) => {
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

app.post('/finance-intent/:id/delete', async (req, res) => {
  const row = await update_entry(CURRENT_USER, req.params.id, { status: 'deleted' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

// --- writing ----------------------------------------------------------------

// What the form is allowed to leave out, and what it is not. Checked here
// rather than in the database so the message can name the field.
function validate({ type, title, why, frequency }) {
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
  return null;
}

app.post('/entries', async (req, res) => {
  const body = req.body || {};
  const problem = validate(body);
  if (problem) return res.status(400).json({ error: problem });

  // Only the fields that belong to this type. A habit carrying a why, or a
  // task carrying a frequency, would be noise nothing reads.
  const fields = { type: body.type, title: String(body.title).trim() };
  if (body.type === 'habit') fields.frequency = body.frequency;
  if (body.type === 'project') fields.why = String(body.why).trim();

  const row = await create_entry(CURRENT_USER, fields);
  if (row.error) return res.status(400).json({ error: row.error });

  // New things go to the top: adding something is thinking about it now.
  //
  // Taking one below the current minimum rather than renumbering the list
  // means nothing else moves, so a position the person chose cannot be
  // disturbed by an unrelated addition.
  const { data: first } = await supabase
    .from('entries')
    .select('sort_order')
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .in('type', TYPES)
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
app.post('/entries/reorder', async (req, res) => {
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
app.post('/entries/:id/update', async (req, res) => {
  const body = req.body || {};
  const fields = {};

  for (const key of ['title', 'why', 'frequency']) {
    if (body[key] !== undefined) fields[key] = String(body[key]).trim();
  }

  const { data: current, error: readErr } = await supabase
    .from('entries')
    .select('type, title, why, frequency')
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
app.post('/entries/:id/pause', async (req, res) => {
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

app.post('/entries/:id/delete', async (req, res) => {
  const row = await update_entry(CURRENT_USER, req.params.id, { status: 'deleted' });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

// Token spend is still recorded on every model call, and usage.summary() still
// works. It is simply not exposed: a usage readout is noise for anyone using
// this to plan their day, and cost is a thing to check, not a thing to watch.

app.listen(PORT, HOST, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`on your phone, use http://<this-machine's-lan-ip>:${PORT}`);
});
