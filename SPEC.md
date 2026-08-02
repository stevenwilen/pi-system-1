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

1. **The day** — the builder, showing today or tomorrow.
2. **Things** — habits, projects and tasks in one list: what is running out of
   room, then what has gone cold.

Behind it: a Postgres notebook (Supabase), one read-only calendar feed, and a
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

### 2.7 The calendar is reference, and there is one of it

`profile.calendar_ics_url`, read and shown at the top of the day as what is
already happening. **Nothing on it is ever placed into the day, pinned, claimed,
or written to a plan.** Every block in a day is one the person put there. The
calendar is a thing to look at while deciding, and the deciding is theirs.

There were two, meaning things to KNOW and things to DO, and the calendar an
event sat on decided whether the day was built around it or the event was fed
into the day as work. That asked people to file their life twice — once in
Google and again in their head — to answer a question this system stopped asking
when auto-placement was removed. One calendar says the same thing with nothing
to maintain.

`profile.calendar_action_ics_url` remains in the schema, holding nothing, read
by nothing, and deliberately not writable from the settings sheet — a screen
that could still fill it would keep the dead feed alive in the data long after
it left the code. Dropping a column is the one move that cannot be undone.

Nothing is filtered by TRANSP, by calendar name, or by anything inside the
event. What is on the calendar is what is shown. It is optional: an account with
no url has an empty aside, not a broken one.

**Three ways to have nothing to show, and three sentences.** The list is empty
in all of them, so the list cannot be what says which:

| | |
|---|---|
| nothing on it | *Nothing on it.* |
| could not be read | *Could not reach your calendar.* in the warn colour |
| never set up | *No calendar yet. Add one in setup.* |

A calendar broken for a week reads exactly like a free week, and an account that
never set one up reads like both. A partial read — some events *and* a failure —
says *this may not be all of it*, because "nothing on it" would be a lie in the
other direction.

The feed is cached for sixty seconds, keyed by user and url. See 2.8 for why the
url is what makes that safe.

### 2.8 Setup verifies itself, or it has not happened

Everything a person must configure sits on one screen behind the `···` in the day
header, and none of it needs SQL: the Telegram chat, the calendar, and Sign out.

**A full page, not a sheet.** A sheet is a card held against the bottom of the
window with the day greyed out behind it, and its shape says "answer this and get
back to what you were doing" — right for the add form, wrong here. Setup is a
handful of things worked through, some of which send a message and wait on it,
and a scrim over a half-visible day makes that feel like an interruption to
itself. So it takes the screen, at the same width as the day, with Back at the
top instead of Close at the bottom.

It has no tap-outside-to-close, and the absence is deliberate: a sheet has an
outside and tapping it is how you dismiss one, but a page has none. Every pixel
belongs to it, so a stray tap on the background would close a screen someone was
reading with no way to tell why.

**Nobody is ever sent here.** Signing up lands on the planner, empty, and setup
opens when the dots are pressed and at no other time.

A new account opened on setup instead, for one release. The reasoning was that
an empty day cannot explain itself: broken, empty and waiting all render as the
same screen. Watching an actual new person meet it settled it the other way —
the first thing between someone and the thing they signed up for should be the
thing they signed up for. Whoever hands this system to someone can say what the
dots are for in a sentence, and that is cheaper than a screen which stops
everyone to solve a problem one person had once.

The way out therefore says **Back**, and only ever Back, because there is always
a day behind it. `openSettings` takes no argument, which is the structural half
of the same rule: a parameter saying which kind of visit this is would be a way
to be sent.

**Saving tests what it was given and reports what happened.** Every value here
looks correct when it is wrong — a mistyped chat id is still ten digits, a
revoked calendar url is still a url — and neither says anything until a message
does not arrive or an aside is empty, days after the paste that caused it. So a
save sends a real Telegram message, and fetches each feed once.

**Three outcomes, kept apart everywhere:**

| | |
|---|---|
| reachable, with events | it works, and here is how much is on it |
| reachable, empty | it works, and there is nothing on it |
| unreachable | it does not, and here is what it said |

The middle one is why this is not a boolean. An empty calendar and a dead url
both show nothing on the day screen, and someone who cannot tell them apart goes
looking for a bug in the wrong place. `probeFeed` checks for `BEGIN:VCALENDAR`
before parsing for exactly that reason: handed an HTML login page the ICS parser
throws nothing and returns no events, which would arrive as "reachable, empty".

**A failed check never blocks the save, and never passes for success.** A feed
can be unreachable for a minute for reasons that have nothing to do with the
url, and making someone paste it again would be punishing them for the network.
It is stored, and reported as failing.

