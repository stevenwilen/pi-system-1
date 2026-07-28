// Dates and clock times, as numbers.
//
// Two conversions live here so nothing else has to know what a timezone is.
// A day boundary is the person's, not the server's: counting days against the
// server's date would be off by one for most of their evening, which is
// exactly when they open this. And everything the builder lays out is
// arithmetic on minutes past midnight, so times arrive as integers and leave
// as integers.

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

module.exports = { todayIn, yesterdayOf, tomorrowOf, minutesOfDay, toMinutes, hhmmss };
