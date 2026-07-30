// What Telegram sends for a block: three lines read straight off the row.
//
// No model call, here or anywhere behind here, and now no composition either.
// Every part of the message is a column — title, start, duration, note — so
// there is nothing to assemble at confirm time and nothing stored for delivery
// to read back.
//
// This file has shrunk twice for the same reason. It was a model call with the
// whole day in view; then arithmetic that named a deadline or a gap; and now
// neither, because both were facts the screen had already shown the person on
// the evening they made the plan.
//
// `blocks.message_text` is left in place, holding whatever it last held, and
// read by nothing.

const { toMinutes } = require('./clock');

// Twelve hour, because that is how the person reads a clock and the message is
// read on a phone alongside every other notification.
//
// Wrapped at midnight. A block starting at 11:00 PM and running two hours ends
// at 1:00 AM, and this used to render it as "25:00" — a time that does not
// exist, sent to a phone at eleven at night.
//
// Midnight is 12 AM and noon is 12 PM: hour 0 and hour 12 both display as 12,
// which is the one case a naive modulo gets wrong.
function clock(mins) {
  const at = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(at / 60);
  const m = at % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * What Telegram sends for a block.
 *
 * The title, the two times, and whatever they wrote about the session. That
 * is the whole message.
 *
 * There was a third part: a line composed at confirm time, naming the deadline
 * or how long the thing had been left. Both are gone, for one reason twice.
 * Every fact this system could derive about a block is already on the screen
 * where it belongs — the deadline as a warning mark, the gap as the order of
 * the list and the words on the row — and the person read it there before
 * putting the block in tomorrow. Repeating it at the block's start time told
 * them a thing they had already decided about, at the hour they could least
 * act on it.
 *
 * What is left is the one thing the screen cannot say back to them: their own
 * sentence about this particular hour. If they did not write one, there was
 * nothing to say, and the message is the title and the time. A block with no
 * note is a plain notification on purpose.
 *
 * Verbatim really is verbatim: nothing here parses, trims or reasons about a
 * note. It is escaped on the way out by telegram.js, along with everything
 * else, so a note containing a `<` renders as a `<`.
 */
function composeMessage(block) {
  const start = toMinutes(block.start_time);
  const header = `<b>${block.title}</b>\n${clock(start)} to ${clock(start + block.duration_minutes)}`;

  return block.note ? `${header}\n\n${block.note}` : header;
}

/**
 * What is still to come, in the order the day runs.
 *
 * `now` in minutes past midnight, or **null** for a day that is not today —
 * tomorrow has no "now" inside it, so the whole of it is still to come.
 *
 * A block is still to come until it has ENDED. The one in progress is included,
 * because the message is "what is going on now until finish" and what is going
 * on now is that block. Ending exactly at `now` is over; starting exactly at
 * `now` has begun and is going on.
 *
 * Sorted here rather than trusted, because the payload arrives in whatever
 * order the screen last showed and the message is a reading of the day.
 */
function blocksStillToCome(rows, now) {
  const sorted = [...(rows || [])].sort(
    (a, b) => toMinutes(a.start_time) - toMinutes(b.start_time)
  );

  if (now === null || now === undefined) return sorted;
  return sorted.filter((b) => toMinutes(b.start_time) + b.duration_minutes > now);
}

/**
 * The day as a whole, sent once when it is confirmed.
 *
 * The per-block messages arrive one at a time, each at its own hour, and none
 * of them shows the shape of the day. This is the other half: what is coming,
 * in one place, at the moment it is agreed to.
 *
 * Ordinary message text, one line per block, a dash between the time and the
 * title. Nothing lines up into a column and nothing pretends to.
 *
 * IT WAS A `<pre>` BLOCK FIRST, for the one thing monospace buys: Telegram
 * renders in a proportional font, so "9:30 AM" and "11:30 AM" are different
 * widths and padded spaces align nothing. A real column needed a code block —
 * and a code block is what it looked like, sitting in a chat on its own grey
 * surface in a smaller face. A ragged left edge is the cheaper price. This is
 * a message, and it should read like the other messages.
 *
 * Only start times. Each block's end is the next one's start, so saying both
 * would be saying everything twice; the one end that is not implied is the
 * day's, and that is the last line.
 *
 * No tags at all now, so nothing here depends on the escaping allowlist.
 *
 * Returns null when there is nothing left to say — a day already over sends no
 * message rather than a header with no lines under it.
 */
function composeSchedule(blocks, label) {
  if (!blocks || !blocks.length) return null;

  const lines = blocks.map(
    (b) => `${clock(toMinutes(b.start_time))} — ${b.title}`
  );
  const ends = Math.max(
    ...blocks.map((b) => toMinutes(b.start_time) + b.duration_minutes)
  );

  return `${label}\n\n${lines.join('\n')}\n\nEnds ${clock(ends)}`;
}

module.exports = { composeMessage, composeSchedule, blocksStillToCome };
