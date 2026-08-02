// What a habit, project or task is allowed to look like.
//
// Lifted out of routes/entries.js so the add form and the setup paste cannot
// disagree. They are two ways into the same list, and a paste that accepted
// something the form refuses would be a second, quieter set of rules — which
// is how a row ends up in the notebook that no screen can edit.

const { SIZES } = require('./warning');

const TYPES = ['habit', 'project', 'task'];
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

// How long a note may be, on a thing and on a block alike.
//
// ONE NUMBER, because the text moves between them: a note written on a thing
// is carried onto a block when the day is confirmed. Two ceilings would mean a
// note this list accepted could be refused by the confirm that delivered it,
// and the refusal would land on the day rather than on the field that was
// typed into. It is described as a line or two and it goes out verbatim in a
// message, so this is a ceiling rather than a target.
const NOTE_MAX = 500;

// Which types may carry a deadline. A habit has a cadence instead, and a habit
// with a deadline would be two different ideas in one row.
const DATED = ['project', 'task'];

// '' and null both mean "no date". The form sends '' when the field is
// cleared, and the column takes null.
const orNull = (value) => (String(value || '').trim() ? String(value).trim() : null);

/**
 * What a caller is allowed to leave out, and what it is not.
 *
 * Checked here rather than only in the database so the message can name the
 * field. The one rule with any depth to it is the last: a due date without a
 * size cannot produce a warning mark, so the pair is required together or not
 * at all.
 */
function validate({ type, title, frequency, due, size }) {
  if (!TYPES.includes(type)) return `type must be one of ${TYPES.join(', ')}`;
  if (!String(title || '').trim()) return 'a title is required';

  if (type === 'habit' && !FREQUENCIES.includes(frequency)) {
    return `a habit needs a frequency: ${FREQUENCIES.join(', ')}`;
  }

  const hasDue = Boolean(orNull(due));

  if (hasDue) {
    if (!DATED.includes(type)) {
      return 'only a project or a task can have a due date. A habit has a frequency instead.';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due).trim())) return 'a due date must be YYYY-MM-DD';
    // Rejects 2026-02-31, which matches the pattern and is not a day.
    const clean = String(due).trim();
    const parsed = new Date(`${clean}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== clean) {
      return `${clean} is not a real date`;
    }
  }

  // The size exists to be measured against the due date. Without one it has
  // nothing to say, and with a due date and no size the row cannot be marked
  // at all — which would look on screen exactly like a comfortable deadline.
  if (hasDue && !SIZES.includes(size)) {
    return `something with a due date needs a size: ${SIZES.join(', ')}`;
  }
  if (!hasDue && orNull(size)) {
    return 'a size only means something against a due date. Set a date, or leave the size off.';
  }

  return null;
}

/**
 * The row a validated entry becomes.
 *
 * Only the fields that belong to this type. A habit carrying a size, or a task
 * carrying a frequency, would be noise nothing reads.
 */
function toRow(body) {
  const fields = { type: body.type, title: String(body.title).trim() };

  if (body.type === 'habit') {
    fields.frequency = body.frequency;
  } else {
    fields.due = orNull(body.due);
    fields.size = fields.due ? body.size : null;
  }

  return fields;
}

module.exports = { TYPES, FREQUENCIES, DATED, SIZES, NOTE_MAX, orNull, validate, toRow };
