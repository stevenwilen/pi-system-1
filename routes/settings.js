// Everything a person has to configure, and the proof that it works.
//
// THE WHOLE POINT IS THE VERIFICATION. Every value here is one that looks
// perfectly correct when it is wrong. A mistyped chat id is still ten digits.
// A revoked calendar url is still a url. Neither says anything until the day a
// message does not arrive or an aside is empty, and by then the paste that
// caused it was days ago. So saving is not "store this", it is "store this and
// tell me what happened when I tried it".
//
// Three outcomes are kept apart everywhere below, because collapsing any two
// of them is how someone ends up debugging the wrong thing:
//
//   works            reachable, and here is what was in it
//   works, empty     reachable, and there was nothing in it
//   does not work    and here is what it said

const express = require('express');

const { sendToChat } = require('../telegram');
const { probeFeed } = require('../tools');
const { validate, toRow } = require('../entry-shape');

const router = express.Router();

// Telegram chat ids are integers. Personal chats are positive, groups and
// channels negative, and they can exceed 32 bits — so this stays a string all
// the way to the wire and is never parsed into a number.
const CHAT_ID = /^-?\d{1,20}$/;

const FEEDS = [
  { key: 'calendar_ics_url', label: 'things to know' },
  { key: 'calendar_action_ics_url', label: 'things to do' },
];

/**
 * Enough to recognise, not enough to use.
 *
 * A Google "secret address in iCal format" is a bearer credential: whoever
 * holds the string can read that calendar for ever, with no sign-in. So the
 * sheet has to be able to say "this is set" without ever putting the string
 * back on a screen, into a screenshot, or into a browser's memory.
 *
 * Host and last path segment only. Both are generic — every Google feed ends
 * in basic.ics — and the secret is the segment between them, which never
 * leaves the server.
 */
