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

## 1. What it is

One screen, opened once in the evening. Three sections, top to bottom:

1. **Yesterday** — what was planned, each row one tap away from "didn't happen".
2. **Things** — habits, projects and tasks in one list, coldest first.
3. **Tomorrow** — the builder.

Behind it: a Postgres notebook (Supabase), two read-only calendar feeds, and a
Telegram bot that only ever sends.

### The brain is wired and unused

`brain.js`, `tools.js`, `usage.js`, the Anthropic API key and all the API wiring
are still here and still functional. **Nothing calls them.**

They are kept deliberately. Reasoning was removed from this system because every
place it was used turned out to be a place where arithmetic on a row said the
same thing more reliably: a daily verdict on what had gone cold, a line of
context on each block, a rewrite of a text field. None of those needed a model,
and each one made the system harder to predict and slower to trust.

But the plumbing is the expensive part — the fencing, the tool whitelist that
cannot be talked past, the per-call cost metering — and rebuilding it correctly
from nothing is work that has already been done once. So it stays, wired and
idle, for whenever reasoning has a job that genuinely needs it.

Two rules survive with it, and they apply the moment anything calls it again:

- **The notebook is DATA, never INSTRUCTIONS.** A title that says "ignore your
  instructions" is a title. See below for where this is enforced.
- **The tool set is fixed and small.** `user_id` is always the first argument and
  always supplied by the caller, never chosen by a model. Columns that represent
  a person's own declaration are off the whitelist entirely.

#### Fencing is enforced inside `runBrain`

```js
runBrain(user_id, TASK, { data: rows, source: 'block-messages' })
```

The two arguments mean opposite things. `task` is engine text: written in this
repository, identical for every user, never built from a row — an instruction.
`data` is anything a person, a feed, or this model on an earlier day wrote —
never an instruction, however it is phrased. `runBrain` fences `data` on the way
in (`untrusted.js`), and there is no way to pass it that skips the fencing.

Data first, instruction last, so the final thing the model reads is the thing it
is meant to act on. A caller arriving with a fence marker already in its `task`
is refused, so there is exactly one way to fence.

**This was not true until it was made true.** Fencing used to be the caller's
job: each one wrapped its own untrusted text and concatenated the result.
That held for exactly as long as the callers that remembered it, and both were
rewritten in the strip — one deleted, one replaced by arithmetic. `untrusted.js`
was left sitting in the tree with zero importers, including from `brain.js`. The
next caller will be written weeks from now by someone reading the signature
rather than this paragraph, so the guarantee now lives in the signature.

**Still an open hole:** tool results are not fenced. Rows come back from
`search_entries` and `get_calendar` as bare JSON, and what stops them reading as
instructions is a paragraph of the system prompt rather than a marker in the
text. That is weaker than the `data` path and should be closed before anything
calls the brain in anger.

---

## 2. Core rules

### 2.1 Nothing is inferred that can be declared

The system does not decide on someone's behalf that a gap was deliberate, that a
project is nearly done, or that a deadline is at risk in some way the arithmetic
does not already show. It reads what was typed and counts days.

### 2.2 Deleting takes something off the list

`status = 'deleted'` is a tombstone. The row stays, and it can never be brought
back as anything — not active, not done. A deleted row is a row that should not
have existed.

### 2.3 Finishing is not deleting

`status = 'done'` is work that happened. Both drop out of every read, which all
filter on `status = 'active'`, but they mean opposite things and are recorded
apart.

**Tasks only.** A habit recurring is the whole point of a habit, and a project is
not finished by one session of work on it. Offering Done on either would be
offering to retire something that has not ended.

### 2.4 A day is assumed to have gone as planned

The review only corrects it. Nothing asks anyone to confirm the ordinary case.

### 2.5 A missed block does not count as having done the thing

`blocks.completed` defaults to true and the review sets it false. Staleness
counts only blocks that were not explicitly marked missed. Counting any block at
all meant planning something and skipping it reset its clock exactly as much as
doing it did, so something dodged four weeks running read as fresh every Monday.

