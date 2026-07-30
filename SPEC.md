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

One screen, opened once a day. Two sections, top to bottom:

1. **Things** — habits, projects and tasks in one list, coldest first.
2. **The day** — the builder, showing today or tomorrow.

Behind it: a Postgres notebook (Supabase), two read-only calendar feeds, and a
Telegram bot that only ever sends.

### The brain is wired and unused

> ### ⚠ Read this before writing the next caller
>
> **Tool results are not fenced.** Rows come back from `search_entries` and
> `get_calendar` as bare JSON in the tool-result block, and the only thing
> standing between "a row the person wrote" and "an instruction to the model"
> is a paragraph of the system prompt. There is no marker in the text.
>
> In an agent loop the tool results are the *main* channel by which a person's
> own words reach the model — far more of them, over more turns, than anything
> handed in as `data`. So the half of the guarantee that is enforced
> structurally is the smaller half.
>
> The `data` argument is safe (see below). The tool path is not. **Close this
> before anything calls the brain in anger**, by fencing each result in the
> loop the same way `composeTask` fences `data`.

`brain.js`, `usage.js`, `untrusted.js`, the Anthropic API key and all the API
wiring are still here and still functional. **Nothing calls them.**

`tools.js` is the exception. Its brain-facing tools are idle, but `readCalendar`,
`create_entry` and `update_entry` are the live write path the routes go through,
and the whitelist at the top of it is what keeps the retired columns unwritten.
It is a runtime file that the brain also happens to use.

The rest are kept deliberately. Reasoning was removed from this system because every
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

That is also why the tool-result hole at the top of this section matters more
than it looks. It is the same failure in a different place: a rule held up by
prose rather than by structure, which stays true right up until someone who
never read the prose writes the next caller.

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

Nothing asks anyone to confirm the ordinary case. A block sitting in a day that
has passed is a block that happened, and the only thing that says otherwise is
taking it out (§2.5).

There was a review once — a screen that asked, the next morning, which of
yesterday's blocks had happened. Then the question moved onto the blocks
themselves, asked in place as the day went. Then it went away, because the answer
was already being given by whether the block was still there.

### 2.5 Saying it did not happen is taking it out of the day

There is no separate mark for a miss, and no separate gesture. A block you did
not do is removed, like any other block you no longer want in the day, and
staleness counts the blocks that are left.

This replaced a mechanism that recorded the outcome in `blocks.completed` and
asked about it in place, on each past block, as the day went. It was one concept
too many: the screen had to explain what a removal meant on a block that had
already started, and the swipe meant a different thing depending on the clock.
One rule is smaller than two, and the thing being recorded is the same either
way.

`blocks.completed` and `blocks.miss_reason` **remain in the database, unused**.
Nothing writes them, and no column was dropped. `staleness.js` still filters on
`completed`, which every row now passes because the column still defaults to
true. The filter is inert and kept on purpose: if anything ever sets that column
again the query already means the right thing, and removing it would be a second
change to make later, in the place hardest to notice it was needed.

### 2.6 Wiping personal rows returns the system to factory state

Nothing about how the system behaves lives outside the database.

---

## 3. The screen

### 3.1 Things

Habits, projects and tasks in **one list**. A task left three weeks is the same
problem as a project left three weeks, so they share a list rather than being
filed apart.

**Ordered by how long each thing has been left, coldest first.** The order is
arithmetic on the days, not anything the person arranged: there is no ranking and
no drag, and `entries.sort_order` is retired — written by nothing, read by
nothing, kept only because dropping a column cannot be undone.

`blocks.sort_order` is a different column and is load-bearing. It is what holds
the order of blocks within a plan, written on every confirm and read back by both
`GET /plan/:date` and the block reads. The two share a name and nothing else.

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
muted it would draw a second column of emphasis competing with the titles.

This was a long press with nothing on screen to suggest it, which meant three
actions reachable only by already knowing they were there — and one of those
three, Edit, had no route into it at all: the update endpoint existed and
nothing on the page ever called it.

Delete is last and is the only one in the warn colour. Between two ordinary
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

#### Already in the day

