// What the person is carrying, and how they are asked for it.
//
// The planner's half of the setup interview, mirroring finance-intent.js. The
// prompt is engine text: identical for every user, containing nothing about
// anyone. This system never sends it. The person pastes it into a chat
// assistant, answers the questions there, and brings the JSON block back.
//
// The prompt and the parser of its output live together on purpose. Change the
// shape it asks for and both have to change; keeping them apart is how they
// drift.

const TYPES = ['project', 'habit', 'task'];

// The cadences the app already understands. The interview asks for hyphenated
// forms because they survive a chat reply better, and they are mapped back.
const FREQUENCIES = ['daily', 'few times a week', 'weekly', 'monthly'];

const FREQUENCY_ALIASES = {
  daily: 'daily',
  'few-times-weekly': 'few times a week',
  'few times a week': 'few times a week',
  'few times weekly': 'few times a week',
  weekly: 'weekly',
  monthly: 'monthly',
};

// Rough scale, not an estimate. The point is to tell a two-day errand from a
// six-month build, which changes what "untouched for a fortnight" means.
const SIZES = ['days', 'weeks', 'months'];

// --- state, stored in `body` ------------------------------------------------
//
// Where a project or task actually stands: what is done, what is left, what the
// next step is. It goes in the existing `body` column, which no habit, project
// or task has ever used, rather than in new columns.
//
// It is stored with the date it was captured, because progress ages. "Landing
// page done, pricing next" is true the day it is written and wrong two months
// later, and a system that repeats it as though it were current is lying with
// the person's own words. Nothing reads state without also reading how old it
// is. Same discipline as a declared balance in the finance lane.

/**
 * Pack state into `body`.
 *
 * JSON, because there are three fields and one of them is free prose that can
 * contain any delimiter a scheme might pick. Returns null when there is nothing
 * to say, so an item with no state stores no body rather than an empty shell.
 */
function encodeState({ state, size, captured } = {}) {
  const text = String(state || '').trim();
  const scale = SIZES.includes(size) ? size : null;
  if (!text && !scale) return null;

  return JSON.stringify({
    state: text || null,
    size: scale,
    captured: captured || new Date().toISOString().slice(0, 10),
  });
}

/**
 * Read it back. Never throws.
 *
 * A body that is not this shape is treated as plain prose with an unknown age,
 * which is what a row written before this existed looks like, and is closer to
 * the truth than discarding it.
 */
function decodeState(body) {
  const raw = String(body || '').trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          state: parsed.state ? String(parsed.state) : null,
          size: SIZES.includes(parsed.size) ? parsed.size : null,
          captured: /^\d{4}-\d{2}-\d{2}$/.test(parsed.captured) ? parsed.captured : null,
        };
      }
    } catch {
      // Fall through and keep it as prose.
    }
  }

  return { state: raw, size: null, captured: null };
}

// --- validation --------------------------------------------------------------

const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  // Rejects 2026-02-31, which matches the pattern and is not a day.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const normaliseFrequency = (value) =>
  FREQUENCY_ALIASES[String(value || '').trim().toLowerCase()] || null;

/**
 * Check one item, returning a sentence naming what is wrong with it.
 *
 * The caller checks every item before writing any of them. A paste that is half
 * understood must leave nothing behind rather than a list that looks complete.
 */
function validateItem(row, index) {
  const at = `entry ${index + 1}`;
  const type = String((row && row.type) || '').trim().toLowerCase();
  const title = String((row && row.title) || '').trim();

  if (!TYPES.includes(type)) {
    return `${at} has type "${type}", which is not one of ${TYPES.join(', ')}`;
  }
  if (!title) return `${at} has no title`;

  if (type === 'project' && !String((row && row.why) || '').trim()) {
    return `${at} ("${title}") is a project with no why. A project without a stated reason cannot be argued for later.`;
  }

  if (type === 'habit') {
    if (!normaliseFrequency(row && row.frequency)) {
      return `${at} ("${title}") is a habit with frequency "${(row && row.frequency) || ''}", which is not one of ${FREQUENCIES.join(', ')}`;
    }
    // A habit has a cadence instead of a deadline, and one carrying both is two
    // different ideas in one row.
    if (row && row.due) return `${at} ("${title}") is a habit with a due date. Habits have a frequency instead.`;
  }

  // A project has a size, not a date. Days, weeks or months says how much work
  // is in it, which is the useful thing; a deadline on a project is a guess
  // about when it will end rather than a fact about what it is.
  if (type === 'project' && row && row.due) {
    return `${at} ("${title}") is a project with a due date. A project has a size instead: days, weeks or months.`;
  }

  if (row && row.due !== undefined && row.due !== null && row.due !== '' && !isDate(row.due)) {
    return `${at} ("${title}") has due "${row.due}", which is not a date in YYYY-MM-DD form`;
  }

  if (row && row.size && !SIZES.includes(String(row.size).toLowerCase())) {
    return `${at} ("${title}") has size "${row.size}", which is not one of ${SIZES.join(', ')}`;
  }

  return null;
}

