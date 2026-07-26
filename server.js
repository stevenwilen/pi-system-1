// Web layer. Carries messages, does no thinking.

require('dotenv').config();

const path = require('path');
const express = require('express');

const supabase = require('./db');
const { runBrain } = require('./brain');
const { search_entries, update_entry } = require('./tools');
const { summary } = require('./usage');

// Requiring the scheduler starts its cron loop as a side effect, which is how
// the jobs run in this one process. It also gives us the morning hour, so the
// overview can describe the schedule without hardcoding it a second time.
const { MORNING_HOUR } = require('./scheduler');

// Until there is real auth, every request is this one person.
const CURRENT_USER = '00000000-0000-0000-0000-000000000001';

// Railway (and most hosts) assign the port at runtime and route only to it.
// Falls back to 3000 when running locally.
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // not just localhost, so the phone can reach it
const HISTORY_LIMIT = 20;

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// The last N turns, oldest first — the order the brain wants to read them in.
async function loadHistory(user_id) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) throw new Error(`could not load history: ${error.message}`);
  return data.reverse();
}

async function saveMessage(user_id, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ user_id, role, content });

  if (error) throw new Error(`could not save message: ${error.message}`);
}

app.post('/chat', async (req, res) => {
  const { user_id, message } = req.body || {};

  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    // History is loaded before the new message is saved, so the incoming
    // message reaches the brain once, as the argument — not twice.
    const history = await loadHistory(user_id);
    await saveMessage(user_id, 'user', message);

    console.log(`\n[CHAT] ${user_id} :: ${message}`);
    const reply = await runBrain(user_id, message, history);

    await saveMessage(user_id, 'assistant', reply);
    res.json({ reply });
  } catch (err) {
    console.error('[FAIL]', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    .select('id, type, title, body, why, priority, frequency, created_at')
    .eq('user_id', CURRENT_USER)
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const of = (t) => (entries || []).filter((e) => e.type === t);

  const wake = hhmm(profile && profile.default_wake_time) || '07:00';
  const morning = `${String(MORNING_HOUR).padStart(2, '0')}:00`;

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
    tasks: of('task'),
    ideas: of('idea'),
    waiting: of('waiting'),
    schedule: [
      { label: 'Day plan', when: `Every day at ${wake}` },
      { label: 'Open tasks', when: `Mondays at ${morning}` },
      { label: 'Habit review', when: `Wednesdays at ${morning}` },
      { label: 'Project review', when: `Fridays at ${morning}` },
      { label: 'Ideas', when: `Tuesdays and Saturdays at ${morning}` },
      { label: 'Waiting on', when: `Thursdays at ${morning}` },
      { label: 'Week ahead', when: `Sundays at ${morning}` },
      // Only shown to the owner, because only the owner receives it.
      ...(process.env.FINANCE_OWNER_USER_ID === CURRENT_USER
        ? [{ label: 'Finance check-in', when: 'Wednesdays and Sundays at 18:00' }]
        : []),
    ],
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
