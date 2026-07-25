// Web layer. Carries messages, does no thinking.

require('dotenv').config();

const path = require('path');
const express = require('express');

const supabase = require('./db');
const { runBrain } = require('./brain');
const { search_entries, update_entry } = require('./tools');
const { summary } = require('./usage');

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

app.post('/observations/:id/edit', async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  // user_corrected is written here rather than through update_entry on
  // purpose. It marks text as the user's own wording, which the brain must
  // then leave alone — so the brain must have no way to set it. Keeping it
  // out of the tools.js whitelist keeps that authority one-directional.
  const { data, error } = await supabase
    .from('entries')
    .update({ title: text, user_corrected: true })
    .eq('id', req.params.id)
    .eq('user_id', CURRENT_USER)
    .eq('type', 'observation')
    .eq('status', 'active')
    .select()
    .maybeSingle();

  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'observation not found' });
  res.json({ observation: data });
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

// Single user, single service: run the scheduled jobs in this same process.
// Requiring scheduler.js starts its cron loop as a side effect.
require('./scheduler');
