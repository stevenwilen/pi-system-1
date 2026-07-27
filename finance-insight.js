// The daily finance line.
//
// One model call a day. Everything countable is counted before the model sees
// it: transfers are already excluded, categories already netted, repeats
// already found. What the model is asked for is the one sentence worth sending,
// which is the only part that is judgment.
//
// Nothing from the sheet is stored. The line is stored, and only so that
// tomorrow can read what has already been said and not say it again.

require('dotenv').config();

const supabase = require('./db');
const { runBrain } = require('./brain');
const { readTransactions } = require('./sheet');
const { summarise, findTransfers, repeatCharges } = require('./money');

// The window the numbers are drawn from. Wider than the screen's, because a
// charge that repeats monthly cannot be seen at all inside thirty days.
const WINDOW_DAYS = 90;

// How far back it reads its own lines before writing a new one.
const MEMORY_DAYS = 14;

// One sentence. Anything longer has become the report the screen already is.
const MAX_LINE = 200;

const daysAgo = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// --- gathering --------------------------------------------------------------

async function intentRows(user_id) {
  const { data, error } = await supabase
    .from('entries')
    .select('title, body')
    .eq('user_id', user_id)
    .eq('type', 'finance_intent')
    .eq('status', 'active')
    .order('created_at');

  if (error) throw new Error(`could not read intent: ${error.message}`);
  return data || [];
}

async function recentInsights(user_id, today) {
  const { data, error } = await supabase
    .from('entries')
    .select('body, created_at')
    .eq('user_id', user_id)
    .eq('type', 'finance_insight')
    .gte('created_at', `${daysAgo(today, MEMORY_DAYS)}T00:00:00Z`)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`could not read past lines: ${error.message}`);
  return data || [];
}

/**
 * Everything the model gets. Assembled from counted figures and from rows the
 * person wrote themselves, never from raw transactions.
 */
async function buildBriefing(user_id, today) {
  const rows = await readTransactions(WINDOW_DAYS);

  // readTransactions returns [] on any failure and logs why. An empty sheet
  // and an unreadable one are the same to this function: there is nothing to
  // reason about, so it does not.
  if (!rows.length) return null;

  const counted = summarise(rows, today);
  const repeats = repeatCharges(rows, findTransfers(rows));

  const [intent, said] = await Promise.all([
    intentRows(user_id),
    recentInsights(user_id, today),
  ]);

  return { today, counted, repeats, intent, said };
}

function render({ today, counted, repeats, intent, said }) {
  const L = [];
  const money = (n) => Math.abs(n).toFixed(2);

  L.push(`Today is ${today}.`);

  if (counted.sync.stale) {
    L.push(
      `THE SHEET IS ${counted.sync.days_ago} DAYS OLD. Its most recent transaction is ${counted.sync.newest}. Anything spent since then is not below.`
    );
  } else {
    L.push(`The sheet is current to ${counted.sync.newest}.`);
  }

  L.push('');
  L.push(`SPENDING, last ${WINDOW_DAYS} days, transfers already excluded`);
  L.push(`Total: ${money(counted.total_spend)}`);
  for (const c of counted.categories) {
    L.push(`  ${c.category}: ${c.amount < 0 ? `${money(c.amount)} came back` : money(c.amount)} across ${c.count} charges`);
  }
  if (counted.uncategorised.count) {
    L.push(`  not yet categorised: ${money(counted.uncategorised.amount)} across ${counted.uncategorised.count}`);
  }
  L.push(
    `Money moved between their own accounts, in neither total: ${money(counted.transfers.moved)} across ${counted.transfers.count} rows.`
  );

  L.push('');
  if (repeats.length) {
    L.push('CHARGED MORE THAN ONCE. These arrive without a decision being made.');
    for (const r of repeats) {
      L.push(
        `  ${r.merchant}: ${r.times} times, ${money(r.total)} total, averaging ${money(r.average)}${r.steady ? ', the same amount each time' : ', varying amounts'}${r.typical_gap_days !== null ? `, about ${r.typical_gap_days} days apart` : ''} (${r.first} to ${r.last})`
      );
    }
  } else {
    L.push('CHARGED MORE THAN ONCE: nothing repeated inside the window.');
  }

  L.push('');
  if (intent.length) {
    L.push('WHAT THEY HAVE TOLD YOU. Their own words, and the only source of anything about their situation.');
    for (const row of intent) {
      L.push(`  ${row.title}${row.body ? ` — ${row.body}` : ''}`);
    }
  } else {
    L.push('WHAT THEY HAVE TOLD YOU: nothing yet. You know their spending and nothing else about their circumstances.');
  }

  L.push('');
  if (said.length) {
    L.push(`WHAT YOU HAVE ALREADY SAID, last ${MEMORY_DAYS} days. Do not repeat any of it.`);
    for (const s of said) L.push(`  ${String(s.created_at).slice(0, 10)}: ${s.body}`);
  } else {
    L.push('WHAT YOU HAVE ALREADY SAID: nothing yet.');
  }

  return L.join('\n');
}