**Nothing stored is ever sent back.** The sheet is told a host and a last path
segment, or the last four digits, and no more. A secret iCal address is a bearer
credential — whoever holds the string reads that calendar for ever, with no
sign-in and no audit — so the settings screen must not become the easiest place
in the system to photograph one. The screen says this in as many words, beside
the field it applies to.

**Each field carries its own instructions.** Numbered steps naming the exact
words a person will see on the other screen, and a small drawing of what to
look for: the bot reply with the number marked, and the Integrate calendar
panel with the secret address row marked. Drawn as inline SVG rather than
captured, so nothing goes stale when Telegram or Google moves a button and the
page stays self-contained. Each carries an `aria-label` saying what it shows,
because a picture that says nothing to a screen reader is decoration in the
middle of an instruction.

**There was a paste box, and it is gone.** A prompt you copied into an AI chat,
a conversation that interviewed you, and a block of JSON you pasted back — which
set both fields and your first list of things in one go. It worked, and it
asked a new person to leave the app, talk to a second system, and trust a
machine-readable answer they could not read. Two fields with instructions beside
them is the smaller thing that does the same job.

`entry-shape.js` stays. It holds the rules for what a habit, project or task may
be, and the add form is now its only caller.


### 2.9 A request is whoever its token says, and nothing else

There is no default user. `PI_USER_ID` is gone, and so is the fixed uuid it fell
back to. Every request carries `Authorization: Bearer <token>`, the server asks
Supabase to verify it, and the user is the `sub` that comes back. A request
without a valid token is refused with **401** — never served an empty result,
because "you are not signed in" and "you have nothing planned" are different
facts and a screen that confuses them shows a blank day to someone whose session
merely expired.

**Two clients, and which one a piece of code holds is the security model.**

| | |
|---|---|
| `forUser(token)` | anon key under the caller's token, so PostgREST runs as `authenticated` and row level security applies. Every route. |
| `service` | bypasses row level security. The scheduler and the command line tools only — they act for every user at once and have no caller to be. |

The anon key rather than the service key under that token is the deliberate
part. Both work on the happy path; they differ in how they fail. With no token
an anon-key client falls back to the `anon` role, which no policy grants
anything to. A service-key client falls back to `service_role`, which is every
row in the database.

**That separation is enforced twice, because neither way is sufficient alone:**

- `tests/service-key-check.js` walks the import graph from `routes/` and fails
  if anything reachable takes the `service` export. It names the file, before
  anything runs.
- `db.js` wraps the service client so that `from()` and `rpc()` throw if called
  inside a request. `server.js` opens an `AsyncLocalStorage` scope around every
  request; the scheduler runs on a timer, outside it. This catches what reading
  imports cannot see — a require built at runtime, a helper that grew a second
  caller.

Reading imports is a claim about the shape of the code. The scope check is a
fact about the process. `server.js` genuinely reaches the service key, because
it requires `./scheduler` to start cron in the same process — which is exactly
why the static check alone was never going to be enough.

**Row level security is on for `profile`, `entries`, `plans`, `blocks` and
`sent_log`**, one policy each: `user_id = auth.uid()` in both `using` and
`with check`, covering select, insert, update and delete. `using` decides what
you can see and therefore change; `with check` decides what a row may look like
afterwards, which is what stops a caller handing one of their rows to somebody
else. See `migration-rls.sql`.

The routes still filter on `user_id` as well. That duplication is deliberate:
the filter is what the code means, the policy is what the database enforces, and
neither is a reason to drop the other.

---

## 3. The screen

### 3.0 Before it has loaded

A cover in the page's own background with **a quarter of a circle's outline,
turning**, until the first day is on screen.

Without it you land on the static markup — the switch with no date, `Day ends —`,
an empty builder and an empty list. That is the real screen with every value
missing, which reads as a day that has nothing in it rather than a day that has
not arrived, and then it pops into place. Covering it is honest about the wait
instead of showing a wrong answer during it.

**An arc, not a full ring.** The circle is transparent on three sides, so what
shows is genuinely a fraction rather than a whole ring with one bright quarter —
a ring reads as a shape, and this has to read as motion. **Faint, not the
accent:** blue is actionable and there is nothing to act on yet. **No word:**
*Loading…* is the kind of sentence this system spends its whole design not
saying.

Under `prefers-reduced-motion` it **closes into the whole outline** rather than
freezing mid-turn. A quarter arc held still reads as something half-drawn;
stillness is the setting, not a lesser version of it.

