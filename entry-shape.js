// What a habit, project or task is allowed to look like.
//
// Lifted out of routes/entries.js so the add form and the setup paste cannot
// disagree. They are two ways into the same list, and a paste that accepted
// something the form refuses would be a second, quieter set of rules — which
// is how a row ends up in the notebook that no screen can edit.

const { SIZES } = require('./warning');

const TYPES = ['habit', 'project', 'task'];
// A HABIT'S CADENCE, and nothing else's. Untouched: 'one off' was briefly the
// fourth of these and it did not belong — a habit is a rhythm by definition, so
// "a habit that happens once" is a contradiction wearing the wrong type. What
// wanted the idea was the task.
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

// A TASK THAT TAKES ITSELF OFF THE LIST once it has been in a day.
//
// The answer to a real problem: "call my doctor", "pay Albie" — a thing you
// want in a day and then gone. An ordinary task stays on the list after it is
// done until you remember to finish it by hand, and being asked to finish
// something you have already done is the chore that teaches people to stop
// keeping the list.
//
// NOT EVERY TASK, which is the whole reason this is a flag rather than a rule:
// some take several sittings, and that is what the length is for. This says the
// opposite — one sitting, then done.
//
// STORED IN `frequency`, which needs a word of defence. The column is already
// on every row and every task has it empty, so this cost no migration and no
// DDL. It is not a stretch of the meaning either: the field says how often this
// comes round, and the answer here is once. Habits keep the column's other
// values; nothing else in the system writes it.
const ONE_OFF = 'one off';

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
function validate({ type, title, frequency, due, size, one_off }) {
  if (!TYPES.includes(type)) return `type must be one of ${TYPES.join(', ')}`;
  if (!String(title || '').trim()) return 'a title is required';

  if (type === 'habit' && !FREQUENCIES.includes(frequency)) {
    return `a habit needs a frequency: ${FREQUENCIES.join(', ')}`;
  }

  // TASKS ONLY, and refused rather than ignored. A project is not finished by
  // one sitting — that is the whole difference between a project and a task —
  // and a habit recurs, which is the opposite of happening once. Accepting the
  // flag and quietly dropping it would leave someone believing a project would
  // take itself off the list.
  if (one_off !== undefined && one_off !== null) {
    if (typeof one_off !== 'boolean') return 'one_off must be true or false';
    if (one_off && type !== 'task') {
      return `only a task can be a one off. A ${type} is not finished in one sitting.`;
    }
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
    return `something with a due date needs a length: ${SIZES.join(', ')}`;
  }
  if (!hasDue && orNull(size)) {
    return 'a length only means something against a due date. Set a date, or leave the length off.';
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
    // A task's one-off flag lives in the same column a habit's cadence does,
    // which is why this is written on every save rather than only when set:
    // turning the flag off has to clear the column, and a row that kept a stale
    // 'one off' would take itself off the list after somebody said not to.
    fields.frequency = body.type === 'task' && body.one_off === true ? ONE_OFF : null;
  }

  return fields;
}

module.exports = { TYPES, FREQUENCIES, ONE_OFF, DATED, SIZES, NOTE_MAX, orNull, validate, toRow };