const TASK = `Write one line to send this person today about their money.

One sentence. Under ${MAX_LINE} characters. Plain text.

The screen already shows every figure above. A line that reads back a total or lists categories is worth nothing, because they can already see it. Say the thing they would not see by looking.

What outranks what:

1. If they are short of cash, that leads. Nothing outranks it. You only know this if they have told you: there is no balance in the figures above, so unless one of their own rows says what they have, you cannot know it and must not guess.
2. Spending already committed that their cash will not cover, said before it happens rather than after.
3. A repeated charge, named. These arrive without a decision being made, which is what makes them worth naming when a one-off purchase is not.
4. A shift that has actually held. Not a single expensive day.

Hold to these:

Anything they have declared is theirs and chosen. Never flag it, never count it as a problem, never mention it as a concern. They already decided.

Where they have named something they slip on, they already know. Only its return or its growth is worth saying. Never tell them it exists.

If the sheet is old, say so and do not reason over the figures as though they were today's. Stale numbers presented as current are worse than none.

On a quiet day say something true and steady. Silence is closer to the right answer than invented urgency. Never manufacture a concern to have something to send.

Never moralise. You do not know whether something was worth buying and it is not your money.

Never ask a question. They cannot reply to this.

Answer with the line and nothing else. No preamble, no label, no quotation marks.`;

// --- parsing ----------------------------------------------------------------

/**
 * The reply, or null if it is not one line worth sending.
 *
 * Anything that arrives as a report rather than a sentence is refused
 * entirely. A missing line beats a wrong one, and the caller sends nothing.
 */
function parseLine(reply) {
  const text = String(reply || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();

  if (!text) return null;
  if (text.length > MAX_LINE) return null;
  // More than one line means it started listing.
  if (text.split('\n').filter((l) => l.trim()).length !== 1) return null;
  return text;
}

// --- the job ----------------------------------------------------------------

/**
 * Write today's line. Never throws.
 *
 * Returns { text } when there is something to send, or { skipped } with a
 * reason. A skipped day sends nothing at all rather than something weaker.
 */
async function generateDaily(user_id, today) {
  try {
    const briefing = await buildBriefing(user_id, today);
    if (!briefing) return { skipped: 'no transactions to reason about' };

    const reply = await runBrain(user_id, `${render(briefing)}\n\n${TASK}`, 'finance');
    const text = parseLine(reply);

    if (!text) {
      console.error('[FINANCE] reply was not a single usable line, sending nothing');
      return { skipped: 'malformed' };
    }

    // The line, and nothing from the sheet.
    const { error } = await supabase.from('entries').insert({
      user_id,
      type: 'finance_insight',
      title: `finance: ${today}`,
      body: text,
    });

    if (error) {
      // Storing is what stops tomorrow repeating today. Without it the line is
      // still true, so it is sent, but the failure is loud.
      console.error(`[FINANCE] could not store the line: ${error.message}`);
    }

    return { text };
  } catch (err) {
    console.error(`[FINANCE] failed: ${err.message}`);
    return { skipped: err.message };
  }
}

module.exports = {
  generateDaily,
  buildBriefing,
  render,
  parseLine,
  WINDOW_DAYS,
  MEMORY_DAYS,
};
