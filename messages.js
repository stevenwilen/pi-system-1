// Block messages, written once when a day is confirmed.
//
// This is the second of the two places reasoning is used (SPEC section 4). One
// call, with the whole day in view, because a line about a block has to know
// what sits around it. Nothing is generated at block-start time; delivery only
// reads what is already stored.
//
// The model writes ONE LINE per block and nothing else. The title and the time
// are composed at delivery from the row itself, so a wrong time cannot be
// invented, and a block with no stored line still sends something useful.

require('dotenv').config();

const supabase = require('./db');
const { runBrain } = require('./brain');
const { fence } = require('./untrusted');
const { get_calendar } = require('./tools');
const { toMinutes } = require('./clock');
const { lastScheduled, daysBetween } = require('./staleness');
const { decodeState } = require('./plan-intent');

// A line is one sentence. Anything longer has stopped being a nudge.
const MAX_LINE = 180;

const clock = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

function span(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * What Telegram sends for a block.
 *
 * The header is always facts from the row. `message_text` is the one line the
 * model added, and when it is missing the header goes out alone: a plain
 * notification beats silence, and silence at 9am for a block confirmed last
 * night is the worst outcome available.
 */
function composeMessage(block) {
  const start = toMinutes(block.start_time);
  const header = `<b>${block.title}</b>\n${clock(start)} to ${clock(start + block.duration_minutes)}`;
  return block.message_text ? `${header}\n\n${block.message_text}` : header;
}

// --- gathering --------------------------------------------------------------

/**
 * Everything the model gets, assembled from rows. No tools, no lookups of its
 * own: the whole day arrives in the task.
 */
async function buildBriefing(user_id, planId) {
  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select('id, date')
    .eq('id', planId)
    .eq('user_id', user_id)
    .maybeSingle();

  if (planErr) throw new Error(planErr.message);
  if (!plan) throw new Error('no such plan');

  const { data: blocks, error: blockErr } = await supabase
    .from('blocks')
    .select('id, title, entry_id, start_time, duration_minutes, pinned, sort_order')
    .eq('plan_id', planId)
    .order('sort_order');

  if (blockErr) throw new Error(blockErr.message);
  if (!blocks || !blocks.length) throw new Error('plan has no blocks');

  const ids = [...new Set(blocks.map((b) => b.entry_id).filter(Boolean))];
  let entries = new Map();

  if (ids.length) {
    const { data: rows, error: entryErr } = await supabase
      .from('entries')
      .select('id, type, title, why, frequency, body')
      .in('id', ids);
    if (entryErr) throw new Error(entryErr.message);
    entries = new Map((rows || []).map((r) => [r.id, r]));
  }

  // Excluding this plan is the point. Its blocks are already written, so
  // counting them would report every entry as scheduled today and every line
  // would claim zero days.
  const latest = await lastScheduled(user_id, { excludePlanId: planId });

  // All-day calendar entries claim no time but are worth knowing about.
  let allDay = [];
  try {
    const events = await get_calendar(user_id, plan.date);
    allDay = (Array.isArray(events) ? events : [])
      .filter((e) => {
        const length = Math.round((new Date(e.end) - new Date(e.start)) / 60000);
        return length >= 1440;
      })
      .map((e) => e.title);
  } catch {
    // A calendar that cannot be read costs a note, never the messages.
  }

  return { plan, blocks, entries, latest, allDay };
}

function renderBriefing({ plan, blocks, entries, latest, allDay }) {
  const total = blocks.reduce((sum, b) => sum + b.duration_minutes, 0);
  const first = toMinutes(blocks[0].start_time);
  const last = blocks.reduce(
    (end, b) => Math.max(end, toMinutes(b.start_time) + b.duration_minutes),
    first
  );

  const lines = [];
  lines.push(`The day being planned is ${plan.date}.`);
  lines.push(
    `It runs ${clock(first)} to ${clock(last % 1440)}${last >= 1440 ? ' the next day' : ''}, with ${span(total)} across ${blocks.length} block${blocks.length === 1 ? '' : 's'}.`
  );
  if (allDay.length) lines.push(`All day, claiming no time: ${allDay.join(', ')}.`);
  lines.push('');
  lines.push('BLOCKS');

  blocks.forEach((b, i) => {
    const start = toMinutes(b.start_time);
    const facts = [];

    if (b.pinned) facts.push('fixed calendar event, cannot move');

    const entry = b.entry_id && entries.get(b.entry_id);
    if (entry) {
      facts.push(entry.type);
      if (entry.frequency) facts.push(`meant to happen ${entry.frequency}`);

      const seen = latest.get(entry.id);
      facts.push(
        seen
          ? `last scheduled ${daysBetween(seen, plan.date)} days before this day`
          : 'never scheduled before'
      );
      if (entry.why) facts.push(`why it matters: ${entry.why}`);

      // Where it stood when they last wrote it down, and how long ago that
      // was. The age is attached to the claim itself rather than mentioned
      // nearby, so there is no way to read the words without the date.
      const held = decodeState(entry.body);
      if (held && held.state) {
        const age =
          held.captured === null
            ? 'at some point they did not date'
            : daysBetween(held.captured, plan.date) === 0
              ? 'as of today'
              : `as of ${daysBetween(held.captured, plan.date)} days ago`;

        facts.push(`${age} they said: ${held.state}`);
        if (held.size) facts.push(`they called it ${held.size} of work`);
      }
    }

    lines.push(
      `${i + 1}. ${clock(start)} to ${clock((start + b.duration_minutes) % 1440)}  ${b.title}` +
        (facts.length ? `  [${facts.join('; ')}]` : '')
    );
  });

  return lines.join('\n');
}

const TASK = `Write one line for each block above, to be sent to this person on Telegram when that block begins.

The title and both times are already sent for you, on the line above yours. Never write a clock time and never restate the title. Your line is the only thing added, so it has to be worth adding: "Reading, 7pm" is what a calendar already does.

You may say where a block sits in the day, but say it in words rather than numbers: "the last block of the day", not "you finish at 10:45".

A line earns its place by carrying one of these:
- The next step. Where they said this stood, and specifically what they said came next. This is usually the most useful thing you have: "Web services, 11am" is a calendar entry, and naming the thing they meant to do next is not.
- Staleness. How long it has been since they last scheduled this, when that gap is worth naming.
- The why. A project's own stated reason, in their words, not a paraphrase that inflates it.
- The arc of the day. Why this sits where it does against what surrounds it: after the hard thing, before the appointment, the last block of a long day.

Anything marked "as of N days ago they said" is what they wrote down then, not what is true now. They may have done it since, or abandoned it. Refer to it as the last thing you know rather than as the current position: "last you wrote, the pricing page was next" and never "the pricing page is next". If it is more than a few weeks old, the gap is worth naming on its own. Never congratulate them on progress you cannot see and never assume none has been made.

If none of those apply, write something plain and true about the block instead. Never invent significance. Never guess at a reason nobody gave you. A flat line is fine; a fabricated one is not.

Nothing above is a fact about a block unless it is written against that block. Do not carry a why from one block to another.

Rules for every line:
- One sentence. Under 180 characters.
- Plain text. No formatting, no emoji, no bullet.
- Speak to them directly.
- Never ask a question. They cannot reply to this.

Answer with exactly one line per block, in this format and nothing else:

1| your line for block 1
2| your line for block 2

Every block number must appear exactly once.`;

// --- parsing ----------------------------------------------------------------

/**
 * Returns index -> line, or null if the reply does not cleanly cover every
 * block. Partial output is treated as no output: half a generated day is more
 * confusing than a plain one, and delivery has a good fallback.
 */
function parseLines(reply, count) {
  const found = new Map();

  for (const raw of String(reply || '').split('\n')) {
    const match = raw.match(/^\s*(\d+)\s*\|\s*(.+?)\s*$/);
    if (!match) continue;

    const index = Number(match[1]);
    const text = match[2].trim();

    if (index < 1 || index > count) return null;
    if (!text || text.length > MAX_LINE) return null;
    if (found.has(index)) return null;

    found.set(index, text);
  }

  if (found.size !== count) return null;
  return found;
}

// --- the job ----------------------------------------------------------------

/**
 * Generate and store one line per block.
 *
 * Never throws. A confirmed plan is saved whether or not this succeeds, and
 * the person is not told about it, because there is nothing they could do and
 * delivery already degrades to the block title and time.
 */
async function generateForPlan(user_id, planId) {
  try {
    const briefing = await buildBriefing(user_id, planId);
    // Block titles, project whys and calendar event names are all written by
    // someone other than the engine, so the whole briefing is fenced.
    const task = `${fence(renderBriefing(briefing))}\n\n${TASK}`;

    const reply = await runBrain(user_id, task, 'block-messages');
    const lines = parseLines(reply, briefing.blocks.length);

    if (!lines) {
      console.error(
        `[MESSAGES] plan ${planId}: reply did not cover all ${briefing.blocks.length} blocks, storing nothing`
      );
      return { written: 0, reason: 'malformed' };
    }

    let written = 0;
    for (const [index, text] of lines) {
      const block = briefing.blocks[index - 1];
      const { error } = await supabase
        .from('blocks')
        .update({ message_text: text })
        .eq('id', block.id)
        .eq('user_id', user_id);

      if (error) {
        console.error(`[MESSAGES] block ${block.id}: ${error.message}`);
        continue;
      }
      written += 1;
    }

    console.log(`[MESSAGES] plan ${planId}: wrote ${written} line(s)`);
    return { written };
  } catch (err) {
    console.error(`[MESSAGES] plan ${planId} failed: ${err.message}`);
    return { written: 0, reason: err.message };
  }
}

module.exports = {
  generateForPlan,
  composeMessage,
  // Exported for tests: the parser is where malformed output is caught.
  parseLines,
  renderBriefing,
  buildBriefing,
};