A thing that already has a block in the day on screen is **greyed**, and that is
the whole signal. No badge beside it: it said *in today's plan* for a while,
which was a second way of saying what the colour already said.

Its **warning mark is held back** too. The mark asks "does this need your
attention" and being scheduled answers it, so a greyed row still shouting a
deadline would be arguing with itself.

**Tapping it takes it back out of the day.** The last of its blocks, so a thing
scheduled twice comes out one tap at a time and the row stays grey until none
remain. It goes through the ordinary removal, so it is undoable like any other.

**Unless that block has begun**, in which case nothing happens and the row stays
grey. It is the day that happened, and the server refuses to remove it — see
3.2. The row does not pretend otherwise.

The `···` menu is unaffected throughout: edit, done and delete all work.

Read off the blocks the builder is holding rather than anything stored, so
removing its block frees the row on the same render, and so the answer follows
the switch: a thing in tomorrow is not greyed while you are looking at today.

#### 3.1.1 Warning marks

Arithmetic, and only arithmetic (`warning.js`).

```
size → days needed
  a day = 1    a few days = 3    a week = 6    a few weeks = 15    months = 40

slack = days_until_due − days_needed

  slack <= 0    →  !!!    (in the warn colour)
  slack 1–3     →  !!
  slack 4–10    →  !
  slack > 10    →  no mark
```

A due date in the past gives a negative slack and therefore `!!!`, which is
correct: overdue is the most urgent thing the scale can express.

**A mark is static.** It does not decay as work happens, because the system is
not told when work happens — the only thing it knows is that a block was
scheduled and left in the day, which is not the same as progress. A mark that
moved on that evidence would be inventing a completion percentage nobody
reported. It changes when the person changes the date or the size, and when the
calendar advances. Nothing else moves it.

**No mark means "nothing to say", never "fine."** A row with no due date, no
size, or an unrecognised size shows nothing.

### 3.2 The day

#### Today / Tomorrow

**The switch is the label.** There is no new control: the heading that used to
name the day now chooses it. `Today / Tomorrow` followed by the date, on the
same row and at the same height as any other section label, and either word can
be pressed. The word you are not looking at is very faint (`#4A443C`) — legible
as a way back and nothing more.

Which one the app opens on is `profile.plans_in`:

| | |
|---|---|
| `evening` (default, and what null means) | opens on **Tomorrow** |
| `morning` | opens on **Today** |

There is no settings UI. The column is set by hand.

Switching replaces everything held about the day being built. Anything
unconfirmed on the day being left is dropped, which is what a page reload does
too.

#### When today is showing

Two words, and the difference between them is the whole of this:

| | |
|---|---|
| **begun** | its **start** time has passed |
| **past** | its **end** time has passed as well |

Everything past is begun. What sits between them is the block you are in right
now.

**A block that has begun is fixed in place.** No duration chip, no note, no
reorder. It is the day that happened, or is happening, and the server refuses to
retime or resize it anyway — so offering any of those was offering something that
would be rejected on the way out. *Begun* is read off the block's **stored**
start, the same question the reflow asks when it decides what to hold in place.

**The lock is asked of the clock, not of the last render.** Nothing on this page
re-renders on a timer, so a page left open across a block's start time is showing
a drawing of a moment that has passed. Rendering is allowed to go stale — it is a
picture. What a press is allowed to *do* is not, so each gesture asks again at the
moment it fires rather than trusting the flag it was handed when the card was
drawn.

That held for an hour at a time in practice: a page opened at 09:59 went on
offering the chip, the hold and the note swipe on a block that started at 10:00,
and only said **active** after the edit, on the render the edit itself caused.
The chip is the sharp one, because it only ever grows and wraps 4h back to 30m —
one press on a four-hour block an hour in ends it before the current time and
slides it bodily into the past.

Pressing a stale chip **redraws** rather than doing nothing quietly. The chip
disappears, the block says *active*, and the press has a visible answer; a
control that swallows presses reads as broken.

**It can still be removed.** That is the one thing on this list that is not
locked, and it is deliberate: taking a block out is how you say it did not
happen (§2.5), so a rule that allowed it only before the block started would be
refusing the statement precisely when there was something to state.

