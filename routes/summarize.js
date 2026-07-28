// One endpoint: tidy up the text of one field.
//
// The only route in this folder that reaches the model, and it reaches a narrow
// one that holds no tools (../summarize.js). It reads nothing, writes nothing,
// and touches no row. What comes back is handed to the page, which decides
// whether to put it in the field.

const express = require('express');

const { summarize, MAX_INPUT } = require('../summarize');
const { CURRENT_USER } = require('../user');

const router = express.Router();

router.post('/summarize', async (req, res) => {
  const text = String((req.body && req.body.text) || '');

  // Answered here rather than spent on a call. An empty field cannot be
  // tidied, and the button is disabled on one anyway; this is the second lock.
  if (!text.trim()) return res.status(400).json({ error: 'There is nothing there yet.' });
  if (text.length > MAX_INPUT) {
    return res.status(400).json({ error: 'That is longer than this will tidy up.' });
  }

  try {
    res.json({ text: await summarize(CURRENT_USER, text) });
  } catch (err) {
    // The field keeps what it had. The page says so quietly and the reason is
    // in the log, because the person cannot act on it either way.
    console.error(`[SUMMARIZE] ${err.message}`);
    res.status(502).json({ error: 'Could not tidy that up. Your text is unchanged.' });
  }
});

module.exports = router;