function hint(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.host}/…/${last}`;
  } catch {
    return 'set';
  }
}

/** Last four digits, so a person can tell which chat without publishing it. */
function chatHint(id) {
  if (!id) return null;
  const s = String(id);
  return s.length <= 4 ? s : `…${s.slice(-4)}`;
}

async function profileOf(db, userId) {
  const { data, error } = await db
    .from('profile')
    .select('telegram_chat_id, calendar_ics_url, calendar_action_ics_url, timezone')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

function stateOf(profile) {
  return {
    telegram: {
      set: Boolean(profile && profile.telegram_chat_id),
      hint: chatHint(profile && profile.telegram_chat_id),
    },
    calendar_ics_url: {
      set: Boolean(profile && profile.calendar_ics_url),
      hint: hint(profile && profile.calendar_ics_url),
    },
    calendar_action_ics_url: {
      set: Boolean(profile && profile.calendar_action_ics_url),
      hint: hint(profile && profile.calendar_action_ics_url),
    },
    timezone: (profile && profile.timezone) || 'UTC',
  };
}

/** What is configured, in a shape that reveals nothing. */
router.get('/settings', async (req, res) => {
  const { db, userId } = req.auth;
  try {
    res.json(stateOf(await profileOf(db, userId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- telegram ----------------------------------------------------------------

/**
 * Link a chat, and prove it.
 *
 * Written first, then tested. The other order — send, save only if it arrived
 * — sounds safer and is worse: someone whose message arrived but whose row was
 * never written would have a bot that answered a test and then went quiet.
 *
 * So the row is written, the proof is attempted, and the answer says which of
 * those happened. Saved-but-unproved is a state you can see and act on;
 * proved-but-unsaved is a lie.
 */
router.post('/telegram', async (req, res) => {
  const { db, userId } = req.auth;

  const chat_id = String((req.body || {}).chat_id || '').trim();

  if (!chat_id) return res.status(400).json({ error: 'a chat id is required' });
  if (!CHAT_ID.test(chat_id)) {
    return res.status(400).json({
      error: `not a chat id: ${chat_id}. It is a number — message @userinfobot on Telegram to find yours.`,
    });
  }

  const { data, error } = await db
    .from('profile')
    .update({ telegram_chat_id: chat_id })
    .eq('user_id', userId)
    .select('telegram_chat_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  // No row came back, and row level security is why: an account with no
  // profile row has nothing to update, and the policy makes that look the same
  // as somebody else's row. Both are "not yours to write".
  if (!data) return res.status(404).json({ error: 'no profile for this account' });

  const proof = await sendToChat(chat_id, 'Linked. Your day will arrive here.');

  if (proof.sent) return res.json({ chat_id: chatHint(chat_id), delivered: true });

  res.json({
    chat_id: chatHint(chat_id),
    delivered: false,
    error: proof.error || 'the message did not arrive',
  });
});

/**
 * Unlink. Nothing is sent, because there is nowhere to send it.
 *
 * Clearing what was never set is not an error. Answering the same way either
 * time means the caller never has to check first.
 */
router.post('/telegram/clear', async (req, res) => {
  const { db, userId } = req.auth;

  const { data, error } = await db
    .from('profile')
    .update({ telegram_chat_id: null })
    .eq('user_id', userId)
    .select('user_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'no profile for this account' });

  res.json({ chat_id: null, cleared: true });
});

// --- calendars ---------------------------------------------------------------

/**
 * Set or clear one feed, having tried it.
 *
 * A url that cannot be read is STILL SAVED, and the answer says so. The
 * alternative is refusing it, which is wrong twice over: a feed can be
 * unreachable for a minute for reasons that have nothing to do with the url,
 * and a person who has just pasted the right thing should not have to paste it
 * again because a network blinked. What must never happen is saving it and
 * reporting success.
 */
router.post('/settings/calendar', async (req, res) => {
  const { db, userId } = req.auth;
  const body = req.body || {};

  const which = String(body.which || '');
  const feed = FEEDS.find((f) => f.key === which);
  if (!feed) {
    return res.status(400).json({ error: `which must be one of ${FEEDS.map((f) => f.key).join(', ')}` });
  }

  // null and '' both mean "clear it".
  const url = body.url === null ? '' : String(body.url || '').trim();

  if (!url) {
    const { data, error } = await db
      .from('profile')
      .update({ [feed.key]: null })
      .eq('user_id', userId)
      .select('user_id')
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'no profile for this account' });
    return res.json({ which, cleared: true });
  }

  const probe = await probeFeed(url);

  const { data, error } = await db
    .from('profile')
    .update({ [feed.key]: url })
    .eq('user_id', userId)
    .select('user_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'no profile for this account' });

  res.json({ which, hint: hint(url), ...probe });
});

// --- the paste ---------------------------------------------------------------

/**
 * The JSON out of a setup conversation, however it arrives.
 *
 * Bare, in a ```json fence, or with a paragraph of chat either side. People
 * paste what they can select, and refusing anything but a bare object would
 * make the commonest paste in the world an error message.
 *
 * The LAST balanced object is taken, not the first. A setup conversation
 * usually shows the shape before it fills it in, so the first `{` in the
 * transcript is an example and the last one is the answer.
 */
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'nothing pasted' };

  const tryParse = (s) => {
    try {
      return { value: JSON.parse(s) };
    } catch {
      return null;
    }
  };

  const bare = tryParse(raw);
  if (bare) return bare;

  // A fenced block, with or without a language tag.
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const block of fences.reverse()) {
    const parsed = tryParse(block);
    if (parsed) return parsed;
  }

  // Buried in prose: scan for balanced braces, take the last one that parses.
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) found.push(raw.slice(start, i + 1));
    }
  }

  for (const candidate of found.reverse()) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }

  return { error: 'could not find any JSON in that' };
}

/**
 * Read the paste and say exactly what would happen, without touching a row.
 *
 * Every check the import runs, run here first. The preview and the import must
 * not be able to disagree — a preview that says one thing and an import that
 * does another is worse than no preview.
 */
