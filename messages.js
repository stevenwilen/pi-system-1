// What Telegram sends for a block: two lines read straight off the row, and
// the note under them as a message of its own.
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
 * What Telegram sends for a block: one message, or two.
 *
 * THE NOTE GOES ON ITS OWN, under the first and carrying nothing but itself —
 * no title, no times, no label. It used to hang off the bottom of the same
 * message after a blank line, which is the same words in the same order and
 * reads differently: a notification is skimmed at its first line, and a second
 * paragraph inside it is furniture around the header. Sent on its own it is a
 * message from you to you at the hour you meant it for, which is what a note
 * is, and the phone gives it its own notification.
 *
 * An array rather than two functions, so there is one answer to "what does
 * this block send" and no way to send the header while forgetting what was
 * meant to follow it.
 *
 * The title, the two times, and whatever they wrote about the session. That
 * is the whole of it.
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
function composeMessages(block) {
  const start = toMinutes(block.start_time);
  const header = `<b>${block.title}</b>\n${clock(start)} to ${clock(start + block.duration_minutes)}`;

  // A block with no note is one plain notification, exactly as before. Nothing
  // empty is ever sent: a note of spaces is not a note, and a second message
  // holding nothing but a blank line would be worse than none.
  const note = typeof block.note === 'string' ? block.note.trim() : '';

  return note ? [header, note] : [header];
}

module.exports = { composeMessages };