It lifts when the load **settles**, not when it succeeds. A failed load leaves an
empty page, which is a poor screen — but a cover that never lifts is a worse one,
because it claims something is still coming. It then leaves the layout rather
than fading to invisible and staying: a fixed, full-screen element over the app
is inert only while it keeps `pointer-events: none`.

**The same mark appears in the day section when the switch is fetching**, and it
is declared once for both — two copies of a turning arc would drift the first
time either was adjusted. Tapping Tomorrow left today's blocks on screen,
under the word Tomorrow, until two requests came back; on a phone that is long
enough to read the wrong day and believe it. The **end time goes back to `—`**
with them, because it is computed from the blocks and would otherwise be the one
number on screen still confidently wrong.

The calendar aside is left alone through the switch. It is the only part that
visibly reloads on its own, and blanking it made the section flicker twice.

**The day is first, Things second.** Things led while this was a page you read
*before* you planned: the cold list argued for what tomorrow should hold, and the
builder was where you answered it. Once a day is confirmed that reverses — the
answer is what you open the page to see, and the list is where you go when you
want to add to it. Scrolling past the whole list to check what is next is a toll
paid every time to save one that was paid once.

The two sections are written up below in the order they were built, which is no
longer the order they appear in. The screen is the authority; this is a document.

### 3.1 Things

Habits, projects and tasks in **one list**. A task left three weeks is the same
problem as a project left three weeks, so they share a list rather than being
filed apart.

**Two halves: what is running out of room, then what has gone cold.**

Anything carrying a mark sits above everything without one, ordered by the least
room left — so an overdue thing beats a thing due Friday, and both beat a habit
nobody has done in a fortnight. Below the marks the rule is unchanged: longest
untouched first, across all three types.

The break between the halves is the mark itself, **not a blended score**. A
single number mixing "days since" with "days of room" would be a judgement this
system has no standing to make: it is never told when work happens, only that
something was scheduled. Two orders and one plain rule about which wins can be
read off the screen; a score cannot.

Within the marks the order uses **slack** — days until due, less the days the
size stands for — rather than the mark. `!!!` covers everything from
just-out-of-room to a month overdue, and those are not the same day. `slack` is
computed in `warning.js` and the mark is derived from it, so the badge and the
position can never disagree. It is not sent to the client: the screen shows the
mark, and a number nothing renders is a field to keep in step for no one.

All of it is still arithmetic on what the person declared. There is no ranking
and no drag, and `entries.sort_order` is retired — written by nothing, read by
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

#### Done and Delete offer an undo, and write nothing until it lapses

Both take the row off the list at once and show **Done · Undo** or
**Deleted · Undo** for six seconds, the same bar the block swipes use. **Delete
no longer asks first** — the undo replaces the confirm, and is the better of the
two for the same reason it is on the swipes: a confirm interrupts every delete to
catch the rare wrong one, the undo interrupts none of them and still catches it.

**The write waits for the window to close.** This is forced rather than chosen.
`status = 'deleted'` is a tombstone (§2.2) and `update_entry` refuses to revive
one as anything, so there is no request that reverses a Delete — the only way for
undo to restore *the same row* is for nothing to have happened to it yet. Undo
does not reverse the write; it cancels it.

Done goes the same way even though `done` → `active` would in fact be allowed.
One mechanism, because two would differ only in ways nobody could see, and an
invisible difference is the kind that rots.

Three consequences, all of them deliberate:

- **A second action commits the first.** Deleting two things in a row deletes
  both; the bar can only ever describe one of them.
- **Leaving the page commits.** A `pagehide` listener settles the offer, with
  `keepalive` on the request so it survives the page going away. Without it,
  deleting something and closing the tab would leave the row on the list.
- **For six seconds the screen and the database disagree.** A reload inside the
  window brings the row back. That is the price of the undo restoring the same
  row rather than a new one.

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

**It opens on Today through the day, and on Tomorrow from `profile.nudge_hour`
(default 20:00).** Almost every visit is a glance at what is on now and what is
next, which is why it lands on today. But by the nudge hour today is spent, and
the question worth opening the page for has become tomorrow — which is exactly
what the nudge is about to ask.

The hour is **read from the profile rather than written on the page**, because it
is the same idea in both places: the moment this system stops being about the day
you are in. A constant in the client would be a copy of `nudge_hour` waiting to
be forgotten when the setting moves. `GET /entries` returns it for that reason
alone.

Past midnight is a new today, not a late yesterday — the comparison is against
the local wall clock, so 00:30 opens on the day it is.

