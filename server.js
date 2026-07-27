// Web layer. Carries messages, does no thinking.

require('dotenv').config();

const path = require('path');
const express = require('express');

const supabase = require('./db');
const { search_entries, update_entry } = require('./tools');
const { summary } = require('./usage');

// Requiring the scheduler starts its cron loop as a side effect, which is how
// delivery runs in this one process. Nothing is imported from it.
require('./scheduler');

// Until there is real auth, every request is this one person.
const CURRENT_USER = '00000000-0000-0000-0000-000000000001';

// Railway (and most hosts) assign the port at runtime and route only to it.
// Falls back to 3000 when running locally.
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // not just localhost, so the phone can reach it

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// The `messages` table is no longer read or written. It is deliberately left
// in place with its rows: dropping a table is the one move that cannot be
// undone, and an unread table costs nothing.

// --- what I've noticed -----------------------------------------------------

app.get('/observations', async (req, res) => {
  const rows = await search_entries(CURRENT_USER, null, 'observation', 100);
  if (rows.error) return res.status(500).json({ error: rows.error });
  res.json({ observations: rows });
});

app.post('/observations/:id/delete', async (req, res) => {
  const row = await update_entry(CURRENT_USER, req.params.id, {
    status: 'deleted',
  });
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({ deleted: row.id });
});

// --- everything the system currently holds ---------------------------------

const hhmm = (t) => String(t || '').slice(0, 5);

app.get('/overview', async (req, res) => {
  const { data: profile } = await supabase
    .from('profile')
    .select('timezone, default_wake_time, telegram_chat_id')
    .eq('user_id', CURRENT_USER)
    .maybeSingle();

  const { data: entries, error } = await supabase
    .from('entries')
    .select('id, type, title, body, why, priority, due, frequency, created_at')
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const of = (t) => (entries || []).filter((e) => e.type === t);

  const wake = hhmm(profile && profile.default_wake_time) || '07:00';

  res.json({
    profile: {
      timezone: (profile && profile.timezone) || 'UTC',
      wake_time: wake,
      telegram_linked: Boolean(profile && profile.telegram_chat_id),
    },
    // Ranked as the brain sees them: priority first, then newest.
    projects: of('project').sort(
      (a, b) => (a.priority || 99) - (b.priority || 99)
    ),
    habits: of('habit'),
    // Ranked as the brain sees them. Unranked tasks sort last rather than
    // first, which is what an absent priority means.
    tasks: of('task').sort((a, b) => (a.priority || 99) - (b.priority || 99)),
    ideas: of('idea'),
    waiting: of('waiting'),
    // `schedule` is gone with the eight digest jobs. Nothing is delivered on a
    // timer until per-block sending is built, and reporting a schedule that no
    // longer runs is worse than reporting none.
  });
});

// --- usage ------------------------------------------------------------------

app.get('/usage', async (req, res) => {
  const result = await summary(CURRENT_USER);
  if (result.error) return res.status(500).json({ error: result.error });
  res.json(result);
});

app.listen(PORT, HOST, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`on your phone, use http://<this-machine's-lan-ip>:${PORT}`);
});
