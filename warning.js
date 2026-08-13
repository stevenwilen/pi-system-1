// Warning marks. Arithmetic, and only arithmetic.
//
// A mark answers one question, and the question has two forms because the two
// kinds of row keep two kinds of time.
//
//   A DEADLINE: is there still room between now and the date for the amount of
//   work this is? Two numbers, both of which the person supplied.
//
//   A CADENCE: how far past its own rhythm has this drifted? A habit has no
//   date to run out of room against — it has a frequency, which says how long
//   may pass between one doing and the next, and the only other number needed
//   is how long it has actually been.
//
// Nothing here models capacity, reads a calendar, or asks how much of the work
// is already done.
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
 * How many days each cadence allows between one doing and the next.
 *
 * "Few times a week" is three: the gap that phrase describes, not the count of
 * sittings in it. Monthly is thirty rather than a working month, because a
 * habit is not work being got through — it is a rhythm, and the calendar is
 * what it drifts against.
 */
const CADENCE_DAYS = {
  daily: 1,
  'few times a week': 3,
  weekly: 7,
  monthly: 30,
};

const FREQUENCIES_KNOWN = Object.keys(CADENCE_DAYS);

/**
 * Days from `from` to `to`, both YYYY-MM-DD.
 *
 * Noon UTC on both ends so no timezone can shift the result by a day, which is
 * the difference between !!! and !! on something due tomorrow.
 */
const daysUntil = (from, to) =>
  Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);

/**
 * Days of room left: how long until it is due, less how long it will take.
 *
 * Negative means the room ran out. This is the whole of the judgement, and
 * both numbers came from the person — nothing here estimates anything.
 *
 * Null whenever the question cannot be asked: no due date, no size, or a size
 * this does not recognise. That is "nothing to say", never "fine".
 *
 * Separate from markFor because the list is now ORDERED by it. A mark is three
 * buckets and orders badly — everything overdue by any amount is one '!!!' —
 * so the order uses the number and the screen shows the bucket. They must
 * agree, which is why the bucket is computed from this rather than beside it.
 *
 * A HABIT'S ROOM IS COUNTED IN CADENCES, NOT DAYS, and that is the one place
 * the two kinds of row are not measured with the same ruler. It has to be that
 * way for the mark and the order to keep agreeing, which is the rule this
 * function exists to hold: judged in days, a monthly habit a month late (thirty
 * days of room gone) would sort above a daily one four days gone (three days
 * gone) while carrying the quieter mark, and the screen would show '!!' above
 * '!!!'. In cadences the daily one is three rhythms gone and the monthly barely
 * one, which is both the right order and the right pair of marks.
 *
 * Both numbers still mean the same thing — how far past the point where this
 * needed doing — each measured on its own row's clock.
 */
function slackFor({ due, size, today, frequency, days }) {
  // A HABIT, whose clock is its frequency. Asked first because a habit has no
  // due date and no size at all, so the deadline branch below would only ever
  // answer null for one.
  if (frequency) {
    const allowed = CADENCE_DAYS[frequency];
    if (!allowed || !Number.isFinite(days)) return null;
    return (allowed - days) / allowed;
  }

  if (!due || !size || !today) return null;
  if (!Object.prototype.hasOwnProperty.call(DAYS_NEEDED, size)) return null;
  return daysUntil(today, due) - DAYS_NEEDED[size];
}

/**
 * The mark for one item: '!!!', '!!', '!', or null.
 *
 * Null when there is no slack to speak of, and also when there is plenty: a
 * thing due in a year needs no mark. The screen shows nothing either way, and
 * inventing a mark from a half-filled row would be worse than staying quiet.
 *
 * A due date in the past gives negative slack and therefore '!!!', which is
 * correct. Overdue is the most urgent thing the scale can express.
 */
function markFor(item) {
  const slack = slackFor(item);
  if (slack === null) return null;

  // A HABIT, IN MULTIPLES OF ITS OWN RHYTHM. Once past the cadence it is '!',
  // at twice '!!', at three times '!!!' — so a daily habit missed three days is
  // as loud as a monthly one missed three months, which is the point: each is
  // judged against the rhythm it was given rather than against the calendar.
  //
  // The deadline thresholds could not be borrowed for this. They are tuned for
  // dates weeks out, and a daily habit has one day of room at its very best —
  // done this morning it would have landed inside the '!!' band and stayed
  // there for ever, which is a mark that says nothing because it never moves.
  if (item.frequency) {
    if (slack <= -2) return '!!!';
    if (slack <= -1) return '!!';
    if (slack <= 0) return '!';
    return null;
  }

  if (slack <= 0) return '!!!';
  if (slack <= 3) return '!!';
  if (slack <= 10) return '!';
  return null;
}

module.exports = { DAYS_NEEDED, SIZES, CADENCE_DAYS, FREQUENCIES_KNOWN, markFor, slackFor, daysUntil };
