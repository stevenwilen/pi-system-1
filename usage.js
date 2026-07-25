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

function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Everything the Usage tab needs. Money figures are in dollars.
 *
 * The balance is whatever you last topped up to — Anthropic exposes no
 * endpoint for a real balance, so CREDIT_BALANCE_USD is the number you set
 * and CREDIT_BALANCE_AS_OF is when you set it. Spend before that date does
 * not count against it.
 */
async function summary(user_id) {
  const { data: profile } = await supabase
    .from('profile')
    .select('timezone')
    .eq('user_id', user_id)
    .maybeSingle();

  const timeZone = (profile && profile.timezone) || 'UTC';

  const { data, error } = await supabase
    .from('api_usage')
    .select('source, cost_usd, input_tokens, output_tokens, created_at')
    .eq('user_id', user_id);

  if (error) return { error: error.message };

  const rows = data || [];
  const today = localDate(new Date(), timeZone);
  const month = today.slice(0, 7);

  const balance = Number(process.env.CREDIT_BALANCE_USD || 0);
  const asOf = process.env.CREDIT_BALANCE_AS_OF || null;

  let sinceTopUp = 0;
  let thisMonth = 0;
  let spentToday = 0;
  let allTime = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const bySource = {};

  for (const r of rows) {
    const cost = Number(r.cost_usd) || 0;
    const day = localDate(new Date(r.created_at), timeZone);

    allTime += cost;
    inputTokens += r.input_tokens || 0;
    outputTokens += r.output_tokens || 0;

    bySource[r.source] = (bySource[r.source] || 0) + cost;

    if (day === today) spentToday += cost;
    if (day.slice(0, 7) === month) thisMonth += cost;
    if (!asOf || r.created_at >= asOf) sinceTopUp += cost;
  }

  return {
    calls: rows.length,
    all_time: allTime,
    this_month: thisMonth,
    today: spentToday,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    by_source: bySource,
    // Null when no balance has been set, so the page can hide that section
    // rather than showing a meaningless zero.
    balance: balance > 0 ? balance : null,
    spent_since_top_up: balance > 0 ? sinceTopUp : null,
    remaining: balance > 0 ? Math.max(0, balance - sinceTopUp) : null,
    balance_as_of: asOf,
  };
}

module.exports = { recordUsage, summary, costOf, PRICING };