- A **past** block renders as an outline rather than a filled card, with a faint
  title, and carries **nothing** where the chip would be. It used to ask
  **didn't happen?** there; the outline and the faint title were always what
  marked it as done, and they still are.
- A block that has **begun but not ended** is still a card, and says **active**
  where the chip would be. The slot cannot be left empty on this one: unlike a
  past block it is a filled card like every other, so a gap there reads as a chip
  that failed to render rather than one deliberately withheld.

  The label is **muted, not the accent colour**, and this is the point worth
  keeping. That slot holds a tappable blue pill on every block above it, so a
  blue word in it invites a press that does nothing. Muted rather than faint
  because this block outranks one that is already over.
- A **past** block no longer shows its note. A note says what you are going to do
  in a block, and once the block is over it is not answering that any more. It is
  **hidden, not lost**: the row still holds it, the confirm still sends it, and
  the message that already went out carried it. Blocks in progress and still to
  come show theirs as before.
- A **Next divider** sits between what has been and what is left: a dot, the
  word, and a hairline. It is drawn once, and not at all on a day entirely behind
  or entirely ahead, where it would be marking the edge of the list rather than a
  place in the day.

  It reads **Next**, and it used to read **NOW**. The word changed where it
  sits. *NOW* named the moment, and was true wherever the line fell; *Next* is a
  claim about the block directly underneath it. So the line moved down by one:
  it is drawn above the first block that **has not started**, where it used to
  be drawn above the first that **had not finished**. Those differ by exactly
  one block — the one in progress — and with the old placement the divider would
  have called a running block the next one while that block's own right edge
  said *active*.
- The **Starts control is hidden.** The day has already started, so there is
  nothing to decide about when it does.

**The past does not flow.** A block that has already begun keeps the hour it
began at, whatever the blocks above it do — the message naming that hour has
usually gone out, and a plan that rewrote this morning as the afternoon would be
a plan about a day nobody lived. Everything still to come flows from the later of
where the last block ended and the **next half hour**, so a block added now lands
ahead of now rather than back at the wake time.

That means a day which has run late shows its remaining blocks pushed forward.
When it does, the day on screen no longer matches the day stored, and **Confirm
lights up again** — the times being shown are not the times delivery would use
until it is pressed.

Confirming today works exactly as confirming tomorrow, through the same id
reconciliation. Delivered blocks keep their history and still refuse retiming,
resizing and removal.

#### When tomorrow is showing

Exactly as it was: Starts visible, nothing past, no divider.

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
  This is the one stepper left on the screen.
- **Blocks flow in sequence.** A block begins when the one above it ends, and
  that is the whole rule. Changing one duration shifts everything below it.
- **+ Block** adds a manual block.
- **Day ends** is live, and reads `HH:MM next day` in the warn colour past
  midnight.
- **Confirm** saves the plan. Any edit afterwards un-saves it.

#### A block is worked by gesture

A block is the only thing on this page you handle rather than press. It carries
no `···` the way a row in Things does; the card itself is the target.

**Tap the duration.** The chip on the right shows the length and is the control:
each tap adds half an hour, `30m → 1h → 1.5h → 2h → 2.5h → … → 4h`, and at four
hours it wraps back to thirty minutes. A half hour reads as a fraction rather
than as two numbers — `1.5h`, not `1h 30m` — because one number is quicker on a
chip and every length the chip produces has a half or nothing. It wraps because nothing shortens a block, so
every length is at most seven taps away and none is a dead end. New blocks start
at thirty minutes. A length saved off the grid by an older build is floored onto
it by the first tap rather than cycling `45 → 75 → 105` for ever.

The chip is blue, because blue is what you can act on, and it is a real
`<button>` so a keyboard reaches it. The tap is handled on `click` rather than
on pointer release for exactly that reason.

**Swipe left removes.** Any block — upcoming, in progress, or over. One rule, and
the clock does not enter into it. It commits on release, with no confirmation,
and offers **Removed · Undo** for six seconds. That is a better trade than a
confirm: a confirm interrupts every removal to catch the rare wrong one, and the
undo interrupts none of them and still catches it.

It used to mean two things. On a block that had begun it marked it **missed**
instead, because a begun block could not be removed, and swiping again put it
back. That is gone with the rest of the miss mechanism (§2.5): removing the block
IS how you say it did not happen.

