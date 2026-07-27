// The daily coldness verdict.
//
// The first of the planner's two reasoning places (SPEC section 4). One call
// per person per day: every active entry goes in, a cold-or-not and one line
// saying why comes back, and the verdict is stored on the row. The panel reads
// only what is stored, so opening the app never calls the model.
//
// It judges rather than measures because a threshold cannot be right for both
// a daily habit and a monthly one, and because a thing set down on purpose is
// not neglected at all.

require('dotenv').config();

const supabase = require('./db');
const { runBrain } = require('./brain');
const { fence } = require('./untrusted');
const { lastScheduled, daysBetween } = require('./staleness');

const TYPES = ['habit', 'project', 'task'];
const MAX_REASON = 120;

async function gather(user_id, today) {
  const { data: rows, error } = await supabase
    .from('entries')
    .select('id, type, title, why, frequency, paused_at, created_at')
    .eq('user_id', user_id)
    .eq('status', 'active')
    .in('type', TYPES)
    .order('created_at');

  if (error) throw new Error(`could not read entries: ${error.message}`);
  if (!rows || !rows.length) return [];

  const latest = await lastScheduled(user_id);

  return rows.map((r) => {
    const seen = latest.get(r.id) || null;
    const since = seen || String(r.created_at).slice(0, 10);
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      why: r.why,
      frequency: r.frequency,
      paused: Boolean(r.paused_at),
      scheduled: Boolean(seen),
      days: Math.max(0, daysBetween(since, today)),
    };
  });
}

function render(items, today) {
  const L = [`Today is ${today}. Here is everything they are currently carrying.`, ''];

  items.forEach((it, i) => {
    const facts = [it.type];
    if (it.frequency) facts.push(`meant to happen ${it.frequency}`);
    if (it.paused) facts.push('PAUSED, set down on purpose');
    facts.push(
      it.scheduled
        ? `${it.days} days since it was last in a plan`
        : `never scheduled, added ${it.days} days ago`
    );
    if (it.why) facts.push(`why it matters to them: ${it.why}`);

    L.push(`${i + 1}. ${it.title}  [${facts.join('; ')}]`);
  });

  return L.join('\n');
}

const TASK = `For each item above, decide whether it has gone cold, and say why in one line.

Cold means it has been left long enough that they would want to see it, judged against what that particular thing is. There is no number that does this. Three days without a daily habit is a lapse; three days without a monthly one is nothing. A task added yesterday is not cold whatever else is true. A project with a real reason behind it that has sat for weeks probably is.

An item marked PAUSED is never cold. They have already said they set it down deliberately, and telling them it has gone cold contradicts something they told you. Mark it false and say plainly that it is paused.

Never invent a gap that is not in the figures. Never scold. The line is there so they can see at a glance why something is flagged, not to be argued with.

Answer with exactly one line per item, in this format and nothing else:

1|yes|one line saying why
2|no|one line saying why

The number is the item's number above. The middle field is yes or no, nothing else. Every item must appear exactly once, including paused ones.`;

/**
 * Returns index -> { cold, reason }, or null if the reply does not cleanly
 * cover every item.
 *
 * Structural problems are refused outright: a missing item, a repeated one, or
 * anything other than yes or no. A verdict list with holes would leave
 * yesterday's answer on some rows and today's on others, which is worse than
 * leaving the whole set alone.
 *
 * Length is not a structural problem. An over-long reason is trimmed rather
 * than thrown away, because discarding an entire day's judgment over one
 * verbose sentence is a bad trade, and the reason is displayed as a single
 * small line regardless.
 */
function parseVerdicts(reply, count) {
  const found = new Map();

  for (const raw of String(reply || '').split('\n')) {
    const m = raw.match(/^\s*(\d+)\s*\|\s*(yes|no)\s*\|\s*(.+?)\s*$/i);
    if (!m) continue;

    const index = Number(m[1]);
    let reason = m[3].trim();

    if (index < 1 || index > count) return null;
    if (!reason) return null;
    if (found.has(index)) return null;

    if (reason.length > MAX_REASON) {
      reason = reason.slice(0, MAX_REASON - 1).replace(/\s+\S*$/, '') + '…';
    }

    found.set(index, { cold: m[2].toLowerCase() === 'yes', reason });
  }

  if (found.size !== count) return null;
  return found;
}

/**
 * Judge everything once, and store the verdicts. Never throws.
 *
 * On any failure the previous verdicts are left exactly as they were. Blanking
 * them because a call failed would turn an outage into a screen quietly
 * claiming nothing has gone cold.
 */
async function judge(user_id, today) {
  try {
    const items = await gather(user_id, today);
    if (!items.length) return { judged: 0, reason: 'nothing to judge' };

    // The whole briefing is fenced and the task sits outside it, so the rule
    // is one line: everything in the fence is data, everything outside is the
    // instruction. Titles and whys are the person's own words.
    const reply = await runBrain(
      user_id,
      `${fence(render(items, today))}\n\n${TASK}`,
      'coldness'
    );
    const verdicts = parseVerdicts(reply, items.length);

    if (!verdicts) {
      // The reply itself, not just the fact of failure. Without it, diagnosing
      // a malformed answer means guessing at what the model actually said.
      console.error(
        `[COLD] reply did not cover all ${items.length} items, leaving yesterday's verdicts in place. Reply was:\n${String(reply).slice(0, 800)}`
      );
      return { judged: 0, reason: 'malformed' };
    }

    let judged = 0;
    for (const [index, verdict] of verdicts) {
      const item = items[index - 1];

      // Enforced here as well as asked for in the prompt. A paused item being
      // marked cold is the one wrong answer that contradicts something the
      // person said themselves, so it does not depend on the model complying.
      const cold = item.paused ? false : verdict.cold;

      const { error } = await supabase
        .from('entries')
        .update({ cold, cold_reason: verdict.reason })
        .eq('id', item.id)
        .eq('user_id', user_id);

      if (error) {
        console.error(`[COLD] ${item.title}: ${error.message}`);
        continue;
      }
      judged += 1;
    }

    const coldCount = [...verdicts.values()].filter((v) => v.cold).length;
    console.log(`[COLD] judged ${judged} item(s), ${coldCount} cold`);
    return { judged, cold: coldCount };
  } catch (err) {
    console.error(`[COLD] failed: ${err.message}`);
    return { judged: 0, reason: err.message };
  }
}

module.exports = { judge, gather, render, parseVerdicts, MAX_REASON };
