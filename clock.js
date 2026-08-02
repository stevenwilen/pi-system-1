// Dates and clock times, as numbers.
//
// Two conversions live here so nothing else has to know what a timezone is.
// A day boundary is the person's, not the server's: counting days against the
// server's date would be off by one for most of their evening, which is
// exactly when they open this. And everything the builder lays out is
// arithmetic on minutes past midnight, so times arrive as integers and leave
// as integers.

/**
 * The hours a person actually gets up, and the step between them.
 *
 * THE PAGE HOLDS THE SAME THREE NUMBERS and cannot import this file — it is a
 * browser script in one html file. They are pinned equal by a check in
 * plan-layout-check.js, because the two have to agree about more than taste:
 * the profile must never hold a default the day screen has no way to show or
 * to step back to.
 *
 * Half past four in the morning is not a wake time this system refuses to
 * believe in — it is a stepper that would be being flexible rather than
 * helpful if it ran the whole clock.
 */
const WAKE_MIN = 4 * 60;
const WAKE_MAX = 12 * 60;
const WAKE_STEP = 30;

/**
 * The canonical IANA name for a zone, or null if it is not one.
 *
 * RESOLVED, NOT MERELY ACCEPTED. `Intl` takes `america/new_york`,
 * `US/Eastern` and `Zulu`, all of which are real zones under other spellings —
 * so this hands back what they resolve to and the column holds one spelling of
 * each place. Anything else stored would be a second name for a row nothing
 * would match on.
 *
 * IT ALSO TAKES `+05:00`, AND THAT IS THE ONE TO REFUSE. A fixed offset is not
 * a zone: it is a place that never changes its clocks, so the person who
 * stored it in January is an hour out from April and nothing in the system has
 * any way to notice. `supportedValuesOf` is the tzdb's own list, which is why
 * it is asked rather than a pattern being invented here.
 *
 * UTC is allowed by name and is not on that list — it is the column's default
 * and the honest placeholder for an account that has not said yet.
 */
function canonicalZone(name) {
  if (typeof name !== 'string' || !name.trim()) return null;

  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en', { timeZone: name.trim() })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }

  if (resolved === 'UTC') return 'UTC';

  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : null;

  // No list to check against on a runtime that does not offer one. Falling
  // back to "Intl accepted it" is weaker — it would let an offset through —
  // so the shape of an offset is refused by hand in that case and nothing
  // else is.
  if (!known) return /^[+-]/.test(resolved) ? null : resolved;

  return known.includes(resolved) ? resolved : null;
}

/** Today, where this person lives. */
function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** The day before a YYYY-MM-DD, at noon UTC so no zone can shift it. */
function yesterdayOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The day after, by the same reckoning. */
function tomorrowOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * A UTC instant as wall-clock minutes past midnight, where this person lives.
 *
 * Calendar feeds return instants. Converting them here rather than in the
 * browser keeps the app doing pure arithmetic on a number line.
 */
function minutesOfDay(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(iso))
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** A stored time as minutes past midnight. */
const toMinutes = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

/** Minutes past midnight as a time Postgres will take. */
const hhmmss = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;

module.exports = {
  todayIn, yesterdayOf, tomorrowOf, minutesOfDay, toMinutes, hhmmss,
  canonicalZone, WAKE_MIN, WAKE_MAX, WAKE_STEP,
};
