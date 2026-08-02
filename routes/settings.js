// The two things a person has to configure, and the proof that each works.
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

const router = express.Router();

// Telegram chat ids are integers. Personal chats are positive, groups and
// channels negative, and they can exceed 32 bits — so this stays a string all
// the way to the wire and is never parsed into a number.
const CHAT_ID = /^-?\d{1,20}$/;

// One calendar, and one column. `calendar_action_ics_url` is still in the
// schema and is deliberately not written here: nothing reads it, and a settings
// screen that could still fill it would keep the second feed alive in the data
// long after it went out of the code.
const CALENDAR_COLUMN = 'calendar_ics_url';

// EVERY WRITE BELOW IS AN UPSERT, and that is the fix for the one bug in this
// file that reached a real person.
//
// They were UPDATEs. An UPDATE that matches no row is not an error — it
// reports, truthfully, that nothing changed — so an account with no profile row
// got `no profile for this account` from every save on this screen. Nothing
// created a profile row: not the page, not the server, and the sign-up posts
// straight to Supabase without passing through this deployment at all. So that
// was every account, on the first thing it was asked to do.
//
// migration-profile-on-signup.sql is the primary fix and creates the row at the
// moment the account does. This is the second layer, and it is worth having
// even once that trigger is in place: it is what makes these routes correct on
// a database where the migration has not been run yet, and the account that
// finds out otherwise is a new one — the case least likely to be tested and
// most expensive to lose.
//
// THE user_id FILTER HAS NOT BEEN DROPPED, it moved into the payload. An INSERT
// has nothing to filter; what scopes it is the user_id it carries, which comes
// from the verified token and nowhere else. The `profile_own` policy checks
// that same value again with `with check (user_id = auth.uid())` — the
// duplication server.js describes is intact, one claim in the code and one in
// the database.
//
// Each write names only its own column, so the ON CONFLICT branch updates only
// that column. Linking a chat does not disturb a calendar url, and neither
// touches a timezone.

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
    .select(`telegram_chat_id, ${CALENDAR_COLUMN}, timezone`)
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
    calendar: {
      set: Boolean(profile && profile[CALENDAR_COLUMN]),
      hint: hint(profile && profile[CALENDAR_COLUMN]),
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
    .upsert({ user_id: userId, telegram_chat_id: chat_id }, { onConflict: 'user_id' })
    .select('telegram_chat_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  // Kept, and it finally means what it says. It used to fire for an account
  // that simply had no row yet, which is why it read as "you do not exist"
  // to everyone who had just signed up. A row that is not yours is now the
  // only thing it can be about — and a policy refusal raises rather than
  // returning nothing, so this is a floor under a case with no known way of
  // being reached, not a branch anybody is expected to see.
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
    .upsert({ user_id: userId, telegram_chat_id: null }, { onConflict: 'user_id' })
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
 *
 * The probe runs BEFORE the write and that is now free of the trap it used to
 * carry. While this was an UPDATE, a new account waited out a ten-second feed
 * fetch and was then told it had no profile — the probe was paid for and thrown
 * away, and the slowest possible request ended in the least useful answer.
 * There is no refusal on that path any more.
 */
router.post('/settings/calendar', async (req, res) => {
  const { db, userId } = req.auth;
  const body = req.body || {};

  // null and '' both mean "clear it".
  const url = body.url === null ? '' : String(body.url || '').trim();

  if (!url) {
    const { data, error } = await db
      .from('profile')
      .upsert({ user_id: userId, [CALENDAR_COLUMN]: null }, { onConflict: 'user_id' })
      .select('user_id')
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'no profile for this account' });
    return res.json({ cleared: true });
  }

  const probe = await probeFeed(url);

  const { data, error } = await db
    .from('profile')
    .upsert({ user_id: userId, [CALENDAR_COLUMN]: url }, { onConflict: 'user_id' })
    .select('user_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'no profile for this account' });

  res.json({ hint: hint(url), ...probe });
});

module.exports = router;