**Swipe right to write a note.** A field opens on that block. Not available on a
block that has begun: a note says what you are about to do in a block, so it is
fixed once the block starts, along with its length and its place in the day.

The backing says which of the two the finger is on before it comes off. **One
surface, and the word is the whole difference:**

| swipe | label | edge |
|---|---|---|
| left | `Remove` | right, the edge being uncovered |
| right | `Note` | left, likewise |

**The removing side is not the warn colour.** It was — the full card filled with
it while a finger was on the block — and it is now the same quiet surface as the
note swipe. Three reasons, in order of weight:

- A removal already has a six-second undo. The colour was never what made it
  safe, so all it added was volume.
- It was loudest on a **past** block, which is exactly where it should have been
  quietest: taking one of those out is not damage, it is how the day gets
  recorded (§2.5).
- The warn colour is for warnings. A removal you can undo is not one.

There was a **loudness axis** here as well as a side, from when left meant two
different things depending on the clock. Left means one thing now and neither
swipe is loud, so the axis is gone rather than left in place holding a single
value.

A swipe with nowhere to go does not travel at all — the card stays put and no
backing appears, rather than following the finger and then doing nothing. That is
now the note swipe on a begun block; it used to be the removing swipe on a
delivered one.

Both swipes need real travel before they commit, far enough that a hand doing
something else cannot reach it by accident.

#### The note

Free text, a line or two, saved **on the block and not on the entry**. That is
the whole point of it: *"finish the pricing page"* is true of Tuesday morning,
not of the project. Put it on the entry and it becomes a claim that outlives the
session it describes, and the next block for the same project inherits a sentence
about a different day.

It follows from that. Change the plan and the note goes with the day.
Re-confirm without it and it is cleared, like everything else on the block.

A block that has one shows it under the title, small and muted, so a glance down
the day shows which blocks carry one without any of them shouting. Swiping right
again reopens it for editing; clearing the text removes it. It saves when you
leave the field — there is no button, because there is nothing to decide.

Set up to be talked at: a textarea so both lines are visible, capitalised by
sentence, spellchecked, and with autocomplete off, because a field guessing at
the next word gets in the way of dictation.

A block with its note open **takes no gestures at all**. Placing a cursor is not
handling the block, and a hold that lifted the card out from under the keyboard
would be the worst of both.

**The note goes into that block's Telegram message**, on its own line after the
title and time. It is the only thing in that message besides the header — see
4.1. Used verbatim: nothing parses it, trims it or reasons about it. Escaping is
`telegram.js`'s job, which it already does for every message, so a note
containing a `<` arrives as a `<`.

Capped at 500 characters. It is described as a line or two and it is sent
verbatim, so the ceiling exists to stop an unbounded field meeting Telegram's
own limit somewhere less helpful.

**Press and hold to reorder.** No drag handle: 400ms anywhere on the block,
including on the duration chip. Not on a block that has begun — picking it up
would offer a drop the server refuses, and the day it would be carried out of
has already happened. It vibrates if the device can, then lifts —
larger, lighter, shadowed, with every other block stepped back — so there is no
question which one is in your hand. Drag vertically and the others part to show
the gap it will drop into. Release settles it into place over 180ms rather than
snapping.

#### Which gesture wins

Four things share one finger, so which is happening is decided once, early, and
then held to. Nothing re-decides mid-gesture and only one gesture runs at a time.

| | |
|---|---|
| tap the duration | cycle it |
| tap anywhere else | nothing. A block is not a button |
| hold 400ms | pick it up. **Beats the tap** |
| move horizontally past the threshold | swipe |
| move vertically | the page scrolls, and the block takes no further part |

`touch-action: pan-y` on the card does the hardest part of this, and it is CSS
rather than script: the browser keeps vertical panning for itself and hands
horizontal movement over, so **a scroll can never become a swipe** regardless of
what the script does. Movement past the threshold cancels the hold timer, and a
gesture that commits swallows the click that follows it — otherwise a swipe
begun on the chip would also lengthen the block on its way out.

#### A carried block takes the page back

