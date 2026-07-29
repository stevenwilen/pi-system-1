// Marking a block missed.
//
// Blocks are assumed done. The posture is trust: nothing here asks the person
// to confirm the ordinary case, only to correct it.
//
// This used to be half of a screen that asked about yesterday the next
// morning, and the read half of it is gone. The question is asked in place
// now, on today's own blocks as they pass, so it arrives while the answer is
// still obvious rather than a day late.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');

const router = express.Router();

/**
 * Mark a block missed, or put it back.
 *
 * The reason is optional and always has been. A miss with no explanation is
 * still worth recording, and demanding one is how a review stops being done.
 */
router.post('/blocks/:id/miss', async (req, res) => {
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

module.exports = router;
