// What Telegram sends for a block, composed from the row.
//
// No model call, here or anywhere behind here. A block message is the block's
// own title, its two times, and at most one line of context that is arithmetic
// on dates. Everything in it can be traced to a column.
//
// The text is still written into `message_text` when the day is confirmed and
// still read back at the block's start time, because delivery has to survive a
// restart and a row is how it does that. What changed is who writes it: this
// used to be one model call with the whole day in view, and it is now a
// function of one entry and one date.

const { toMinutes } = require('./clock');
const { daysUntil } = require('./warning');

// Wrapped at midnight. A block starting at 23:00 and running two hours ends at
// 01:00, and this used to render it as "25:00" — a time that does not exist,
// sent to a phone at eleven at night.
const clock = (mins) =>
  `${String(Math.floor((mins % 1440) / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// Below this, a gap is not worth naming. Something scheduled the day before
// yesterday is not neglected, and saying so on every block would make the line
// worthless on the blocks where it matters.
const GAP_WORTH_NAMING = 3;

/**
 * What Telegram sends for a block.
 *
 * The header is always facts from the row. `message_text` is the context line,
 * and when there is none the header goes out alone — which is the normal case
 * for a buffer block and not a degraded one.
 */
function composeMessage(block) {
  const start = toMinutes(block.start_time);
  const header = `<b>${block.title}</b>\n${clock(start)} to ${clock(start + block.duration_minutes)}`;
  return block.message_text ? `${header}\n\n${block.message_text}` : header;
}

/**
 * How a deadline reads, relative to the day being planned.
 *
 * Measured against the plan's date rather than today, because this text is
 * written the evening before and read the following morning. "Due tomorrow"
 * written on Monday night has to mean Wednesday, not Tuesday.
 */
function dueLine(due, date) {
  const days = daysUntil(date, due);

  if (days < 0) return `Was due ${-days === 1 ? 'yesterday' : `${-days} days ago`}.`;
  if (days === 0) return 'Due today.';
  if (days === 1) return 'Due tomorrow.';
  return `Due in ${days} days.`;
}

/**
 * The one context line for a block, or null.
 *
 * A deadline beats a gap: if something is due in two days, how long it has
 * been sitting there is the less useful of the two facts. A block with no
 * entry behind it — a buffer, or anything typed straight into the builder —
 * has neither and gets nothing.
 */
function contextLine({ entry, lastSeen, date }) {
  if (!entry) return null;

  if (entry.due) return dueLine(entry.due, date);

  if (lastSeen) {
    const gap = daysUntil(lastSeen, date);
    if (gap >= GAP_WORTH_NAMING) return `${gap} days since you last did this.`;
  }

  return null;
}

module.exports = { composeMessage, contextLine, dueLine, GAP_WORTH_NAMING };