`pan-y` is right for tapping and swiping and wrong for carrying: the browser is
entitled to claim a vertical drag as a scroll, and claiming it means firing
`pointercancel`, which tears the reorder down. That is what "the drag activates
and then scrolling takes over" is.

So while a block is held, a **non-passive `touchmove` listener** is installed on
the document and calls `preventDefault()` on every move. It is removed the
moment the finger lifts, and also if the gesture is cancelled — a page left
unable to scroll would be a worse bug than the one this fixes.

Three things that look like the fix and are not, recorded because each is worth
not trying again:

- **`preventDefault()` on a `pointermove`.** Pointer events cannot cancel a
  scroll at all, whatever the listener's passivity. A call there does nothing.
- **`setPointerCapture`.** It routes later events to the element. It does not
  stop the browser competing for the gesture, so the drag was already captured
  and still lost.
- **Setting `touch-action` when the hold fires.** The value is read when the
  pointer goes down and latched for that gesture, so changing it 400ms later
  cannot affect the gesture in flight. It is set anyway, because it is correct
  for anything starting afterwards and costs nothing, but it is not what does
  the work.

The listener works here specifically because the hold requires stillness: no
scroll has begun by the time it is installed, so there is still one to prevent.

The drag is measured against where the page is now rather than where it was when
the hold fired. Holding the page should mean those never differ; if they ever do,
the block stays under the finger instead of drifting by however far the page
moved.

#### Re-confirming reconciles, it does not rebuild

The builder holds the whole plan, so what it sends is the plan. The server
reconciles that against what is stored, **by id**:

| | |
|---|---|
| block sent **with** an id | updated in place |
| block sent **without** one | inserted |
| id stored, absent from the payload | deleted |

The client is handed each row's id when it loads the plan, and hands it back. A
confirm also returns the ids of the day as it now stands, in the order it was
sent, so a second confirm in the same session still knows which block is which.

**Nothing is matched by title or by time.** Reordering and retiming are exactly
what re-confirming is for, so any such guess would be wrong precisely when the
day had changed most.

Every id in a payload must belong to this user's plan for that date. One that
does not — from another day, from another plan, or repeated twice — rejects the
whole request, before anything is written.

**Why it matters.** This used to delete every block for the date and insert the
whole day again. The rows that came back were new rows, so every column a
confirm does not set fell to its schema default — including `message_sent_at`,
which went null, putting a block that had already gone out back in the delivery
queue. If it had started within the last 30 minutes it was **sent a second
time**.

It is not carried forward by hand. The rows are never recreated, so there is
nothing to carry: the column is simply not in the update.

#### A delivered block cannot be retimed or resized

Once `message_sent_at` is set, that block **cannot be moved or resized**. The
message named a start time and a length, and both were true when it went out.
Both attempts are refused server-side, naming the block and the time it was sent
at. Its title and its note can still be edited.

**It can be removed.** That refusal existed too, on the grounds that the day
that happened is not editable — which held while a removed block and a missed
block meant different things. They no longer do (§2.5), and the rule was drawing
the line at whichever half hour the delivery job last ran: the same block was
removable at 08:59 and not at 09:01.

`GET /plan/:date` still returns a `sent` flag per block. **The screen no longer
reads it.** It decided what to offer on a delivered block from that flag once,
and now decides from the clock: a block that has begun keeps its hour and its
length whether or not the job has run yet. That is the stricter of the two and
never the wrong way round, because delivery happens at the start time.

The gesture decision is still made on the raw movement, not the clamped one —
a finger dragging left on a delivered block has moved, and reading that as
stillness would leave the hold timer running and turn a refused swipe into a
pick-up.

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