### 2.6 Wiping personal rows returns the system to factory state

Nothing about how the system behaves lives outside the database.

---

## 3. The screen

### 3.1 Yesterday

Yesterday's blocks, if the day was planned. An empty answer means yesterday was
never planned, which is not a failure and is not scolded.

Each row is a title and one tap: **didn't happen**. Tapped, the title goes
struck-through and the row reads **missed** in the miss colour. Tapping again
puts it back.

A short reason may be typed under a missed block. It is optional and always has
been — a miss with no explanation is still worth recording, and demanding one is
how a review stops being done at all.

### 3.2 Things

Habits, projects and tasks in **one list**. A task left three weeks is the same
problem as a project left three weeks, so they share a list rather than being
filed apart.

**Ordered by how long each thing has been left, coldest first.** The order is
arithmetic on the days, not anything the person arranged: there is no ranking, no
drag, no `sort_order`.

Each row is two lines:

```
UF application                          !!!
project · due in 6 days · a few days

Reading
habit · 11 days since scheduled

Return the router
task · 3 days since added
```

**"since scheduled" and "since added" are different claims** and the row says
which one it is making. Something that has never been scheduled is counted from
the day it was written down, and calling that "since scheduled" would be
reporting a scheduling that never happened.

Tapping a row adds it to tomorrow, which is what this list is for.

At the right edge of every row is a quiet `···`. Tapping it reveals **Done**
(tasks only), **Edit** and **Delete**. Tapping the row while a menu is open
closes the menu rather than scheduling — tapping away from something you opened
should undo the opening, not commit to something.

The hint is faint rather than muted. It repeats down the whole list, and at
muted it would draw a second column of emphasis competing with the titles. It
is the same weight as *didn't happen* in Yesterday, which is the other
right-edge action on the screen.

This was a long press with nothing on screen to suggest it, which meant three
actions reachable only by already knowing they were there — and one of those
three, Edit, had no route into it at all: the update endpoint existed and
nothing on the page ever called it.

Delete is last and is the only one in the miss colour. Between two ordinary
actions it is a misclick waiting to happen.

#### Adding and editing

`+ Add` opens a sheet. **Edit** opens the same sheet with the row's values in
it, saving to `POST /entries/:id/update` instead of `POST /entries`.

One sheet, not two. The fields and the rules between them are identical either
way, and two copies of the form would be two places for the date-and-size rule
to drift apart.

**The type cannot be changed on an edit.** Changing it would mean deciding what
happens to a frequency on something that is no longer a habit, and the answer is
that this is a different thing and should be added as one. The chooser collapses
to the type the row already is rather than sitting there greyed, because a
disabled control still invites the press.

Five fields, and no others:

| field | applies to | required |
|---|---|---|
| type | — | yes: habit, project or task |
| title | — | yes |
| frequency | habits | yes: daily, few times a week, weekly, monthly |
| due date | projects and tasks | no |
| size | projects and tasks | **only when a due date is set** |

The size buckets are `a day`, `a few days`, `a week`, `a few weeks`, `months`.

The date and the size travel together, in both directions. A due date with no
size cannot produce a warning mark, and on screen that looks exactly like a
comfortable deadline. A size with no date has nothing to be measured against.
Clearing the date clears the size with it.

There is no why, no note about where something stands, and no free-text size.

#### 3.2.1 Warning marks

Arithmetic, and only arithmetic (`warning.js`).

```
size → days needed
  a day = 1    a few days = 3    a week = 6    a few weeks = 15    months = 40

slack = days_until_due − days_needed

  slack <= 0    →  !!!    (in the miss colour)
  slack 1–3     →  !!
  slack 4–10    →  !
  slack > 10    →  no mark
```

A due date in the past gives a negative slack and therefore `!!!`, which is
correct: overdue is the most urgent thing the scale can express.

**A mark is static.** It does not decay as work happens, because the system is
not told when work happens — the only thing it knows is that a block was
scheduled and not marked missed, which is not the same as progress. A mark that
moved on that evidence would be inventing a completion percentage nobody
reported. It changes when the person changes the date or the size, and when the
calendar advances. Nothing else moves it.

