// Web layer. Carries messages, does no thinking.

require('dotenv').config();

const path = require('path');
const express = require('express');

const supabase = require('./db');
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
    .select('id, type, title, body, why, priority, frequency, created_at')
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
    // Projects keep their rank: it is the person's own stack, top to bottom.
    projects: of('project').sort(
      (a, b) => (a.priority || 99) - (b.priority || 99)
    ),
    habits: of('habit'),
    // Tasks are no longer ranked. They belong in the stale list beside habits
    // and projects, ordered by how long since they were last scheduled, which
    // needs blocks and so arrives with the stale panel. Newest-first until then.
    tasks: of('task'),
    // `ideas`, `waiting` and `schedule` are gone. Their rows still exist and
    // are untouched; nothing surfaces them any more.
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