**Who you are does not decide this; what time it is does.** It used to follow
`profile.plans_in`, so an evening planner landed on Tomorrow at eleven in the
morning. `plans_in` now decides only **which day the evening nudge asks about**
(§4.2). There is still no settings UI for either column; both are set by hand.

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
- A **divider** marks where the past ends: a dot and a hairline, **and no word**.
  It is drawn once, above the first block that **has not ended** — so everything
  above it has happened, and everything below is happening or still to come. Not
  drawn at all on a day entirely behind or entirely ahead, where it would be
  marking the end of the list rather than a place in the day.

  It carried a word twice and has lost it twice over. **NOW** named the moment
  and was true wherever the line fell. **Next** was a claim about the block
  directly underneath, which forced the line *below* the running block — a block
  you are in the middle of is not the next one. Removing the word removes the
  claim, and the line goes back to the division that was wanted: past above,
  present and future below.

  The lesson is worth keeping. A caption on a line across a day has to be about
  one side of it, and whichever side it names, it is wrong for something. The
  blocks either side already say which they are — a past block is an outline, a
  running one says *active* — so the line does not need to say it for them.
- The **Starts control is hidden.** The day has already started, so there is
  nothing to decide about when it does.

**A day with nothing in it still takes a day's worth of room.** The builder holds
one block's height open, so **Starts** does not sit against **+ Block** — an
empty day should read as a day with space in it, not as a broken control.

It is a **real block card, hidden**, rather than a `min-height`. That number
would have to be kept true against the card's padding, its two line heights and
the gap below it, and would go wrong the first time any of those changed —
silently, because nothing would fail. Built from the same parts it cannot drift.
`visibility: hidden`, never `display: none`, because keeping the space is the
entire purpose. `aria-hidden`, because it says nothing worth reading aloud.

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

**Nothing is auto-placed, nothing is pinned, nothing is stored.** There were two
feeds meaning different things — one things to know, the other things to do —
and the second fed all-day events into the day as blocks that had to be argued
with if you did not want them. Both the second feed and the placing are gone.
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
- **Confirm** saves the plan. Any edit afterwards un-saves it. It stays visibly
  pressed from the tap until the save answers — the round trip takes about a
  second, and a seal that says nothing for that long reads as a tap that
  missed.

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
and offers **Removed · Undo** for six seconds.

**The block goes at once and the day closes over it**, 180ms. It used to splice
and re-render in the same breath, which destroyed the row outright — everything
below jumped a block's height with nothing connecting where they had been to
where they now were. The card is not animated out; what moves is the gap
shutting, which is the part that used to jump.

Three things this needs, each of which fails silently without the others: the
row's height is **measured and pinned** before it is animated to zero, because a
transition out of `auto` does nothing at all; a **read of `offsetHeight`** sits
between the two so the first value takes rather than both landing in one frame;
and the removal runs off a **timer, not `transitionend`**, because a row already
at zero height fires no transition and the callback would never arrive.

The block is then found **by identity, not by the index it had** — that index is
a frame old by the time the gap has closed, and anything reordered or removed in
between would make it point at a different block.

Removal by tapping a greyed thing goes through the same path and closes the same
way. Under `prefers-reduced-motion` the block goes on release with nothing to
watch. That is a better trade than a
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

**The gap opens against the slots, not against the builder's children.** The
divider is a child of the builder too, and the empty-day spacer is another,
while the drag indexes into `blocks`. Reading every child made the two disagree
by one from the divider down — the gap opened in the wrong place, the divider
was shifted instead of a block, and blocks were pushed onto each other, so the
list appeared to collapse together and then landed correctly. Only the animation
was reading the wrong index.

**The pitch between blocks is measured, not assumed.** It used to be the slot's
height plus a hardcoded gap, and when the theme changed that gap the constant
stayed behind — three pixels of drift per position carried.

**It cannot be carried above the divider.** The drop target's floor is the far
side of the last block that has begun, so a block still to come cannot be
dropped into the part of the day that already happened.

That floor used to be index 0, and the damage went past the screen telling a
lie. `reflow` holds a begun block at its **stored** hour and flows everything
else from the next half hour — so a block dropped at the top took, say, 10:30 AM
while the finished block beneath it kept 8:00 AM. **The day rendered backwards**,
two blocks collided on the same hour, and the divider went looking for an edge
that was no longer there.

The floor is found by scanning for the last begun block rather than assuming the
begun ones come first. They always do in a day this app built — but this is the
guard against an order being wrong, so it cannot lean on the order being right.

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
today's confirmed plan are due and not yet sent. A block more than 30 minutes
late is marked sent without being sent and logged under `[EXPIRED]`, because
"Gym, 08:00" arriving at 14:00 is worse than nothing.

