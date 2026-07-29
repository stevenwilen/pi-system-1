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

// Wrapped at midnight. A block starting at 23:00 and running two hours ends at
// 01:00, and this used to render it as "25:00" — a time that does not exist,
// sent to a phone at eleven at night.
const clock = (mins) =>
  `${String(Math.floor((mins % 1440) / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

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

module.exports = { composeMessage };
