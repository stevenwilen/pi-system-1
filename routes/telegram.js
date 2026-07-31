// Linking a Telegram chat to the account that is asking.
//
// One bot for everyone. The token is a fact about the deployment and lives in
// the environment; the chat_id is a fact about a person and lives on their row.
// Nothing here reads or writes anyone else's.
//
// THE SAVE SENDS. A chat_id is eight or ten digits and every one of them is
// well-formed, so a typo is indistinguishable from a correct value right up
// until the first block message fails to arrive at nine in the morning — by
// which point nobody connects the silence to the number they typed days
// earlier. So the link is not "saved", it is "proved": the message goes out
// while the person is still looking at the screen, and what comes back is
// whether it landed.

const express = require('express');

const { sendToChat } = require('../telegram');

const router = express.Router();

// Telegram chat ids are integers. Personal chats are positive, groups and
// channels negative, and they can exceed 32 bits — so this stays a string all
// the way to the wire and is never parsed into a number.
const CHAT_ID = /^-?\d{1,20}$/;

/**
 * Link a chat, or fail loudly.
 *
 * Written first, then tested. The other order — send, then save only if it
 * arrived — sounds safer and is worse: the send is the slow, failable part,
 * and a person whose message arrived but whose row was never written would
 * have a bot that answered a test and then went quiet forever.
 *
 * So the row is written, the proof is attempted, and the answer says which of
 * those happened. A saved-but-unproved link is a state the caller can see and
 * act on; a proved-but-unsaved one is a lie.
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
  // as somebody else's row. Both are "not yours to write", which is the right
  // answer to both.
  if (!data) return res.status(404).json({ error: 'no profile for this account' });

  const proof = await sendToChat(
    chat_id,
    'Linked. Your day will arrive here.'
  );

  if (proof.sent) {
    return res.json({ chat_id, delivered: true });
  }

  // Saved, and demonstrably not working. Both facts, because either one alone
  // would be misleading.
  res.json({
    chat_id,
    delivered: false,
    error: proof.error || 'the message did not arrive',
  });
});

/**
 * Unlink. Nothing is sent, because there is nowhere to send it.
 *
 * Clearing is allowed to be a no-op: unlinking an account that was never
 * linked is not a mistake worth an error, and answering the same way either
 * time means the caller never has to check first.
 */
router.post('/telegram/clear', async (req, res) => {
  const { db, userId } = req.auth;

  const { data, error } = await db
    .from('profile')
    .update({ telegram_chat_id: null })
    .eq('user_id', userId)
    .select('telegram_chat_id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'no profile for this account' });

  res.json({ chat_id: null, cleared: true });
});

module.exports = router;
