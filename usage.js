// Token metering and cost.
//
// Kept out of brain.js so that file stays about reasoning, and out of tools.js
// so it is never something the model can reach. Nothing here can fail loudly
// enough to cost you a reply — a metering error is logged and swallowed.

require('dotenv').config();

const supabase = require('./db');

// US dollars per million tokens. Cache reads are 0.1x input, cache writes
// 1.25x input at the 5-minute TTL.
const PRICING = {
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_write: 3.75,
  },
  'claude-opus-5': {
    input: 5.0,
    output: 25.0,
    cache_read: 0.5,
    cache_write: 6.25,
  },
};

const FALLBACK_MODEL = 'claude-sonnet-4-6';

function costOf(model, usage) {
  const p = PRICING[model] || PRICING[FALLBACK_MODEL];

  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.output_tokens || 0) * p.output +
      (usage.cache_read_input_tokens || 0) * p.cache_read +
      (usage.cache_creation_input_tokens || 0) * p.cache_write) /
    1e6
  );
}

/**
 * Record one API call. Called once per turn of the agent loop, so a reply
 * that used three tool calls writes three rows.
 */
async function recordUsage(user_id, source, model, usage) {
  if (!user_id || !usage) return;

  try {
    const { error } = await supabase.from('api_usage').insert({
      user_id,
      source: source || 'chat',
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      cost_usd: costOf(model, usage),
    });

    if (error) console.error(`[USAGE] could not record: ${error.message}`);
  } catch (err) {
    console.error(`[USAGE] could not record: ${err.message}`);
  }
}

// Write only, deliberately. Nothing reads api_usage: the Usage tab that once
// did was removed, and the rows are kept because they are the only record of
// what this costs to run. Reading them back is a query away whenever it is
// wanted, and does not need a function sitting here waiting.
//
// costOf and PRICING stay because recordUsage needs them. They are not
// exported: nothing outside this file has any business pricing a call.
module.exports = { recordUsage };
