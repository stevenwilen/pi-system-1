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
app.use(express.static(path.join(__dirname, 'public')));

// The `messages` table is no longer read or written. It is deliberately left
// in place with its rows: dropping a table is the one move that cannot be
// undone, and an unread table costs nothing.

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
      .select('id, type, title, why, priority, frequency, paused_at, created_at')
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
        priority: r.priority,
        frequency: r.frequency,
        paused: Boolean(r.paused_at),
        last_scheduled: seen,
        days: Math.max(0, daysBetween(since, today)),
      };
    });

    const coldestFirst = (a, b) => b.days - a.days || a.title.localeCompare(b.title);

    res.json({
      today,
      timezone: timeZone,
      wake_time: String((profile && profile.default_wake_time) || '07:00').slice(0, 5),
      // Paused items are kept out of the main list but returned, so unpausing
      // is one tap. Hiding them would turn a pause into an accidental delete.
      items: items.filter((i) => !i.paused).sort(coldestFirst),
      paused: items.filter((i) => i.paused).sort(coldestFirst),
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

  // Only the fields that belong to this type. A habit carrying a priority or a
  // task carrying a why would be noise nothing reads.
  const fields = { type: body.type, title: String(body.title).trim() };
  if (body.type === 'habit') fields.frequency = body.frequency;
  if (body.type === 'project') {
    fields.why = String(body.why).trim();
    if (body.priority != null && body.priority !== '') {
      fields.priority = Number(body.priority);
    }
  }

  const row = await create_entry(CURRENT_USER, fields);
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ entry: row });
});

app.post('/entries/:id/update', async (req, res) => {
  const body = req.body || {};
  const fields = {};

  for (const key of ['title', 'why', 'frequency']) {
    if (body[key] !== undefined) fields[key] = String(body[key]).trim();
  }
  if (body.priority !== undefined) {
    fields.priority = body.priority === '' ? null : Number(body.priority);
  }

  if (fields.title !== undefined && !fields.title) {
    return res.status(400).json({ error: 'a title is required' });
  }
  if (fields.frequency !== undefined && !FREQUENCIES.includes(fields.frequency)) {
    return res.status(400).json({ error: `frequency must be one of ${FREQUENCIES.join(', ')}` });
  }

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