Finish the essay draft
```

Two parts, both read straight off the block's own row:

| | |
|---|---|
| the header | title and both times, always |
| the note | what they said they were doing, verbatim. See 3.3 |

**Nothing is composed.** There is no assembly step at confirm time, nothing
stored for delivery to read back, and no arithmetic anywhere on this path. The
message is four columns.

It used to carry a third part: a line naming the deadline, then later the gap.
Both are gone, for one reason twice. **Every fact this system can derive about a
block is already on the screen** — the deadline as a warning mark, the gap as the
order of the list and the words on the row — and the person read it there on the
evening they put the block in tomorrow. Repeating it at the block's start time
named a thing they had already decided about, at the hour they could least act on
it.

What is left is the one thing the screen cannot say back to them: their own
sentence about this particular hour.

A block with no note sends the header alone. That is a plain notification, and it
is deliberate — if they did not write anything, there was nothing to say.

`blocks.message_text` is left in place holding whatever it last held, and read by
nothing.

**Delivery.** The scheduler ticks every 15 minutes and asks which blocks of
today's confirmed plan have started and not been sent. A block more than 30
minutes late is marked sent without being sent and logged under `[EXPIRED]`,
because "Gym, 08:00" arriving at 14:00 is worse than nothing.

#### Nothing is sent twice, because the queue is claimed before the send

A block is taken out of the queue **first**, and only then delivered:

```sql
update blocks set message_sent_at = now()
 where id = ? and message_sent_at is null
returning id
```

One statement, so the database does the comparing. Of two callers arriving
together exactly one updates a row; the other updates none and is told so, and
takes that as "somebody else has this one".

**The mark used to be written after the send came back.** That left the row
unclaimed for exactly as long as the Telegram call took, and the queue is
`message_sent_at IS NULL` — so anything looking in that window found an unsent
block and sent it again. This produced real duplicates: the same block appearing
twice, and once three times, in one day's logs.

Two things put a second reader in that window, and **neither is a fault**:

- A Railway deploy overlaps the old container and the new one, so for a moment
  two schedulers are running.
- `scheduler.js` ticks the moment it is required, so every start re-checks the
  whole grace window instead of waiting for the next quarter hour. That is what
  makes a redeploy not swallow a message.

Checking and then acting was the fault. Claiming first fixes it for any number
of callers, without either of those having to change.

**A failed send releases the claim**, so the next tick retries it while the
block is still inside the grace window. What that ordering costs is a crash
between the claim and the send, which loses that one message rather than
repeating it — the right way round, because a message that never arrives is a
gap in a day and one that arrives twice makes the system look broken.

The **evening nudge** has the same shape and the same fix: `sent_log`'s unique
constraint on `(user_id, job, sent_for_date)` is the lock, and the row is now
inserted *before* the send rather than written afterwards as a receipt. A
`23505` unique violation is the answer "somebody else has the slot", not an
error. The cheap `alreadySent` read stays in front of it as an early-out, but it
is no longer what guarantees anything.

Delivery is gated on `status = 'confirmed'`, and that gate is **defensive
rather than descriptive**. `plans.status` allows `'pending'` and the column
defaults to it, but nothing in this system writes that value: there is no draft,
no autosave, and the builder holds the whole day in memory until Confirm. So a
pending row can only arrive by hand, through SQL. The gate stays because a plan
nobody agreed to must never generate messages, and the cheapest way to guarantee
that is to check rather than to rely on no such row ever existing.

There is no grace window for a block whose text has not been written yet. The
line is composed in code and inserted with the block, so a block that exists has
whatever text it is ever going to have.

### 4.2 The evening nudge

At `profile.nudge_hour` (default 20:00), local time, if the day this person plans
has no confirmed plan:

| `plans_in` | asks about | says |
|---|---|---|
| `evening` (default) | tomorrow | `No plan for tomorrow yet.` |
| `morning` | today | `No plan for today yet.` |

The hour is unchanged; only the day it asks about moves. Nudging an evening
planner about today would name a day they are already halfway through, and
nudging a morning planner about tomorrow would ask for a plan they do not make
until they wake up.

That is the entire message. One `sent_log` row per evening guards it, claimed
before the send rather than written after it (§4.1), and an evening where the
plan already exists is claimed too so the rest of the evening does not ask
again.

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
| `server.js` | serves the page, mounts two routers, starts delivery |
| `db.js` | the Supabase client |
| `user.js` | which user this process serves |
| `clock.js` | dates and clock times as numbers, in the person's own timezone |
| `staleness.js` | entry → the most recent plan date it still has a block on |
| `warning.js` | the mark: size against time left, and nothing else |
| `messages.js` | what Telegram sends for a block: the header and the note, read off the row |
| `scheduler.js` | the 15-minute tick: block delivery and the evening nudge |
| `telegram.js` | the send |
| `routes/entries.js` | Things: read, add, edit, finish, delete |
| `routes/plan.js` | the calendar aside, and saving a day |
| `public/index.html` | the whole app: markup, styles and script in one file |
| `public/mockup.html` | the layout reference the page is built against |
| `public/switch.html` | the reference for the Today / Tomorrow switch and past blocks |
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
| `migration-note.sql` | `blocks.note` |
| `migration-plans-in.sql` | `profile.plans_in`, and the check constraint on its two values |

**No column or table has ever been dropped.** The strip retired
`entries.why`, `entries.body`, `entries.priority`, `entries.sort_order`,
`entries.cold`, `entries.cold_reason`, `entries.paused_at`, `blocks.pinned` and
the whole finance side. All of it is still there, still holding whatever it last
held, and read by nothing. Dropping a column is the one move that cannot be
undone, and an unread column costs nothing.

The `messages` table is in the same state and was not part of this: it stopped
being read when the chat was removed, well before any of the above.

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
| `profile.plans_in` | `morning` or `evening`. Which day the app opens on, and which day the nudge asks about. Null means evening |

---

## 7. The look

Reference: `public/mockup.html` for the screen, `public/switch.html` for the
Today / Tomorrow switch and the shape of a past block.

**Every time on the screen and in a message is twelve hour with AM/PM**, in
tabular figures. Storage is untouched: the page still sends minutes, the row is
still a 24-hour `time`, and one function on each side decides how a time reads.

| | |
|---|---|
| bg | `#16130F` |
| card | `#211D18` |
| hairline | `#2C2721` |
| text | `#EDE7DE` |
| muted | `#8B8177` |
| faint | `#6B6459` |
| accent | `#6E8CB8` |
| warn | `#C4694A` |

