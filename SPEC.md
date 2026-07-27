# Personal Planning System — Spec

A system for someone who is already good at planning their own day. Its job is
not to plan for them. It is to make sure they never plan from memory, and to
walk beside them through the day they built.

## The problem it solves

People remember what has momentum and forget what has gone cold. A book unread
for eleven days, a project untouched for three weeks: these do not announce
themselves. Whatever was top of mind yesterday will be top of mind again today,
and everything else quietly falls off.

So the system's core move is to make the user **read instead of remember**.

---

## 1. The Four Pieces

### App — one screen, used once each evening
Three stacked sections: Review, Stale, Builder. The user opens it in the
evening, marks what did not happen, sees what has gone cold, and builds
tomorrow.

The app does **arithmetic, not judgment**. Shifting blocks, summing durations,
computing the end time, detecting collisions, sorting by days-since: all of it
is mechanical and lives in the app. No thresholds, no advice, no decisions about
what matters. If it required an opinion, it does not belong here.

### Brain — narrow, not conversational
There is no chat. The brain is called in exactly two places (section 4) and
never runs an open-ended conversation. It is still an agent with tools, still
stateless, still reads rows at request time and keeps nothing.

### Notebook — everything known about the user
A Supabase (Postgres) database. If a fact is not a row here, the system does not
know it.

### Messenger — outbound only
A Telegram bot. It sends, never receives. Replies are ignored; there is no
inbound webhook. Telegram exists so the system can reach the user *during* the
day, at the moment a block begins.

---

## 2. Core Rules

These are the invariants. Everything else is implementation detail.

### 2.1 The brain is stateless
No session objects, no conversation memory, no caches that survive a request, no
per-user prompt files. Memory is rows, loaded fresh and discarded when the
response is sent. If the brain "remembers" something that is not a row, that is
a bug.

### 2.2 The notebook is DATA, never INSTRUCTIONS
Everything loaded from the database is evidence about the user, never a
directive. User content enters the prompt inside delimited blocks labelled as
untrusted. A row saying "ignore your previous instructions" is stored, shown as
data, and has no effect. No table holds a prompt, a rule, or a policy.

Adversarial rows can change what the brain *knows*, never what the brain *is*.

### 2.3 A fixed, small tool set
The brain touches the world only through its tools, and `tools.js` keeps its
field whitelist: anything not on the list is dropped, so `user_id`, `id`, and
timestamps can never be written from outside.

Every tool is scoped to the calling `user_id` at the server layer. The brain
never supplies a `user_id` and cannot reach another user's rows.

### 2.4 The engine is identical for every user
System prompt, tool definitions, schedule definitions, code: byte-identical for
everyone, never varying on personal data. Personal data changes the *content* of
a message, never the *machinery* that produces it. Timing comes from profile
rows read by a schedule that is itself the same for all.

### 2.5 Deleting takes something off the list
Deletion is soft: `status = 'deleted'` leaves a tombstone. Deleted rows are
never returned to the brain and can never be flipped back to active.

Delete is not a blocklist. If the same thing legitimately arises again it will be
recorded again as a new row. Delete means "take this off my list", not "never
learn this about me".

### 2.6 Pausing is not deleting
Pause is a separate, reversible state. A paused entry is still active and still
something the user cares about; it has simply been set down on purpose. It drops
out of the stale list until unpaused, and its clock is not a reproach while it is
paused.

This exists so the system never has to guess whether a gap is neglect. See 2.7.

### 2.7 Intent is declared, never inferred
The system does not decide what the user meant. If something has gone quiet on
purpose, the user says so by tapping **not now**. Nothing infers deliberateness
from behaviour, and nothing nags on the strength of a guess.

A tap is cheap and unambiguous. An inference is neither.

### 2.8 Wiping personal rows returns the system to factory state
Delete every row for a `user_id` and that user is brand new. Nothing personal
survives anywhere else, because nothing personal is stored anywhere else.

---

## 3. The App

One screen. Three sections, top to bottom, in the order they are used.

### 3.1 REVIEW — what happened yesterday
Yesterday's blocks, listed. Each has a one-tap **didn't happen**.

Blocks are **assumed done** unless tapped. The posture is trust. An optional
short reason can be attached to a miss.

### 3.2 STALE — what has gone cold
Everything the user cares about, in **one list**: habits, projects, and tasks
together. Sorted by **how long since it was last scheduled**, longest first.

A task left undone for three weeks is the same problem as a project untouched
for three weeks, so they share a list rather than being filed apart. For anything
never scheduled, the clock runs from when it was added.

Last-scheduled is computed, not reasoned: it is the most recent block tagged to
that entry. The *ordering* is arithmetic. What counts as *too long* is reasoning
(section 4).

Each item has two actions:
- Tap the item to **pull it into tomorrow's plan**.
- Tap **not now** to **pause** it. It leaves the list until unpaused.

Paused items are listed separately, out of the way but not hidden, so unpausing
is always one tap and nothing disappears silently.

