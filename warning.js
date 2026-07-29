// Warning marks. Arithmetic, and only arithmetic.
//
// A mark answers one question: is there still room between now and the
// deadline for the amount of work this is? Nothing here models capacity, reads
// a calendar, or asks how much of the work is already done. It compares two
// numbers, both of which the person supplied.
//
// This is deliberately static. A mark does not decay as work happens, because
// the system is not told when work happens — the only thing it knows is that a
// block was scheduled and not marked missed, which is not the same as progress.
// A mark that moved on that evidence would be inventing a completion percentage
// nobody reported. It changes when the person changes the due date or the size,
// and when the calendar advances. Nothing else moves it.

// How many days of work each bucket stands for.
//
// Working days as a person would count them, not hours: "a week" is six rather
// than seven because nobody means seven, and "months" is forty rather than
// sixty for the same reason. These are the numbers the marks are tuned against
// and changing one re-tunes every mark on the screen.
const DAYS_NEEDED = {
  'a day': 1,
  'a few days': 3,
  'a week': 6,
  'a few weeks': 15,
  months: 40,
};

const SIZES = Object.keys(DAYS_NEEDED);

/**
 * Days from `from` to `to`, both YYYY-MM-DD.
 *
 * Noon UTC on both ends so no timezone can shift the result by a day, which is
 * the difference between !!! and !! on something due tomorrow.
 */
const daysUntil = (from, to) =>
  Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);

/**
 * The mark for one item: '!!!', '!!', '!', or null.
 *
 * Null whenever the question cannot be asked — no due date, no size, or a size
 * this does not recognise. A missing mark means "nothing to say", never "fine":
 * the screen shows nothing either way, and inventing a mark from a half-filled
 * row would be worse than staying quiet.
 *
 * A due date in the past gives a negative days_until and therefore '!!!',
 * which is correct. Overdue is the most urgent thing the scale can express.
 */
function markFor({ due, size, today }) {
  if (!due || !size || !today) return null;
  if (!Object.prototype.hasOwnProperty.call(DAYS_NEEDED, size)) return null;

  const slack = daysUntil(today, due) - DAYS_NEEDED[size];

  if (slack <= 0) return '!!!';
  if (slack <= 3) return '!!';
  if (slack <= 10) return '!';
  return null;
}

module.exports = { DAYS_NEEDED, SIZES, markFor, daysUntil };