function validateImport(list) {
  if (!Array.isArray(list) || !list.length) return 'there were no items in it';
  if (list.length > 60) return 'that is more items than an interview produces';

  for (const [i, row] of list.entries()) {
    const problem = validateItem(row, i);
    if (problem) return problem;
  }
  return null;
}

/**
 * One validated item as the row it will become.
 *
 * `captured` is passed in rather than read from the clock here, so every item
 * in one import carries the same date and the function stays testable.
 */
function toRow(row, captured) {
  const type = String(row.type).trim().toLowerCase();

  const fields = {
    type,
    title: String(row.title).trim(),
    body: encodeState({ state: row.state, size: row.size, captured }),
  };

  if (type === 'habit') fields.frequency = normaliseFrequency(row.frequency);
  if (type === 'project') fields.why = String(row.why).trim();

  // Tasks only. A habit has a cadence and a project has a size.
  if (type === 'task') fields.due = row.due ? String(row.due).trim() : null;

  // A habit's why is optional and worth keeping when it is offered.
  if (type === 'habit' && String(row.why || '').trim()) fields.why = String(row.why).trim();

  return fields;
}

const SETUP_PROMPT = `I want you to interview me about everything I am currently trying to do, so another system can hold it for me. Act as someone helping me get it all out of my head and onto paper: curious, direct, and not impressed or unimpressed by any of it.

Ask me conversationally, one or two questions at a time. Wait for my answers before moving on. Do not present this as a form or a wall of questions.

Cover these four things.

1. PROJECTS. The things with more than one step that I am actually trying to finish. For each one, get:
   - what it is
   - why it matters to me. Press on this. "Because I need to" is not a reason, and neither is saying the title again in longer words. Keep asking until I say something that would still be true in six months.
   - where it stands right now: what is already done, what is left, and what the immediate next step is
   - how big it is: days, weeks, or months of work

Do not ask me for a deadline on a project and do not record one. How much work is in it is the useful thing; a date is a guess about when it will end, and it goes stale without anything having happened. If I volunteer a deadline anyway, put it in the state text as something I said rather than in a date field.

2. RANKING. Once you have the projects, ask me directly what order they matter in, most important first. Do not infer it from how long I talked about each one. If I struggle, ask which one I would keep if I had to drop the rest.

3. HABITS. Things I do regularly, or want to. For each, get what it is, how often it is meant to happen (daily, a few times a week, weekly, or monthly), and why it matters to me. Ask for the why rather than waiting to see if I offer one: a habit with only a name and a frequency is a line I will not recognise in three months. If I genuinely have no reason beyond wanting to, record that. A habit has no deadline.

4. TASKS. One-off things to get done. For each, get what it actually involves, roughly how long it takes, anything that has to happen before it can start, and any deadline.

Where an answer is vague, follow up. If I do not know something, record that rather than guessing. If I give you a deadline as "end of the month" or "before the trip", ask me for the actual date.

When we are done, output a single fenced json block and nothing after it. No summary, no closing remarks, just the block:

\`\`\`json
{
  "items": [
    {
      "type": "project",
      "title": "short name",
      "why": "the real reason, in my words",
      "state": "what is done, what is left, and the next step",
      "size": "days | weeks | months"
    },
    {
      "type": "habit",
      "title": "short name",
      "frequency": "daily | few-times-weekly | weekly | monthly",
      "why": "why it matters to me"
    },
    {
      "type": "task",
      "title": "short name",
      "state": "what it involves, roughly how long, anything that has to happen first",
      "due": "YYYY-MM-DD or null"
    }
  ]
}
\`\`\`

Rules for the block:
- type must be exactly one of: project, habit, task.
- Projects and tasks must appear in the order I ranked them, most important first. That order is the whole point of asking, so do not sort them by anything else.
- Every project must have a why and a size, and must not have a due date.
- Every habit must have a frequency and a why, and must not have a due date.
- Only a task may have a due date, and only when I gave you a real one.
- Use null where I did not give you something. Do not invent a date, a size, or a reason I did not say.`;

module.exports = {
  TYPES,
  FREQUENCIES,
  SIZES,
  SETUP_PROMPT,
  encodeState,
  decodeState,
  normaliseFrequency,
  validateItem,
  validateImport,
  toRow,
  isDate,
};