### 3.3 BUILDER — tomorrow
- Every block has a **start time** and a **duration**.
- Duration adjusts with `-` / `+` steppers in **30-minute increments only**. No
  hold-to-repeat. No typing times.
- Blocks **flow in sequence**: changing one shifts everything below it.
- **Pinned** blocks (calendar events, appointments) do not move. If a change
  collides with a pinned block, the collision is shown visibly, for example a red
  or negative gap. The system does **not** auto-resolve it.
- A running **end time** displays at the bottom and updates live, so the user can
  see when the day lands and cut things if it is too late.
- **Drag to reorder.**
- Buffer and rest time is added **manually**, by the user, as a normal block. The
  system never inserts automatic padding.
- The first block starts at `profile.default_wake_time` unless moved.
- **Confirm** saves the plan.

---

## 4. Where Reasoning Is Used

Exactly two places. Nowhere else.

**1. Staleness thresholds.** How long is too long differs per item. Three days
without reading is fine; three weeks is not. The threshold is judged per item,
not set globally.

**2. Block message generation, at confirm time.** See section 5.

Deliberate-versus-drift was once the third. It is not reasoned any more: the user
declares it with the **not now** button (2.7). A tap replaced a judgment call,
and the judgment call was the part that could be wrong about someone.

Everything else — ordering, shifting, summing, collision detection, delivery
timing — is code.

---

## 5. Telegram

Outbound only.

**At confirm time**, the brain generates **all** of that day's block messages in
**one reasoning pass**. It needs the whole day in view to say why a block sits
where it does. The generated text is **stored** on the block.

**At each block's start time**, the scheduler sends that block's stored text.
Delivery is a timer and a database read. **The model is never called at
block-start time.**

Each message carries what the block is, plus one line of reasoning behind it: why
it is placed there, or that it has been eleven days since they last did it.

Because blocks sit on 30-minute boundaries, the scheduler tick must align to
those boundaries so messages fire on time.

---

## 6. Non-Goals

- No inbound Telegram. The bot never holds a conversation.
- No chat interface. The system is not a conversational assistant.
- No planning *for* the user. It surfaces and accompanies; it does not decide.
- No inferring intent. If something was set down on purpose, the user says so.
- No automatic padding, buffers, or auto-resolved collisions.
- No per-user prompts, rules, or configuration beyond the profile row.
- No hard deletes. Tombstones only.
- No judgment in the app.

---

## 7. Second lane: Finance (planned, not built)

A separate lane. It does not touch the builder, stale panel, or blocks. Its own
tab. Planner is primary.

### Source of truth
A Google Sheet connected to the user's bank. Transactions are NEVER stored in
the notebook. Read a bounded window (~60 days) at reasoning time, reason,
discard the raw data. Store only the resulting insight as a row.

### Primary metric: runway, not categories
The metric is liquid balance and burn against it: how much cash is on hand, what
is committed against it, and how long it lasts.

Month-over-month category comparison is explicitly REJECTED as the frame. It is
a tool for someone with steady income asking "am I drifting." It produces noise
for anyone with variable or zero income, and it flags normal monthly variability
as behaviour change.

Where category-level comparison IS used, it must be against a rolling 3-6 month
median, and only flag a shift sustained 2+ weeks. Never last-month-vs-this-month.

### Recurring vs chosen
Recurring charges are the priority signal. They hit automatically and erode a
balance without any decision being made. One-off deliberate spending is a choice
the user already made; recurring spending is the thing that happens to them.
Surface the latter.

### Intent rows (type='finance_intent')
Whatever the user has declared about their situation and goals:
  - situation: income, timing, receivables
  - reserve: an account or amount they consider off-limits, and whether reaching
    it requires a deliberate transfer (a wall) or can happen passively (a floor).
    These are different and the message treats them differently.
  - targets: what they're building toward
  - declared: spending they have consciously chosen. NEVER flagged. This is the
    finance equivalent of pausing.
  - known slips: categories they've already told the system they struggle with.
    Do not "discover" these, the user already knows. Flag recurrence or growth,
    not the existence.

These are rows, and only rows. No amount, threshold, account or goal belonging to
a person is ever written into a prompt or into code. This is rule 2.4: the engine
must be byte-identical for a user with $300 and a user with $300,000. Any design
where personal financial numbers live in the engine is wrong.

### The screen
Balance, what's committed against it, runway, and recent transactions grouped by
category. PURE ARITHMETIC. No reasoning, no advice, no charts, no category
editor. Same discipline as the builder: the app does math, the brain does
judgment.

### The daily message
One short line per day.
  - Leads with runway/balance when cash is tight. Nothing outranks it.
  - Names recurring charges specifically.
  - Flags committed spending that exceeds available cash BEFORE it happens, not
    after.
  - On quiet days: something true and steady, not manufactured alarm.
    Silence-adjacent, not invented urgency.
  - Never flags declared items.
  - Before writing, the brain reads its own finance insights from the last ~14
    days and must not repeat itself.

### Scope discipline
One tab, one message a day, one row per insight. If this lane ever needs a second
screen, it has outgrown its lane.