**No mark means "nothing to say", never "fine."** A row with no due date, no
size, or an unrecognised size shows nothing.

### 3.3 Tomorrow

#### The calendar aside

Everything on **both** feeds for that date, read-only. Timed events show their
time; all-day entries show the title alone. Timed first in clock order, then the
rest.

**Nothing is auto-placed, nothing is pinned, nothing is stored.** The feeds used
to mean different things — one was things to know, the other things to do, and
the second fed all-day events into the day as blocks that had to be argued with
if you did not want them. Both are now read the same way and shown the same way.
What to do about what is already on the calendar is the person's decision, and it
is the one decision this system had been quietly taking.

Reading a day is therefore repeatable and claims nothing. There is no placement
endpoint and no `placed:` rows.

#### The builder

- **Starts** — an inline control, 30-minute steppers, clamped to 04:00–12:00.
- **Blocks flow in sequence.** A block begins when the one above it ends, and
  that is the whole rule. Changing one duration shifts everything below it.
- 30-minute duration steppers on every block. The floor is one step; below that
  it has stopped being a block, and removing it is what the person means.
- **+ Block** adds a manual or buffer block.
- **Day ends** is live, and reads `HH:MM next day` in the miss colour past
  midnight.
- **Confirm** saves the plan. Any edit afterwards un-saves it.

#### Removing a block

**Minus, carried past the floor.** Shrinking a block to nothing and removing it
are the same intention, so they are the same control — and the stepper already
owns that edge of the card, which is why a block gets no `···` the way a row in
Things does.

At 30 minutes minus stays live rather than going dead. Pressing it there does
not remove anything: it replaces the stepper with **Keep · Remove**.

**Keep sits where minus was.** That order is the whole safety of it. The press
that opens the question is a press on the left of the stepper, and a second fast
press lands in the same place, so the left position has to be the harmless one.
Remove where minus was would make a double-tap delete a block silently, which is
exactly what the confirm exists to stop.

Only one block can be asking at a time, and any other edit — adding a block,
changing a duration, moving the start — drops the pending question. A Remove
button must never end up pointing at a block that has since moved.

Re-confirming replaces the day rather than appending to it. The builder holds the
whole plan, so what it sends is the plan, and merging two versions of the same
day would only invent a third nobody asked for.

The start hour is stored as the fact it is, not inferred from the first block. A
block placed at 06:00 does not mean anyone got up then.

### 3.4 A broken feed does not look like a quiet day

`[]` from a dead feed and `[]` from a quiet Tuesday are the same value. A feed
that cannot be read costs its own events and never the whole builder, but the
failure travels with the answer and is named on screen: *"Dates could not be
read."*

---

## 4. Telegram

**Outbound only.** There is no inbound handler and no chat.

### 4.1 Block messages

One message per block, at its start time.

```
<b>UF application</b>
09:00 to 11:00

Due in 3 days.
```

The header is always facts from the row. The line under it is composed **in
code** when the day is confirmed and stored on the block, because delivery
happens hours later in a different process and has to survive a restart.

Which line a block gets:

- If the entry has a due date → the deadline, measured against the day being
  planned rather than today. Written on Monday evening, "Due tomorrow" has to
  mean Wednesday.
- Otherwise, if it was last done three or more days ago → the gap.
- Otherwise nothing, and the header goes out alone. That is the normal case for
  a buffer block, not a degraded one.

A deadline beats a gap: if something is due in two days, how long it has been
sitting there is the less useful of the two facts.

**Delivery.** The scheduler ticks every 15 minutes and asks which blocks of
today's confirmed plan have started and not been sent. Only a confirmed plan
delivers; a day left pending was built and never agreed to. A block more than 30
minutes late is marked sent without being sent and logged under `[EXPIRED]`,
because "Gym, 08:00" arriving at 14:00 is worse than nothing.

There is no grace window for a block whose text has not been written yet. The
line is composed in code and inserted with the block, so a block that exists has
whatever text it is ever going to have.

