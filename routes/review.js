// Yesterday, and marking what did not happen.
//
// Blocks are assumed done. The posture is trust: nothing here asks the person
// to confirm the ordinary case, only to correct it.

const express = require('express');

const supabase = require('../db');
const { CURRENT_USER } = require('../user');
const { todayIn, yesterdayOf, toMinutes } = require('../clock');

const router = express.Router();

/**
 * Yesterday's blocks, if it was planned.
 *
 * An empty answer means yesterday was never planned, which is not a failure
 * and is not scolded.
 */
router.get('/review', async (req, res) => {
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
      .select('id, title, start_time, duration_minutes, completed, miss_reason')
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