**A message goes out 15 minutes before its block starts.** It used to arrive as
the block began, which is already late — you find out you should be doing
something as the time to start doing it passes. Fifteen minutes is one tick of
the loop, so a block's message lands on the tick before it: the same arithmetic,
one step earlier.

**The message itself is unchanged.** It names the block's own hours, so a
heads-up at 08:45 still reads `9:00 AM to 10:00 AM`. That is what makes it a
warning rather than a correction, and it is why nothing about the composition had
to move.

Only the moment of sending is early. `late` is still measured against the block's
own start, so the 30-minute expiry and the `[EXPIRED]` line keep meaning exactly
what they say.

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
| `entry-shape.js` | what a habit, project or task may be |
| `routes/settings.js` | the setup screen: linking Telegram and the calendar |
| `calendar-test.js`, `send-test.js` | run by hand, not part of the running system |
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
| `SUPABASE_URL` | the project |
| `SUPABASE_ANON_KEY` | **required.** Every route builds its client from this key plus the caller's token, so row level security applies. Also served to the browser by `GET /config` |
| `SUPABASE_SERVICE_KEY` | bypasses row level security. **Only the scheduler and the command line tools may hold it** |
| `TELEGRAM_BOT_TOKEN` | outbound only. One bot for everyone; only the chat id is per person, on `profile` |
| `TELEGRAM_API_BASE` | *optional.* Where the API lives. Only the suite sets it, so a test run cannot make a real phone buzz |
| `ANTHROPIC_API_KEY` | the brain. **Nothing calls it.** Kept so the wiring stays live. Read by the SDK, not by any file here, so grepping the repo for it finds nothing |
| `PORT` | assigned by the host |
| `SCHEDULER_DISABLED` | *optional.* `1` loads the scheduler without starting cron |

`PI_USER_ID` is gone. The server serves whoever the request's token says, and
there is no default user to fall back to — see 6.1.

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
| `profile.nudge_hour` | the evening nudge hour, 0–23, and the hour the screen starts opening on Tomorrow. Null means 20 |
| `profile.plans_in` | `morning` or `evening`. Which day the evening nudge asks about. It no longer decides which day the app opens on — that is always today. Null means evening |

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
  the **dot of the divider**, which no press acts on and which says *here is
  where you are*. That is the whole list, enforced by name in the layout check;
  nothing decorative is ever blue.

  The exception used to be two selectors, the dot and the word beside it. The
  word is gone, so it is one.

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

Sequential on purpose: they share two test accounts, and two of them writing the
same rows at once would fail for a reason that has nothing to do with the code
under test.

`run-all.js` **refuses to start** if any suite could reach somebody's real rows.
It reads each file and computes whether the app modules it imports can see the
database, rather than trusting a hand-kept list of dangerous files. A suite that
writes must import `harness.js`; so must one that drives a server, since without
the harness it holds no token and would test an account it cannot reach. And no
suite may name a uuid that could belong to a real account — only the
`00000000-0000-0000-0000-` prefix is allowed, which is what this codebase uses
for ids that stand for nobody.

**Two real accounts.** `harness.js` creates `pi-suite-a@example.test` and
`pi-suite-b@example.test` through the admin API with `email_confirm` set, signs
into both, and holds their tokens. Their ids are discovered at runtime and
written down nowhere — a route derives the user from a verified token now, and
no token can be minted for a uuid that is not an auth user, so the old fixed id
could not have worked.

`harness.js` still hands out a database client that is physically unable to
write to anyone but those two: an insert without one of their ids in the
payload, or an update or delete without one in the filter, throws before it
reaches the network. That client is still the **service** client underneath —
setup and teardown have to reach across both accounts — which is precisely why
the guard is still there. Row level security will not stop it. This exists
because scoping by hand failed once, destructively.

**The two suites this is all for:**

- `isolation-accounts-test.js` — A cannot read, change or remove anything of
  B's, on every table, through the routes *and* through the database directly.
  Every write attempt is followed by a service-key read of the row it was aimed
  at, because "the update returned no rows" is not the same claim as "the row is
  unchanged". Every "A sees nothing" check is paired with a "B sees their own"
  check, or it would pass just as well against an empty table.
- `auth-test.js` — no token, malformed tokens, the project's own anon key, and a
  real token for an account deleted out from under it, against every route. Plus
  a control that a valid token still works, or a server that had fallen over
  would pass every other check in the file.

Suites are **deleted rather than skipped** when the thing they covered is
removed. A suite that cannot run still reads as coverage, which is worse than
having no file there at all.

No suite calls a model, because nothing in this system does.