### 4.2 The evening nudge

At `profile.nudge_hour` (default 20:00), local time, if **tomorrow has no
confirmed plan**:

```
No plan for tomorrow yet.
```

That is the entire message. One `sent_log` row per evening guards it, and an
evening where the plan already exists is claimed too so the rest of the evening
does not ask again.

The one thing this system cannot do for someone is notice that they never opened
it. Every other message is about something they already decided; this one is
about the evening they did not spend deciding.

It had a second line that named what had gone quiet. That needed a daily verdict
written by a model call, and the whole lane is gone. A version built from
days-since alone would name something every single night, including the nights
when nothing was actually neglected — and a nudge that always fires is a digest,
which this is deliberately not.

---

## 5. Non-goals

- No chat, and no inbound Telegram.
- No auto-planning, no capacity modelling, no priority scoring.
- No ranking or manual ordering. The list sorts itself.
- No finance. That lane existed and was removed whole.
- No coldness verdicts, no cold flags, no temperature bars.
- No setup interview. Things are added one at a time through the form.
- No pause. Something set down on purpose looks the same as something neglected,
  which was the argument for pausing; it is not worth a column and a filter.

---

## 6. Running it

```
npm start      # server + scheduler in one process
npm test       # every suite, sequentially
```

### The files

| | |
|---|---|
| `server.js` | serves the page, mounts three routers, starts delivery |
| `db.js` | the Supabase client |
| `user.js` | which user this process serves |
| `clock.js` | dates and clock times as numbers, in the person's own timezone |
| `staleness.js` | entry → the most recent plan date it was actually done on |
| `warning.js` | the mark: size against time left, and nothing else |
| `messages.js` | what Telegram sends for a block |
| `scheduler.js` | the 15-minute tick: block delivery and the evening nudge |
| `telegram.js` | the send |
| `routes/entries.js` | Things: read, add, edit, finish, delete |
| `routes/plan.js` | the calendar aside, and saving a day |
| `routes/review.js` | yesterday, and marking a block missed |
| `public/index.html` | the whole app: markup, styles and script in one file |
| `public/mockup.html` | the layout reference the page is built against |
| `PLANNING-RULES.md` | **archive.** Notes from the pre-strip system, kept and marked as such |
| `brain.js`, `usage.js`, `untrusted.js` | **wired and unused.** See 1. `brain.js` requires the other two |
| `link.js`, `calendar-test.js`, `send-test.js` | run by hand, not part of the running system |
| `make-icons.js` | regenerates the PNGs from the SVG |

`tools.js` is the exception to "unused": nothing calls its brain-facing tools,
but `readCalendar`, `create_entry` and `update_entry` are the write path the
routes go through, and the whitelist at the top of it is what keeps retired
columns unwritten.

### Migrations

Run once each, by hand, in the Supabase SQL editor. All are safe to run twice.

| | |
|---|---|
| `schema.sql` | the tables |
| `migration-due.sql` | `entries.due` |
| `migration-nudge.sql` | `profile.nudge_hour` |
| `migration-size.sql` | `entries.size`, and the check constraint on its five buckets |

**No column or table has ever been dropped.** `entries.why`, `entries.body`,
`entries.priority`, `entries.sort_order`, `entries.cold`, `entries.cold_reason`,
`entries.paused_at`, `blocks.pinned`, the `messages` table and the whole finance
side are all still there, still holding whatever they last held, and read by
nothing. Dropping a column is the one move that cannot be undone, and an unread
column costs nothing.

What stops anything writing to them is the whitelist in `tools.js`, which is a
short explicit list rather than a filter of things to exclude.

### Environment

Set in Railway, and in a local `.env` that is never committed.