async function inspect(paste) {
  const { value, error } = extractJson(paste);
  if (error) return { error };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'that is JSON, but not an object' };
  }

  const plan = { telegram: null, feeds: [], items: [], problems: [] };

  // --- telegram
  if (value.telegram_chat_id !== undefined && value.telegram_chat_id !== null) {
    const chat_id = String(value.telegram_chat_id).trim();
    if (!CHAT_ID.test(chat_id)) {
      plan.problems.push(`telegram_chat_id is not a chat id: ${chat_id}`);
    } else {
      plan.telegram = { chat_id, hint: chatHint(chat_id) };
    }
  }

  // --- feeds
  for (const feed of FEEDS) {
    if (value[feed.key] === undefined || value[feed.key] === null) continue;
    const url = String(value[feed.key]).trim();
    if (!url) continue;
    plan.feeds.push({ key: feed.key, label: feed.label, url, hint: hint(url) });
  }

  // --- items
  //
  // ALL OR NOTHING. A paste is one answer to one conversation, and half of it
  // in the notebook is worse than none: the person cannot tell which half, and
  // running it again would duplicate whatever did land.
  const items = value.items === undefined ? [] : value.items;
  if (!Array.isArray(items)) {
    plan.problems.push('items must be a list');
  } else {
    items.forEach((item, i) => {
      const problem = validate(item || {});
      if (problem) plan.problems.push(`item ${i + 1} (${(item || {}).title || 'untitled'}): ${problem}`);
      else plan.items.push(toRow(item));
    });
  }

  return plan;
}

/** Try everything the plan proposes, without writing anything. */
async function proveOut(plan) {
  const checks = { telegram: null, feeds: [] };

  if (plan.telegram) {
    const proof = await sendToChat(plan.telegram.chat_id, 'Linked. Your day will arrive here.');
    checks.telegram = proof.sent
      ? { delivered: true, hint: plan.telegram.hint }
      : { delivered: false, hint: plan.telegram.hint, error: proof.error || 'it did not arrive' };
  }

  for (const feed of plan.feeds) {
    checks.feeds.push({ key: feed.key, label: feed.label, hint: feed.hint, ...(await probeFeed(feed.url)) });
  }

  return checks;
}

router.post('/settings/preview', async (req, res) => {
  const plan = await inspect((req.body || {}).paste);
  if (plan.error) return res.status(400).json({ error: plan.error });

  res.json({
    telegram: plan.telegram ? { hint: plan.telegram.hint } : null,
    feeds: plan.feeds.map((f) => ({ key: f.key, label: f.label, hint: f.hint })),
    items: plan.items,
    problems: plan.problems,
    checks: plan.problems.length ? null : await proveOut(plan),
  });
});

/**
 * Write it, all of it or none of it.
 *
 * The refusal comes first and covers everything: a malformed item stops the
 * telegram id and the calendars being saved too. That is the point of pasting
 * one object — it is one answer, and applying the parts of it that happened to
 * parse would leave a half-configured account that nobody asked for.
 *
 * A failed CHECK is not a refusal. An unreachable calendar is still saved and
 * still reported, for the same reason as the single-field route above: the
 * network is not the paste. What is refused is a paste that does not make
 * sense.
 */
router.post('/settings/import', async (req, res) => {
  const { db, userId } = req.auth;

  const plan = await inspect((req.body || {}).paste);
  if (plan.error) return res.status(400).json({ error: plan.error });

  if (plan.problems.length) {
    return res.status(400).json({
      error: 'nothing was saved',
      problems: plan.problems,
    });
  }

  const patch = {};
  if (plan.telegram) patch.telegram_chat_id = plan.telegram.chat_id;
  for (const feed of plan.feeds) patch[feed.key] = feed.url;

  if (Object.keys(patch).length) {
    const { data, error } = await db
      .from('profile')
      .update(patch)
      .eq('user_id', userId)
      .select('user_id')
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'no profile for this account' });
  }

  const added = [];
  for (const row of plan.items) {
    const { data, error } = await db
      .from('entries')
      .insert({ ...row, user_id: userId })
      .select('id, title')
      .single();

    // Past the point of no return: the profile is written and some rows are in.
    // Saying which landed is the only useful thing left to do.
    if (error) {
      return res.status(500).json({
        error: `saved the settings and ${added.length} item(s), then failed on "${row.title}": ${error.message}`,
        added,
      });
    }
    added.push(data.title);
  }

  res.json({ saved: true, added, checks: await proveOut(plan) });
});

module.exports = router;