The rules, which hold everywhere and are pinned by `tests/plan-layout-check.js`:

- **A row is a row.** Things is plain rows with hairline dividers between them.
  Only a builder block is a card, because a card says "this is an object you
  move", and those are the only objects here that move — and a block that has
  already happened drops to an outline, because it has stopped being one.
- **Sections are separated by space**, 36px of it — not by borders, not by nested
  containers.
- **One label style:** 10px, uppercase, 0.14em tracking, muted. Actions like
  `+ Add` sit on its baseline and are **quieter** than it, never louder.
- **Two text sizes per row:** 15px title, 12px muted meta on its own line with
  real space between them.
- **Blue is actionable, with one exception.** It appears on the Starts steppers,
  the duration chip, Undo, Confirm and Save — everything a press acts on — and on
  the **Next** divider, which no press acts on and which says *here is where you
  are*. That is the whole list, enforced by name in the layout check; nothing
  decorative is ever blue.

  The near miss is the **active** label. It says much the same thing as the
  divider a line above it, so blue is the obvious reach — and it is wrong,
  because it sits in the slot the duration chip occupies on every other block.
  Blue there is an invitation to press something that does nothing. Pinned by
  name in the layout check so it cannot drift back.

  The rule was relaxed to two exceptions when the day switch arrived and is back
  to one: the *in today's plan* badge was the other, and removing it narrowed the
  rule again rather than widening it further.
- **The warn colour warns; it does not narrate.** The deadline mark, a day
  running past midnight, a feed that failed, and Delete in the row menu. That is
  the list. It has lost two other jobs: a missed block, a concept that no longer
  exists, and the swipe backing, which filled the whole card under a finger for
  an action that carries an undo.
- **The calendar aside is a left rule with indented text**, in neutral warm grey.
  Reference material: not a card, not blue, not a warning.
- **Tabular figures on every time.**

### Motion

`prefers-reduced-motion: reduce` keeps every gesture working and drops the
movement. A held block still lightens, still raises its tone and still steps the
others back — those say *this one is in your hand*, which is information rather
than decoration. What goes is the growing, the shadow, the parting transitions
and the 180ms settle; the reorder commits the instant you let go.

The preference is read at the moment it is needed rather than cached at load, so
changing it in the OS takes effect without a reload.

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
