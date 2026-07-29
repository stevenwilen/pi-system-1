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
 * Three parts, and each may be absent but the first:
 *
 *   the header       title and both times, always, straight from the row
 *   the note         what they said they were doing in this session, verbatim
 *   the context line the deadline or the gap, composed at confirm time
 *
 * The note comes first because it is the person's own sentence about this
 * particular hour, and the context line is a fact derived about the thing in
 * general. Their words before ours.
 *
 * Verbatim really is verbatim: nothing here parses, trims or reasons about a
 * note. It is escaped on the way out by telegram.js, along with everything
 * else, so a note containing a `<` renders as a `<`.
 */
function composeMessage(block) {
  const start = toMinutes(block.start_time);
  const parts = [
    `<b>${block.title}</b>\n${clock(start)} to ${clock(start + block.duration_minutes)}`,
  ];

  if (block.note) parts.push(block.note);
  if (block.message_text) parts.push(block.message_text);

  return parts.join('\n\n');
}

/**
 * The one context line for a block, or null.
 *
 * The gap, and only the gap. A deadline used to be named here, and used to
 * take precedence over the gap when a block had both. It is gone.
 *
 * The deadline is already on the screen, as a warning mark, where it can be
 * read against everything else competing for the same days. Repeating it at
 * the block's start time told the person a thing they had decided about the
 * night before, at the moment they could least act on it. How long something
 * has been left is the opposite: it is what they were most likely to have
 * forgotten, which is the reason this system exists at all.
 *
 * A block with no entry behind it — anything typed straight into the builder,
 * or one whose entry has since been deleted — has no gap to name and gets
 * nothing.
 */
function contextLine({ entry, lastSeen, date }) {
  if (!entry || !lastSeen) return null;

  const gap = daysUntil(lastSeen, date);
  return gap >= GAP_WORTH_NAMING ? `${gap} days since you last did this.` : null;
}

module.exports = { composeMessage, contextLine };
