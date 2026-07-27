// What the person has declared about their own money, and how it is asked for.
//
// Held as ordinary entries. Nothing here reaches a prompt this system sends,
// and no amount, account or threshold appears anywhere in this file. That is
// rule 2.4: the engine is byte-identical for someone with three hundred
// dollars and someone with three hundred thousand, and the only thing that
// differs is their rows.
//
// The kind lives in the title, encoded as `kind: label`, or `reserve/wall:`
// and `reserve/floor:` where the distinction matters. A wall has to be crossed
// deliberately; a floor can be reached by doing nothing, and the two are worth
// different messages. Encoding it here rather than adding a column keeps the
// lane inside the existing schema.
//
// The interview prompt sits in this file rather than in the web layer because
// it is engine text, and because the JSON block it asks for is exactly what
// the import route parses. Change the kinds and both have to change together;
// keeping them apart is how they drift.

const INTENT_KINDS = ['situation', 'reserve', 'target', 'declared', 'slip'];
const RESERVE_MODES = ['wall', 'floor'];

const encodeIntent = (kind, mode, label) =>
  kind === 'reserve' ? `${kind}/${mode}: ${label}` : `${kind}: ${label}`;

function decodeIntent(title) {
  const m = String(title || '').match(/^([a-z]+)(?:\/(wall|floor))?:\s*([\s\S]+)$/);
  if (!m || !INTENT_KINDS.includes(m[1])) return null;
  return { kind: m[1], mode: m[2] || null, label: m[3].trim() };
}

function validateIntent({ kind, mode, label }) {
  if (!INTENT_KINDS.includes(kind)) {
    return `kind must be one of ${INTENT_KINDS.join(', ')}`;
  }
  if (!String(label || '').trim()) return 'a label is required';
  if (kind === 'reserve' && !RESERVE_MODES.includes(mode)) {
    return 'a reserve is either a wall, crossed on purpose, or a floor, reached by doing nothing. Say which.';
  }
  return null;
}

/**
 * The setup interview, as a prompt to take elsewhere.
 *
 * Identical for every user and containing nothing about anyone. This system
 * never sends it: the person pastes it into a chat assistant, answers the
 * questions there, and brings the JSON block back.
 */
const SETUP_PROMPT = `I want you to interview me about my finances so another system can understand my situation. Act as a financial advisor taking someone on: curious, direct, and not judgemental about anything I tell you.

Ask me about all of these, but conversationally, one or two questions at a time. Wait for my answers before moving on. Do not present this as a form or a wall of questions.

1. Income. How much, how regular, and when it arrives. If it is irregular or has not started yet, get the timing.
2. What is in the bank now, and anything owed to me that has not arrived.
3. Any account or amount I treat as off limits. For each one, establish whether reaching it would need a deliberate transfer, or whether it could be reached passively by ordinary spending. This distinction matters, so ask about it directly.
4. What I am building toward. What the money is for.
5. Spending I have consciously chosen and do not want questioned. Things I have already decided are worth it.
6. Categories I already know I overspend on. I know about these; the point is that nobody needs to discover them for me.

Follow up where an answer is vague. Numbers are useful. If I do not know something, record that rather than guessing.

When we are done, output a single fenced json block and nothing after it. No summary, no closing remarks, just the block:

\`\`\`json
{
  "intents": [
    { "kind": "situation", "title": "short label", "body": "the detail in my own words" },
    { "kind": "reserve", "title": "short label", "body": "the detail, and state explicitly whether this is a wall or a floor" },
    { "kind": "target", "title": "short label", "body": "the detail" },
    { "kind": "declared", "title": "short label", "body": "the detail" },
    { "kind": "slip", "title": "short label", "body": "the detail" }
  ]
}
\`\`\`

Rules for the block:
- kind must be exactly one of: situation, reserve, target, declared, slip.
- One entry per distinct thing I told you. Several of the same kind is fine and expected.
- Every reserve entry must say the word wall or the word floor in its body.
- Leave out any kind I had nothing to say about.
- title is a few words. body is the substance.`;

module.exports = {
  INTENT_KINDS,
  RESERVE_MODES,
  encodeIntent,
  decodeIntent,
  validateIntent,
  SETUP_PROMPT,
};