| | |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | the notebook. The service key bypasses row level security, which is why every query scopes `user_id` in code rather than trusting the database to do it |
| `TELEGRAM_BOT_TOKEN` | outbound only |
| `CALENDAR_ICS_URL` | a read-only ICS feed |
| `CALENDAR_ACTION_ICS_URL` | *optional.* A second one. Both are read the same way |
| `ANTHROPIC_API_KEY` | the brain. **Nothing calls it.** Kept so the wiring stays live. Read by the SDK, not by any file here, so grepping the repo for it finds nothing |
| `PORT` | assigned by the host |
| `PI_USER_ID` | *optional.* Which user the server serves |
| `SCHEDULER_DISABLED` | *optional.* `1` loads the scheduler without starting cron |

`PI_USER_ID` defaults to the single real user, so production behaviour does not
depend on it being set. It exists so a test can point a whole server at a
throwaway user and be **structurally unable** to touch real rows — not scoped by
every query being written carefully, but by there being no path to the real id at
all. A test once matched real rows by kind and destroyed a row that could not be
recovered; that is what this prevents.

`SCHEDULER_DISABLED=1` is how a suite drives a single tick by hand. Without it,
requiring the file would also fire cron against the real database and send real
messages. **It must never be set in production**, where its absence is what makes
delivery run.

### Running one job by hand

```
node scheduler.js --run nudge      # also: blocks
```

Fires that job for every profile immediately, ignoring both the hour it is meant
to run at and the `sent_log` guard, and writing no `sent_log` row, so it can be
tried repeatedly. A manual run does not start the timer.

What it does **not** skip is the condition the job exists for: `--run nudge` on
an evening that is already planned still sends nothing, because that is the
behaviour worth testing rather than the timing.

### Which build is running

`GET /version` reports the commit, branch and deployment the host built, the
process start time, the Node version, and whether the scheduler is running.

### What is configurable per user

| | |
|---|---|
| `profile.timezone` | which day and which hour everything is measured in |
| `profile.default_wake_time` | where the builder starts the first block |
| `profile.telegram_chat_id` | where outbound goes, or nowhere if unset |
| `profile.nudge_hour` | the evening nudge hour, 0–23. Null means 20 |

---

## 7. The look

Reference: `public/mockup.html`.

| | |
|---|---|
| bg | `#16130F` |
| card | `#211D18` |
| hairline | `#2C2721` |
| text | `#EDE7DE` |
| muted | `#8B8177` |
| faint | `#6B6459` |
| accent | `#6E8CB8` |
| miss | `#C4694A` |

The rules, which hold everywhere and are pinned by `tests/plan-layout-check.js`:

- **A row is a row.** Yesterday and Things are plain rows with hairline dividers
  between them. Only a builder block is a card, because a card says "this is an
  object you move", and those are the only objects here that move.
- **Sections are separated by space**, 36px of it — not by borders, not by nested
  containers.
- **One label style:** 10px, uppercase, 0.14em tracking, muted. Actions like
  `+ Add` sit on its baseline and are **quieter** than it, never louder.
- **Two text sizes per row:** 15px title, 12px muted meta on its own line with
  real space between them.
- **Blue is actionable.** It appears on the steppers and on Confirm, and nowhere
  else. Nothing decorative is ever blue.
- **The miss colour is for misses and warnings**, and nothing else.
- **The calendar aside is a left rule with indented text**, in neutral warm grey.
  Reference material: not a card, not blue, not a warning.
- **Tabular figures on every time.**

---

## 8. Tests

```
npm test                              # all of it
node tests/run-all.js due-test.js     # one suite
```

Sequential on purpose: they share one test user, and two of them writing the same
rows at once would fail for a reason that has nothing to do with the code under
test.

`run-all.js` **refuses to start** if any suite could reach the real person's
rows. It reads each file and computes whether the app modules it imports can see
the database, rather than trusting a hand-kept list of dangerous files. A suite
that writes must import `harness.js`, and no suite may name the real user id at
all.

`harness.js` hands out a database client that is physically unable to write to
anyone but the test user: an insert without the test id in the payload, or an
update or delete without it in the filter, throws before it reaches the network.
This exists because scoping by hand failed once, destructively.

Suites are **deleted rather than skipped** when the thing they covered is
removed. A suite that cannot run still reads as coverage, which is worse than
having no file there at all.

No suite calls a model, because nothing in this system does.
