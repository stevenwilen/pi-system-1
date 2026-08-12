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

**Not habits.** A habit recurring is the whole point of a habit, so it has no end
to reach; offering Done on one would be offering to retire something that cannot
be over.

Projects can be finished. They were refused for a while on the grounds that a
project is not finished by one session of work on it — a good reason not to
*infer* an ending from a ticked block, and no reason to refuse one stated
outright. A project is the only type carrying a due date and a size, so it is
the entry most likely to genuinely end, and while it was refused the only ways
off the list were Delete and Later: one records it as a row that should not have
existed, the other as something you still mean to get to.

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
header, and none of it needs SQL: the Telegram chat, the calendar, the
timezone, and Sign out.

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

The way out therefore **closes** this screen, and is never a word for having
been sent to it — not *Skip*, not *Done*, neither of which is true of a page
nobody was sent to. It was a back chevron on the left for a revision; a chevron
is a claim about where you go, and this is a page laid over the day rather than
a place further into it, so an × at the top right is the truer word. `openSettings` takes no argument, which is the
structural half of the same rule: a parameter saying which kind of visit this is
would be a way to be sent.

It is a **glyph alone**; a word beside it was doing no work the shape does not
already do. It carries `aria-label="Close"`, and that is not decoration:
stripped to one character the button is punctuation, and a screen reader
announces *"multiplication sign"* or nothing at all. The label is the entire
accessible name, so the layout check pins it — losing it turns the only way out
into an unnamed control.

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

**Start this bot before pasting an id, and the steps say so.** A Telegram bot
may not message anyone who has not pressed Start on it. The id comes from
`@userinfobot`, which is a **different bot**, so starting that one grants
nothing here — and this step was missing. Following the instructions exactly
saved the chat id and returned `Bad Request: chat not found`, a sentence that
reads as *your number is wrong* and gave no reason to suspect the real cause.
It reached the second person who ever used the app.

The bot's name is **asked of Telegram** — `getMe`, once per process, memoised —
rather than configured. A `TELEGRAM_BOT_USERNAME` in the environment is one more
thing to set wrongly, and a name disagreeing with the token would send someone
to press Start on the wrong bot, which is precisely the failure this prevents.
When Telegram cannot be reached the screen says "the planner's bot", because a
setup page that will not load because Telegram is down is worse than a vague one.

**A failed send says what to do, and keeps Telegram's words too.** `fixFor`
translates the three failures anyone can act on — not started, blocked,
deactivated — into an instruction naming the bot, and returns null for anything
else, because a guess about an unknown failure is worse than the exact words.
The screen shows the instruction first and `(Telegram said: …)` after it.
The raw `error` is unchanged in the response: it is what you want in a log, and
what the suites assert on.

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

#### Timezone

The third row, and one line: the name on the left, the zone on the right, and
pressing it opens the phone's own picker. **It fails the way the other two do —
silently — which is why the value sits on the row rather than behind it.** A
wrong timezone does not look wrong; every block message and the evening nudge
fire off it, and the date rolls over at the wrong hour.

**A timezone is the one setting here that cannot report itself.** A chat id can
be messaged and a feed can be fetched, and the answer comes back in a second.
There is nothing to ask about a zone: it is either where you are or it is not,
and only the person can say. What it *can* do is be obviously wrong at a glance,
so it is shown rather than hidden.

**The row is the control.** A `<label>` with an invisible `<select>` laid over
it, so pressing anywhere on the row is pressing the select and what opens is the
operating system's wheel rather than four hundred rows drawn inside a page.
`opacity: 0` rather than `display: none` or `visibility: hidden`: both of those
take it out of the hit test as well as out of sight, leaving a row that looks
pressable and is not.

**The list is built, not shipped.** `Intl.supportedValuesOf('timeZone')` is the
tzdb the browser already carries, so it cannot go stale against the runtime that
has to accept it. The stored zone and the device's own are put in front of it
when the list lacks them — `UTC` is the case that matters, a real answer that
`supportedValuesOf` omits, and without it the select would open on whatever
sorts first and show a zone nobody chose. It is also the floor under a runtime
with no `supportedValuesOf` at all, which would otherwise leave a picker holding
one option: a dead control wearing the clothes of a live one.

**It was a panel**, and the panel is gone: a stepper for the hour a day starts,
a dropdown, a live clock reading *It is 4:12 PM there now*, and two paragraphs
explaining them. That is a lot of screen for a value set once and afterwards only
ever read — and now that the default is somewhere real (§6), the common case is
that it is already right and wants only to be confirmed by reading it.

What went with it:

- **The hour a day starts.** `profile.default_wake_time` is unwritable from the
  app again. `POST /settings/wake` and its tests remain, so it is one markup
  block to bring back. It matters less than it sounds: the builder's **Starts**
  control still sets the hour for any particular day, and confirming writes
  `plans.wake_time`. The profile default only decides where a day with no plan
  yet begins.
- **The one-tap offer.** `Use America/New_York?`, shown when the device
  disagreed with what was stored. The row opens the picker now, so a button
  suggesting a single value was a second way to do the same thing in more space.
  The device's zone is still guaranteed to be *in* the list, which is what is
  left of it.

**Changing the zone rebuilds the day underneath.** Which date is today, which
blocks have begun, and what "tomorrow" means are all read off it. The cost is
named rather than hidden: `showDay` drops anything unconfirmed, so a day half
built at the moment somebody changes their timezone is lost. A half-built day
dated in a zone you have just said you are not in is not worth keeping.

The write upserts and names **only its own column**, so it cannot disturb a chat
id or a calendar. A refusal puts the row back to what is stored — barely
reachable, since every option came out of the browser's own tzdb, but a row
showing a value the server would not take is a screen disagreeing with the
database and saying nothing about it.

#### How the month has gone

The last thing on the setup screen, and read-only.

**The headline is how much of the month was planned at all**, because everything
under it depends on that: *"5 days planned in the last 30."* It leads rather than
sitting in a footnote.

**Under about ten days it says so and shows nothing else.** Five days out of
thirty is not a habit slipping, it is a month barely planned, and ranking
anything off it would be dressing a sample of five up as a verdict.

Above that, one line per habit: **how long since you got to it, and the cadence
it was meant to keep.**

```
12 days planned in the last 30. How long since you got to each habit,
against how often you meant to.

  Call home        not in 30 days, meant to be weekly
  Abs              11 days, meant to be few times a week
  Reading          2 days, meant to be daily
```

**Sorted by how far past its own cadence each one is**, worst first — days late,
not a ratio. That is the only figure here that puts a daily habit and a monthly
one on the same scale.

**Two false starts, and both failed the same way**: they presented thin data as
though it were a trend.

- **Hours** — minutes per habit, project and task. It stopped describing the app
  the day untimed items arrived, because a thing committed to a day without an
  hour adds nothing to a total made of minutes.
- **Ratios** — `scheduled / expected`, with a bar. Every row had a *different
  denominator*: `0/1`, `2/7`, `2/3`. A column like that cannot be read down —
  the eye has nothing to rest on and every figure has to be worked out alone.

**No bars.** A bar is a comparison, and one can only be drawn once every row
means the same thing by its length. These do not.

Two things also went, for the same reason — not legible, or not worth knowing:

- **Most days given to.** At this sample size every count was 1 or 2, which is
  noise; and it was a weaker version of a time-versus-priority review that would
  need real data to mean anything.
- **The inventory line** — *"4 habits · 8 projects · 4 tasks"*. Visible by
  scrolling the list.

**Got to, never did.** The system is never told that anything happened — an
untimed item ticked off is the single exception. It knows something was scheduled
and left in a confirmed day, and an untimed item counts exactly when staleness
says it does: `completed`, ticked rather than merely present (§3.2). The same
filter, deliberately — two screens disagreeing about whether you got to something
would be worse than either being wrong.

**Never measured against a month it was not alive for.** A habit added five days
ago and never scheduled reports five days, not thirty. Otherwise the first thing
a new habit says about itself is a failure nobody was given the chance to commit.
One never got to *at all* inside the window says **"not in 30 days"** rather than
a number — that figure is a floor, not a measurement, and reads as one.

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

**And it lifts after `BOOT_PATIENCE` (2.5s) whatever the load is doing**, which
is the same argument carried one step further. Settling covers a load that fails;
it does not cover one that never settles at all, and that is not exotic on a
phone — an app woken by a refresh can have its network held until the next
interaction, and until then every fetch simply hangs. The cover stayed up for as
long as that lasted, which is a blank screen that comes back when you touch it.
That was a real report, not a hypothetical.

Nothing is cancelled when the deadline passes: the boot keeps running and the day
draws over whatever is on screen when it arrives. And what shows underneath says
what it is — **the day carries the waiting mark** rather than reading as an empty
day, or **the gate** if this person is not signed in, decided from the session
the same way `start()` decides it. Lifting onto a finished-looking empty app
would trade one wrong screen for another.

The deadline is a deadline for the **cover**, not for the network: long enough
that nobody on a slow connection watches it lift onto a half-drawn page, short
enough that a boot which is never going to finish stops looking like one that is
about to.

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

**Pinned first, then two halves: what is running out of room, then what has
gone cold.**

**A pin is the one thing here ordered by hand**, and it sits above everything —
including a deadline that has run out. That cost is real and deliberate:
something genuinely overdue can be pushed below a pinned habit, and the screen
does not argue about it.

It is **not** the ranking this list retired, though it revives the column that
ranking used. What was refused was a *score* — one number blending "days since"
with "days of room" — which cannot be read off a screen and which the system has
no standing to compute. A pin blends nothing. It is a fact the person stated,
and §2.1 is that nothing is inferred which can be declared: the arithmetic
*guesses* at what needs attention, and a pin is someone saying it outright.

Pins are ordered among themselves by the same arithmetic as everything else, so
the top of the list is not a second list with its own rules.

**One list, with a mark on the row.** A pinned thing carries a small pushpin out
at the right edge, immediately before the deadline asterisks, so the two read as
one cluster of marks about the row.

It sat inside the title for a revision, on the reasoning that a pin is a fact
about the name. In practice it read as part of the name, and it moved along the
line as titles changed length — everything after the name is a mark about the
row, and the pin is one of those.

It is **drawn, not typed**. A pushpin character would fall back to whatever font
on the device happens to carry it, which is exactly how the deadline asterisks
came out bold on a laptop and thin on the phone (§3.1.1). An inline svg has no
font to be missing from.

**Stroked and tilted, not filled**, and that is most of why it is quiet: a solid
shape at this size is a blob carrying as much ink as the note dot beside it,
while a 2px stroke in a 24 viewBox renders under a pixel wide. The turn is
inside the svg, so the element stays square and nothing needs rotating in CSS.

It is applied as a **mask, not a background image**, so the colour stays in CSS:
what shows through is `background-color`, so the mark follows the palette
instead of baking a hex into the url and drifting the next time it moves. Set in
`--faint` rather than `--muted` — it marks a row rather than asking anything of
you, and it sits inside a title it must not compete with.

It was a teardrop made of a border-radius for two revisions — filled, which read
as a blob, then hollow, which was lighter but still a map marker rather than a
pin.

It was a **Pinned** heading with a gap after it for one revision. That splits a
short list into two shorter ones, and what a pin needs to say fits on the row.

`entries.priority` is the column: `1` or null, set by `POST /entries/:id/pin`.
It was *"a way of ordering this list by hand"*, retired when the order became
arithmetic and — like every column here — never dropped. Every row still held
null, so there was no stale value to collide with and **no migration to run**.
The second column to come back this way, after `completed` for untimed items;
`paused_at` was the third, for saved-for-later (§4.4).

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
length stands for — rather than the mark. `!!!` covers everything from
just-out-of-room to a month overdue, and those are not the same day. `slack` is
computed in `warning.js` and the mark is derived from it, so the badge and the
position can never disagree. It is not sent to the client: the screen shows the
mark, and a number nothing renders is a field to keep in step for no one.

Below the pins it is all arithmetic on what the person declared. There is no
drag and no score, and `entries.sort_order` stays retired — written by nothing,
read by nothing, kept only because dropping a column cannot be undone. The pin
uses `priority`, which was the other retired ordering column; `sort_order` was
left alone because eleven rows still hold values from when it was live, and a
feature built on stale data is a feature that behaves differently for whoever
was there first.

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
(tasks only) and **Edit**. Tapping the row while a menu is open closes the menu
rather than scheduling — tapping away from something you opened should undo the
opening, not commit to something.

The hint is faint rather than muted. It repeats down the whole list, and at
muted it would draw a second column of emphasis competing with the titles.

This was a long press with nothing on screen to suggest it, which meant three
actions reachable only by already knowing they were there — and one of those
three, Edit, had no route into it at all: the update endpoint existed and
nothing on the page ever called it.

**Delete left the menu.** It is a swipe now, and the menu holds only what has no
gesture. Two routes to the same irreversible write, two paces apart, one of them
reachable by a finger that only meant to open the menu, was one route too many.

#### A row is worked by gesture, like a block

Left removes, right writes a note — **the same two directions the blocks use**,
because they are the same two questions asked of a different kind of row. A list
where left meant one thing here and another there would be a list you had to
remember rather than read.

Both reveal a backing under the travelling row, with the word on the edge the
finger is heading for, fading in with the distance so the action is readable
**before** the release. The row itself is opaque in the page colour and the
hairline divider hangs on the slot rather than the row, so the list holds still
while one row slides.

**The backing here is the word alone — no paper under it.** A block swipe
uncovers another slip, torn like the one that covers it, because a block *is* a
slip and something has to be underneath one. A Things row is not laid on the
page, it is part of the page, so what shows when it slides aside is the page.
The torn sheet read as a second object appearing from nowhere.

The commit distance is the same 72px the blocks use: most of a thumb's travel, so
neither gesture is reachable by a hand that was doing something else.

**Delete asks; the block swipe does not.** The row turns into `Delete [title]?`
with **Cancel** and **Delete**, and only Delete writes. This is the one place
this system asks first, and the asymmetry is the point:

- A block is one day. Taking one out is how you record that something did not
  happen, and it is written back the moment you confirm; the six-second undo
  catches the rare wrong one and interrupts none of the right ones.
- A thing may be weeks of history. Every block that ever carried its id stops
  being attributable to anything, and `status = 'deleted'` is a tombstone (§2.2)
  that `update_entry` refuses to revive — so there is no undo that could put the
  *same* row back an hour later. The doubt has to be raised before the write.

**On a task there is a third answer: Done** — `Cancel · Done · Delete`. Swiping
a task away is usually a way of saying *I did this*, and Delete is the wrong word
for that. Done and deleted mean opposite things (§2.3) — one is work that
happened, the other a row that should not have existed — and **both take it off
the list**, so the difference is invisible at the moment you choose and permanent
afterwards. Offering it here is what makes getting it right cost nothing.

Done from the question behaves exactly as Done in the menu does, undo and all.
That the two buttons beside each other behave differently is the existing rule
rather than an inconsistency: Delete cannot be taken back, so it asks first;
Done can, so it uses the six seconds instead.

**Tasks only.** A habit recurring is the point of a habit and a project is not
finished by one session — the server refuses both, so the button would be
offering a refusal. A habit or a project still gets `Cancel · Delete`.

Cancel comes first and Delete is last and in the warn colour, for the reason the
menu ordered it that way: the destructive one does not sit where the finger
arrives by default, and after a leftward swipe what the finger lands on is the
way out.

The removing backing wears the warn colour and a block's does not. That is
deliberate and it is the only place the two swipes are unalike: colour on a
gesture that carries an undo would be shouting about something already caught.

There is **no undo on a delete** — the question was the window. An offer to undo
something just confirmed would be the same doubt raised on both sides of one
write.

#### Done offers an undo, and writes nothing until it lapses

Done takes the row off the list at once and shows **Done · Undo** for six
seconds, the same bar the block swipes use.

**The write waits for the window to close.** `done` → `active` would in fact be
allowed by the server, so this one could have been written the other way round.
It is not, because the row that comes back has to be *the same row* and not a new
one carrying a new id — and because the mechanism was already there.

Three consequences, all of them deliberate:

- **A second action commits the first.** Finishing one thing and then deleting
  another writes both; the bar can only ever describe one of them.
- **Leaving the page commits.** A `pagehide` listener settles the offer, with
  `keepalive` on the request so it survives the page going away. Without it,
  finishing something and closing the tab would leave the row on the list.
- **For six seconds the screen and the database disagree.** A reload inside the
  window brings the row back. That is the price of the undo restoring the same
  row rather than a new one.

#### The note on a thing

Swiping a row right opens a plain input: one line, capitalised by sentence,
spellcheck on, autocomplete and autocorrect off. It is meant to be **dictated at
the list**, and a field that guesses at the next word is in the way of someone
talking at it. Leaving the field saves it; Enter saves it; clearing it removes it
— empty is not a note.

**It is not the note on a block, and the difference is the whole design.**
`blocks.note` says what you are doing in that session: "finish the pricing page"
is true of Tuesday morning and not of the project (§3.2). `entries.note` says
what to remember **when you next schedule this** — and it is spent once
delivered.

**Scheduling moves it.** Confirming a day writes the note onto the first new
block for that thing and sets `entries.note` back to null. A note that stayed
would be read again on every future scheduling, which is how a sentence about one
morning becomes a standing instruction nobody meant to give.

Four rules follow from that, and each one is a case in `note-test.js`:

- **The confirm spends it, not the tap.** A block does not exist until `POST
  /plan`, so a person who taps a row and then changes their mind has not spent
  anything. The move is decided on the server for the same reason.
- **New blocks only, and the first one per thing.** Scheduling something twice in
  a day is two sessions of the same work, not the same message twice. A block
  that already exists was given its note by whichever confirm created it.
- **A block's own words win.** If the first new block already carries a note, the
  thing keeps its own, undelivered, and nothing is overwritten. Someone who wrote
  on the block has said something more recent about that session; the message on
  the thing is still waiting for a scheduling with room for it.
- **One ceiling, 500 characters, shared with `blocks.note` in `entry-shape.js`.**
  The text moves between them, so two ceilings would let the confirm refuse what
  the field that wrote it accepted — and the refusal would land on the day rather
  than on the field.

**The list never shows the words.** A row with a note carries a small muted dot
and nothing else. The list must not get longer: a second line of prose on every
row that has one turns a list you scan into a page you read, and the note is
addressed to the person about to schedule this rather than to the person
scanning. Swiping right again is how it is read, and how it is edited.

The dot is muted rather than either ink. Something waiting is not something
wrong, so not persimmon; there is nothing to press on it, so not indigo.

The note reaches an entry through `POST /entries/:id/note` and **no other
route**. `/update` re-validates the whole row — title, due date, and the length
that has to accompany it — and a note has no rules to break beyond its ceiling;
sending it through there would mean a note could be refused for something on the
far side of the row. `note` is in `UPDATABLE` and deliberately not in
`CREATABLE`: nothing writes one at the moment a thing is added, because there is
no such thing to say about a row that does not exist yet.

`POST /plan` answers with `notes`, an array parallel to `ids` holding the text of
each note it moved and null everywhere else. That is what lets both ends of the
move show without a reload — the block gains its line, the row loses its dot.

#### Adding and editing

`+ Add` opens a sheet. **Edit** opens the same sheet with the row's values in
it, saving to `POST /entries/:id/update` instead of `POST /entries`.

One sheet, not two. The fields and the rules between them are identical either
way, and two copies of the form would be two places for the date-and-length rule
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
| length | projects and tasks | **only when a due date is set**. The column is `size` |

The buckets are `a day`, `a few days`, `a week`, `a few weeks`, `months`.

**The field is labelled Length; the column is still `size`.** *Size* reads as
how big a thing is, and what the field asks is how long it will take — which is
the only reading the warning mark has ever used: days needed against days left.
Every bucket is a span of time, so the old label was arguing with its own
options. The column keeps its name because renaming one is churn nobody can see,
and this codebase has never renamed or dropped a column.

The date and the length travel together, in both directions. A due date with no
length cannot produce a warning mark, and on screen that looks exactly like a
comfortable deadline. A length with no date has nothing to be measured against.
Clearing the date clears the length with it.

There is no why, no note about where something stands, and no free-text length.

#### Already in the day

A thing that already has a block in the day on screen is **greyed**, and that is
the whole signal. No badge beside it: it said *in today's plan* for a while,
which was a second way of saying what the colour already said.

Its **warning mark is held back** too. The mark asks "does this need your
attention" and being scheduled answers it, so a greyed row still shouting a
deadline would be arguing with itself.

**Tapping it adds another one.** A tap means the same thing on every row, grey
or not: put this in the day. So a thing can be scheduled twice, which is an
ordinary way to plan — two sessions of one project in a day is not a mistake to
be prevented.

It used to take the thing back **out** when the row was grey. That is the rule
this replaced, and it was wrong twice over: one gesture meant opposite things
depending on a state you had to read the colour to know, and it made scheduling
the same thing twice impossible. The greying is information, not a mode.

**Removal belongs to the block.** Swipe it left in the day, where the thing you
are pointing at is the thing being removed, and it keeps the six-second undo. A
row could only ever guess which of several blocks you meant — it took the last —
and a block cannot.

The `···` menu is unaffected throughout: edit, done and anytime all work.

Read off the blocks the builder is holding rather than anything stored, so
removing its block frees the row on the same render, and so the answer follows
the switch: a thing in tomorrow is not greyed while you are looking at today.

#### 3.1.1 Warning marks

Arithmetic, and only arithmetic (`warning.js`).

```
length → days needed
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
reported. It changes when the person changes the date or the length, and when the
calendar advances. Nothing else moves it.

**No mark means "nothing to say", never "fine."** A row with no due date, no
length, or an unrecognised length shows nothing.

**Set as marginal asterisks, bold, in persimmon.** The server still computes
`!!!`, `!!` or `!` and the count still carries the whole meaning; the page draws
`✱` that many times, the way a reader marks a page they mean to come back to.

Marks sit at the meta line's size — 12px — because they belong in the margin
rather than in the text, and at that size the colour alone was doing all the
work. Weight is what makes three of them read as louder than one without making
them bigger.

**It is a stroke, not a `font-weight`, and that is not a stylistic choice.**
`✱` is U+2731, in the Dingbats block, and **no font in `--face` contains it** —
every platform falls back for this one character, and the fonts it falls back to
(Apple Symbols, Segoe UI Symbol) ship a single weight. `font-weight: 700`
therefore asks the browser to *synthesise* a bold that does not exist. Chrome
does; **iOS Safari does not**. So it rendered bold on a laptop and thin on the
phone, which is the screen this is actually read on.

`-webkit-text-stroke` is painted on the glyph's own outline and needs no bold
face to exist, so both render alike. The `font-weight` is *removed* rather than
kept beside it: left in, the laptop would get a synthetic bold **and** the
stroke and end up heavier than the phone — the same mismatch, mirrored.

`mockup.html` carries the same glyph and the same stroke. It was still showing
`!!!` in a lighter face, two changes behind — a second answer to what this should
look like, and the wrong one.

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

Everything on the feed for that date. Each event is one row: its time, then its
title, and nothing else. Timed first in clock order, then the all-day entries,
which show no time.

**The whole row is the target, which in practice means the title** — it takes
whatever the fixed-width time column leaves, and 7px above and below carries it
to 35px tall. Not the 44 a guideline asks for: that would nearly double the
height of an aside read far more often than it is pressed. It was 29. It carried a muted `+` at the edge
for one revision. A mark on every row to describe a gesture is a toll paid on
every reading of the list to explain something once, and this aside is read far
more often than it is pressed.

**Pressing a row makes a block.** That is the person deciding, which is the
whole distinction from what this replaced: there were two feeds meaning
different things — one things to know, the other things to do — and the second
fed all-day events into the day *by itself*, as blocks that had to be argued
with if you did not want them. A row that does nothing until it is pressed
cannot put anything anywhere.

So the rule survives in the form that mattered: **nothing is auto-placed,
nothing is pinned, nothing is stored.** Reading a day is repeatable and claims
nothing. There is no placement endpoint and no `placed:` rows.

**The row never greys.** A Things row goes grey because the list is claiming to
say where a thing stands, and being in the day answers that. A calendar event is
a fact about the day that stays true whatever the day is built out of — a
meeting you have planned around is still a meeting at two o'clock. There is no
locked state and nothing to undo here: pressing twice makes two blocks, the same
as the list, and removing one is done where it now lives. The only feedback on
the row is a dim that lasts as long as the touch; the block appearing below is
the rest of it.

**It brings its length and not its time.** `duration_minutes` comes down with
each event — rounded **up** to the half hour, because a block that under-states
itself makes every time below it wrong in the direction that has you arriving
late, and clipped to what is left of the day from its own start, because
anything overlapping the date comes back and a three-day conference is not a
block. An all-day entry gets `null` and starts at one step like anything else.

The **time is shown and never used as a start**. Blocks stack from the wake time
and the day has no fixed hours, so a pressed event lands at the end and is
dragged into place like any other block. Sending it to its own hour would need
gaps the day does not have. The length is the one thing about a calendar event
this model can hold exactly — an hour is an hour wherever the block sits — and
carrying it saves three taps on the chip to say what the calendar already said.

#### Refresh, at the foot of the page

A quiet underlined **Refresh** below the day. It reloads the page.

**It exists because an installed app has no other way to.** No address bar, no
browser pull-to-refresh — the body carries `overscroll-behavior-y: none` — so
nothing inside the app could make it fetch itself again. That is exactly how a
phone ends up running a build from a fortnight ago and showing a screen that no
longer exists, which happened twice: a missing stats section and a missing
timezone row, both diagnosed as a stale page.

**It fetches the page, not the day.** Re-reading the data would be quicker and
would miss the point — what goes stale is the app itself, and only fetching the
page again replaces it.

**By navigating, not by reloading in place.** `location.replace(location.href)`,
not `location.reload()`. It was the reload for several revisions and came back
blank on a phone until the screen was touched: an installed app resumed in place
can come back suspended, with nothing painted and every fetch held. Replacing the
address is an ordinary navigation to a fresh document, and leaves no back entry —
going "back" to the page you just refreshed is not a destination.

**It was a pull from the top**, and a gesture is the wrong shape for this. It is
invisible until somebody tells you it is there, and it competes for the same
finger as the scroll it begins inside — the threshold had to be retuned once for
exactly that reason, because it was measured against the damped travel and took
119px of drag to reach. A link is findable and costs nothing to ignore.

At the very bottom and deliberately quiet: reaching for it means something has
already gone wrong. Muted and underlined like **Sign out**, which is the same
kind of thing — a rare utility at the foot of a screen. Not blue: blue is for
the controls that change the day, and this changes nothing.

What went with the gesture is named in the suite piece by piece — threshold,
damping, handlers, indicator — because a half-removed gesture leaves listeners
on the document that quietly take touches from the page. A case asserts the
document holds **no standing touch listener** at rest.

#### The builder

- **Starts** — an inline control, 30-minute steppers, clamped to 04:00–12:00.
  This is the one stepper left on the screen.
- **Blocks flow in sequence.** A block begins when the one above it ends, and
  that is the whole rule. Changing one duration shifts everything below it.
- **+ Block** adds a manual block.
- **Day ends** is live, and reads `HH:MM next day` in the warn colour past
  midnight. An empty day reads `0:00`, not a dash: a day with nothing in it has
  a perfectly good answer and the answer is nothing. The dash belongs to the day
  switch, which shows one while it fetches — a different statement, and the old
  hour is no longer true by then. It counts **timed blocks only**, so a day of
  nothing but untimed items ends at `0:00` — the hours really are empty.
- **Confirm** saves the plan. Any edit afterwards un-saves it. It stays visibly
  pressed from the tap until the save answers — the round trip takes about a
  second, and a seal that says nothing for that long reads as a tap that
  missed.

#### Anytime today

Below the timed blocks and above **Day ends**: things committed to the day and
not to an hour. Ring the dentist, put the bins out. Real commitments that belong
to a day and would be a lie at 10:30 — and putting them at 10:30 is what a
schedule made only of timed blocks forces you to do.

**They are blocks with no time, in the same table.** `start_time` and
`duration_minutes` are null **together**; a row with one and not the other is
refused, because it is not a state anything has a meaning for. A second table
would have needed its own ordering, its own reconciliation on confirm, its own
tie to an entry and its own answer to the staleness question — four copies of
what `blocks` already does, kept in step by hand.

**They take no time.** `reflow` gives them no start and, the half that matters,
does not advance its cursor past them, so nothing below shifts and the end time
is the timed blocks alone.

Adding one from the list: **long-press** a row in Things, or **Anytime** in its
`···` menu. The menu carries it in words because a gesture with nothing on screen
to suggest it is a feature only the person who built it knows about — the mistake
the `···` was added to correct in the first place. A plain tap still schedules a
timed block, as before.

**Or `+ Anytime`, which never touches the list at all.** Type a line, it goes
onto the day, tick it, done. The block carries **no `entry_id`**, exactly as
`+ Block` has always done for a timed one.

This is for the one-off — walk the dog, put the bins out, reply to that email.
Everything on this list used to have come off a Things row, so a reminder had to
be filed as a permanent thing you are carrying, scheduled onto the day, ticked,
and then finished on the list *separately* — because ticking an anytime item
answers *"did this happen"* and not *"is this over"*. Those are the same event for
walking the dog and different ones for reading. Four steps and two lists for
something that belongs to neither: Things is the standing inventory of what you
are carrying, and a reminder is not that.

**It lives on the day and goes with it.** An untouched one-off does not follow
you to tomorrow. That is what a one-off is — if it needs to survive the night it
is something you are carrying, and the list is where that goes.

**The name is typed in the page, not over it.** Both controls asked through the
browser's own `prompt()` — a system dialog that covers the app, arrives with no
warning, and has to be dismissed before anything can be seen again, one of those
per block on a day you build several at a time. Pressing either control replaces
it with a single line: a rule under a caret, the same shape the add form's fields
use, because it is the same act. No box and no fill; a boxed field would be the
one thing on this screen pretending to be software.

The placeholder says which of the two it will make, which is the only difference
between them. **Enter adds it and leaves the field open** — a day is built a
handful at a time, and closing after each entry puts back the cost this
replaced. **Leaving the field saves what is in it**, the rule a note on a block
already follows: tapping away from something you typed and watching it vanish is
the version that loses work. An empty line adds nothing and leaves the field
open; Escape closes it, on the keyboards that have one.

The two ways in sit **together, above the section**, as `+ Block` / `+ Anytime`.
Together because the choice between them is the whole content of the pair: with
an hour, or without. Above because the section is hidden until it holds
something, and a way in you cannot reach until you have already used it is not a
way in. That one is pinned by reading the markup rather than by driving the page
— the suite reaches a control by id wherever it sits, so a button nested inside
the hidden section would answer every press in every test and be unreachable on a
real screen.

No fourth entry type was added for this. The distinction between a thing done in
one sitting and a thing revisited is one the list already has words for — `task`
and `project` — and a `reminder` type would have made `task` vaguer by contrast
rather than clearer, for something that turns out not to need an entry at all.

Each row is a title, the note it arrived with, and a tick. The note is shown
rather than hidden behind a gesture: a row with no hour has room for it.

**No hairlines between them**, unlike Things. That reads as an inconsistency and
is the opposite of one: Things is a long list you scan down, where a rule is what
stops two rows reading as one. This is three or four items under a heading inside
a day already divided from what surrounds it, and ruling them made a short list
look like a table. Space separates, as it does everywhere else here (§7).

The tick, the title and the `×` share one line box and hang from the top of the
row, so their centres land on the same line whatever sits underneath — a note, a
longer title, nothing. Top rather than centre matters: a row with a note is
taller than its title, and centring would measure the controls against the whole
of it.

- **Ticked off leaves it visible, struck through.** What you got through is
  worth seeing at the end of a day.
- **The tick is written at once**, not at the next Confirm. Ticking happens all
  through the day, hours after the last Confirm, and a person who ticked three
  things and closed the app would lose all three — along with the staleness
  those ticks were the only record of. A row built in this session has no id to
  write against, so that one rides along with the next Confirm.
- **A small `×` at the right edge takes it off**, with the undo, and not the
  Things list's confirmation: this is one day, taking it off is how you say it is
  not happening today, and there is no history to lose.

  **Pressed, not swiped**, and that is why these rows carry no backing at all.
  A swipe carries a row aside to show what is under it, which is the blocks'
  language for an object you handle — and it was borrowed here for something
  that does not move. The `×` is faint and at the far edge, like the `···` on a
  Things row, because it repeats down the list and is the rarer of the two
  things you do here.
- **Tapping it promotes it** to a timed block at the end of the day, keeping its
  id, its note and its thing. One row changing shape, not a new one appearing.
  The tick and the `×` both stop the press reaching the row, so the only way to
  land on this is a press on the row itself.

The section has no heading. It read *Anytime today · 00* — a name for a section
the `+ Anytime` at its foot already names, and a count the rows already give —
and on an empty day it was a rule and a count of zero above a single button. The
section rule is now the first row's top edge, exactly as it is under the column
heads above.

The section is always drawn, empty or not: `+ Anytime` lives at its foot, so
hiding it when empty would hide the only way to put the first thing in it. An
empty list shows the same hatched row the table above does.

##### Staleness is the part that matters

A timed block counts for staleness **by staying in the day**: it had an hour, the
hour passed, and taking it out is how you say otherwise. An untimed item has no
hour to have passed, so the same rule would count it the moment it was added.

So `blocks.completed` comes back to life, and this is what it was kept for. It
has been inert for a long time — defaults true, nothing set it, and
`staleness.js` filtered on it anyway, in as many words *in case anything ever
set it again*. This is that:

| | |
|---|---|
| timed block | `completed = true`, always. It counts because it is in the day |
| untimed, unticked | `completed = false`. It does not count, and the clock keeps running |
| untimed, ticked | `completed = true`. It counts from that day, exactly like a timed block |

Without this, something done every day as an untimed item would read **"11 days
since"** for ever, because staleness only ever saw blocks with hours. `POST
/plan/block/:id/done` **refuses a timed block by name**: a route that could set
`completed` false on one would be a second, quieter answer to a question this
system settled long ago, and staleness would read whichever wrote last.

##### Telegram sends nothing for them

**Asked and answered: nothing at all is simpler, and it is also the only one
without a hole.** A closing line on the morning's first block message would need
the delivery path to identify that message, and it would go out on no day that
has no timed blocks — which is exactly the day where untimed items are the whole
plan. The app is where they live.

They are **not in the delivery queue at all**: `dueBlocks` filters
`start_time is null` out. The loop guards again by hand, and that duplication is
deliberate — `toMinutes(null)` is NaN, every comparison against NaN is false, so
an untimed item would fall past the too-early test, past the too-late test, and
be **sent**, as `NaN:NaN to NaN:NaN`. A guard that fails open into a delivered
message is the kind worth writing twice.

They are **not** left out of **How the month has gone** (§2.8) — that section
stopped counting hours partly because of them. A ticked untimed item counts
there exactly as a timed block does.

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

A thing can carry a note too (§3.1), and it is not this one. That one is
addressed to the next scheduling of the thing rather than to a session, which is
why it does not stay put: the confirm moves it onto the first new block for that
thing and clears the column behind it. A note that arrived that way is
indistinguishable from one typed here afterwards, which is correct — once it has
landed it is about this block and nothing else. What it never does is overwrite:
if the block already carries words of its own, the thing keeps its note and waits
for a scheduling with room for it.

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

**The drag counts in rows of the day, and converts once.** There are two ways to
say where a block is and they are not the same one. `blocks` holds the whole day,
timed and untimed, in the order things were added — and that is the index
everything acting on a block uses: remove, note, duration, the tick on an anytime
row. The **builder** draws only the timed ones; an anytime item has no hour, so
it is drawn in its own section and takes no row.

The drag is the one thing that lives in both, and it used one number for both. On
any day holding an anytime item the two ran apart by the count of loose items
above the finger — so the rows that stepped aside were the wrong ones, and **the
block that moved was not the one being carried**. Dragging the top block down one
place did nothing visible at all and quietly shuffled an anytime item instead.

Three functions are the whole conversion: `rowOfBlock` going in, `firstFreeRow`
for the floor, and `moveTimed` coming out. `moveTimed` lifts the timed blocks out,
reorders them among themselves, and puts them back into the same slots of the
array — so the untimed ones keep their exact places, which are their order in the
anytime list and their `sort_order` on the way to the server. A reorder of the day
above them is not a statement about them.

This is the same class of mistake the **divider** once caused, from the other
direction: the divider is a child of the builder too, and the empty-day spacer is
another, so reading every child made the two disagree by one from the divider
down. Filtering the builder's children to slots fixed that one and could not fix
this one, because here it is `blocks` that carries the extra entries.

**Where the block has got to is measured, not counted.** It used to divide the
travel by one pitch and round. A pitch is only true of a ladder with every rung
the same height, and the day is not one: **a block carrying a note is a line
taller than one without**, so every row below it sits somewhere the division did
not think it was and the drag landed a place out — further out the further down
the day. The whole layout is read once at pick-up, and the row a block has
reached is the row whose middle its own middle has reached. Reaching counts, not
passing: on an even ladder a drag of exactly one row lands exactly on the next
row's middle, which is the commonest drag there is.

The settle rides the same measurement. `(to - from) × pitch` is a distance on an
even ladder; what actually happens is that the rows in between close over the
space this block leaves and it takes the space they open, so the distance is the
sum of what is in between. Going down it comes to rest flush with the bottom of
the row it passed; going up, at that row's top.

The **rows that step aside** all shift by one number, and that is correct however
uneven they are: they are all closing over the same hole, which is the carried
block's own height and the gap under it.

The pitch was measured rather than assumed once before — it had been the slot's
height plus a hardcoded gap, and when the theme changed that gap the constant
stayed behind. Measuring one pitch was the right fix for that and the wrong
answer to this.

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

**The phone must not raise its own menu over the hold.** A 400ms press is also
roughly when iOS decides a long press was meant for it and offers copy / look up
/ share — arriving at the exact moment the block is being picked up. Both
`-webkit-user-select: none` and `-webkit-touch-callout: none` sit on everything
that is held: the block card and the Things row, which is held to put a thing in
the day without an hour. Neither substitutes for the other, and the failure is a
drag dying under a menu nobody asked for.

#### Reachable without being bigger

A finger is about 9mm across. The `···`, the anytime tick, its `×` and the wake
steppers are between 13px and 20px, and they are that size for a reason — the
`···` must not compete with the title it sits beside, and the tick is a mark
rather than a button. Sizing them to be *hit* would mean drawing them larger than
they should be *read*.

So the target grows and the mark does not: an absolutely positioned `::after`
with a negative inset, which takes part in no layout, draws nothing, and extends
the press about a finger's width in every direction.

The `···` is **asymmetric** — up, down and out to the right edge, where there is
nothing, and barely to the left, where the title is and where a tap means "put
this in the day". A tap meant for the row still has to reach the row.

Each control carries its own `position: relative`, and the checker verifies the
pair. A hit area on something unpositioned lands against the nearest positioned
ancestor — a whole row, or the page — and that failure is invisible until a tap
opens the wrong thing. These were written as one grouped selector first; a group
listed down the page ends on a line reading `.step {`, which is what a lookup by
name finds first, so the group answered for a rule it was not. The layout check
caught it on the first run, which is why the rules are one-per-control now.

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

### 4.3 What had no hour, at the end of the day

An anytime item has **no time by design**, so a reminder about one has to invent
a moment. The one the day already provides is the end of it: the work you gave
hours to is finished, and what is left is what you deliberately did not give an
hour to.

**It fires when the last timed block of the day ends** — a moment that comes out
of the person's own plan rather than a constant chosen here. On a day ending at
three it arrives at three; on a day of meetings until seven it waits until seven,
rather than landing mid-meeting and being forgotten. Any fixed hour is wrong for
one of those two days.

**Two guardrails, because a plan can be any shape.** Never before `LOOSE_FLOOR`
(16:00): a day ending at noon still has an afternoon in it, and a reminder at
noon spends it. Never after the person's `nudge_hour` (20:00 default): past that
the day is gone, and this has to arrive *before* "plan tomorrow" rather than
after it. On a day with no timed blocks at all the floor is the whole rule.

**Silent when nothing is left**, and it claims no `sent_log` slot when it says
nothing — so something added at ten past still reaches you. **Once**: one message
is a reminder and a second is nagging. **Confirmed plans only**, the same line
delivery holds — a day built and never agreed to is not something to be messaged
about.

Titles and nothing else, one message rather than one per item. No hours in it:
they have none, which is the point. *"Left today"* rather than *"still not
done"* — the first is a fact about the day and the second is an opinion about the
person.

**This does not soften the rule that untimed blocks never deliver.** They are
still absent from the block queue (`.not('start_time','is',null)`), still guarded
against inside `deliverDue`, and still never carry a `message_sent_at`. An
untimed item never fires *at an hour*; this is a sweep of the whole day, once,
which is a different thing. The suite says so out loud, because the next person
to read "untimed items don't deliver" will otherwise find a message that appears
to contradict it.

### 4.4 Saved for later, on Wednesdays

A thing can be **set down on purpose**: it leaves the Things list, keeps
everything it has, and stops competing for attention. `POST /entries/:id/later`
writes `entries.paused_at` — a timestamp, not a flag, because the column already
is one and because a thing set down in March and a thing set down on Tuesday are
not in the same state. `GET /entries` sends the two lists apart, `items` and
`saved`, both under the same sort.

The argument against this used to be that *something set down on purpose looks
the same as something neglected*. That is exactly right, and it is what the
message answers rather than a reason not to have the list.

**The section is dimmed to `opacity: 0.6`.** Space alone left two lists that
looked alike, and a row you set down on purpose reading like a row you still owe
is the one way this section can do harm. Opacity on the whole section rather than
a paler colour per part: the rows are made of half a dozen colours — title, meta,
marks, the pin — and dimming them one at a time would be six values kept in step
with six others. Far enough back to be a different list, not so far that it reads
as disabled: nothing here is unavailable, and every row still swipes, opens and
schedules.

**Wednesday at 17:00, local, and never over an empty list.** Mid-week and late
afternoon: far enough in that what you meant to do has met what actually
happened, early enough to still act on it. The condition is the feature — a
message that arrives every Wednesday whatever the state of the list teaches you
to stop reading it, and the week it finally matters is the week it goes unread.

Titles and nothing else. No dates, no count of how long each has sat there, no
encouragement: it is a list read out, and anything more would be the system
having an opinion about a decision that was deliberate.

An empty list **claims no slot in `sent_log`**. Silence that took the day would
mean someone who sets something down at ten past five waits a week to hear about
it. The claim goes in immediately before the send, for the reason the nudge
gives: the read is an early-out, not a guard.

Stats skips saved habits (`.is('paused_at', null)`). A habit put down on purpose
is not overdue, and reporting it as such would argue with a decision that was
just made.

---

## 5. Non-goals

- No chat, and no inbound Telegram.
- No auto-planning, no capacity modelling, no priority scoring.
- No ranking or manual ordering. The list sorts itself.
- No finance. That lane existed and was removed whole.
- No coldness verdicts, no cold flags, no temperature bars.
- No setup interview. Things are added one at a time through the form.
- No auto-archive. Nothing leaves the list because it has sat there a while.

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
| `warning.js` | the mark: length against time left, and nothing else |
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
| `routes/stats.js` | where the time went, over the last thirty days |
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
| `migration-entry-note.sql` | `entries.note` — a different note from the one above, and §3.1 says why |
| `migration-untimed.sql` | drops NOT NULL from `blocks.start_time` and `blocks.duration_minutes`, so a block can be committed to a day and not to an hour |
| `migration-default-zone.sql` | `profile.timezone` defaults to `America/New_York` rather than UTC, and moves the accounts already sitting on UTC |
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
| `profile.timezone` | which day and which hour everything is measured in. **Set on the setup screen** (§2.8), and defaults to `America/New_York` rather than UTC — §2.8 says what UTC cost |
| `profile.default_wake_time` | where a day with no plan yet starts. Its route and bounds are live but nothing on the screen writes it — see §2.8 |
| `profile.telegram_chat_id` | where outbound goes, or nowhere if unset |
| `profile.nudge_hour` | the evening nudge hour, 0–23, and the hour the screen starts opening on Tomorrow. Null means 20 |
| `profile.plans_in` | `morning` or `evening`. Which day the evening nudge asks about. It no longer decides which day the app opens on — that is always today. Null means evening |

The last two are still SQL-only. They are the two nobody has needed to change,
and a screen for a setting nobody moves is a screen to keep working for nothing.

---

## 7. The look

Reference: `public/mockup.html` for the screen, `public/switch.html` for the
Today / Tomorrow switch and the shape of a past block.

**Every time on the screen and in a message is twelve hour with AM/PM**, in
tabular figures. Storage is untouched: the page still sends minutes, the row is
still a 24-hour `time`, and one function on each side decides how a time reads.

**Neutral and light.** It was cream paper and ink: a fibre texture behind the
page, block cards whose edges were displaced through turbulence by an SVG filter
so no two matched, a shadow under each, a name seal for Confirm, an ensō for the
loading mark. It was chosen when this was a notebook, and it was well made — but
this is a planner you open several times a day to answer *what now*, and the
answer has to be the loudest thing on the screen, which it is not when the screen
is being something.

So: nothing here is a colour that is not doing work. A white page, three greys
that differ enough to rank, one blue for what can be pressed, one red for what is
running out.

This table has been wrong before — it went on listing an even earlier dark build
long after the paper one shipped, so the one document anybody would read to
answer "what colour is this app" answered with a build that no longer existed.
`plan-layout-check.js` reads both and refuses **any** hex in this section that
`:root` has never heard of, prose included, which is why the old values are
described here rather than quoted.

| | |
|---|---|
| bg | `#ffffff` |
| tint — the row you are in | `#f4f7fc` |
| text | `#0f1620` |
| muted | `#5c6b7f` |
| faint | `#97a3b4` |
| ghost — figures, never words | `#c3ccd8` |
| hairline, between rows | `#e6ebf1` |
| rule, under the row you are in | `#cfd8e3` |
| accent — blue | `#1e4fd8` |
| warn — red | `#dc2626` |

**Two faces, split by job.** Every figure is **IBM Plex Mono** with tabular
numerals, so times, durations and indexes fall into real columns down the page;
every name is **Inter**. Nothing crosses over. Both are fetched, which this page
had refused to do and for a good reason — a round trip on a cold load of an app
whose point is being open before you have finished reaching for it. `display=swap`
is what makes it survivable: the system stack renders first and the page never
blocks. Both stacks end in what the device already has, so a failed fetch
degrades rather than breaks.

**Three rule weights, each meaning something.** A **1.5px solid** in the ink
colour ends a section — the column heads, Anytime, Day ends. A **1px hairline**
separates two rows of the same kind. The **mid rule** sits under the row you are
in. Rules run the full width: the page's side margin is on the things between
rows, not on the page, because a line inset by 18px reads as a card with a
border rather than as a ledger.

**Four greys, not three**, and the fourth is why that is worth saying. `ghost` is
lighter than any contrast bar would pass and is allowed to be: it carries the
index column and the state of a row already over — figures you count down, never
words you read.

Contrast is checked rather than trusted. Text 18.2:1, muted 5.4:1 and blue 6.6:1
against the page; faint clears 3:1, which is all a mark is asked to carry. White
on blue clears 4.5:1 the other way round, which is what Confirm needs. And the
greys have to **rank** — if two land close enough to read as one, the page has
four registers and shows three.

`faint` is the one value on the page that does not clear a contrast bar: 2.6:1 on
white, against the 3:1 a mark is usually asked to carry. It was darkened once to
clear it and put back by hand, so it is a decision rather than an oversight —
and what keeps it defensible is what it is allowed to carry. Times on rows
already over, and the status column. Never a title, never a body size, never the
only copy of anything. Two checks hold that line, and if faint ever reaches a
title it stops being a note.

The rules, which hold everywhere and are pinned by `tests/plan-layout-check.js`:

- **Everything is a row, and nothing is a card.** Things and blocks alike: a
  hairline between one and the next, no fill, no radius, no shadow. A block used
  to be a card because a card says "this is an object you move" and blocks are
  the only things here that move — the drag says that on its own, and it says it
  while your finger is on it rather than all day.
- **A block states its whole span, under its title.** `8:00 AM – 8:30 AM`, in
  tabular figures.

  It was a single start time in a fixed column down the left for one revision.
  The hours stacked, and a glance down the edge was the shape of the day — which
  is a real gain, and it cost more than it was worth: a block is a piece of the
  day **with a size**, and a start time says when it opens without saying what it
  takes. The chip on the right says `30m`, so the row would have stated its
  length twice and its end never. The span says both at once.
- **A spent block is greyed, not redrawn.** Faint text on a ground a shade off
  the page. It was an outline once and that was refused for the right reason —
  an outline draws a thing rather than laying it down — and it was a second
  paper colour with a softer torn edge after that. Greying is the cheapest true
  statement: the same row, quieter.
- **Sections are separated by space**, 28px of it — not by borders, not by nested
  containers. The one heavier rule on the page is above **Day ends**, because
  that is the only division that is not between two rows of the same kind.
- **One label style:** 9.5px, uppercase, 0.26em tracking, muted. Actions like
  `+ Add` sit on its baseline and are **quieter** than it, never louder.
- **Two text sizes per row:** 15px title, 12px muted meta on its own line with
  real space between them.
- **There are two colours, and neither is subordinate to the other.** Blue says
  *you can press this*; red says *this is running out*. Both lists are enforced
  **by name** in the layout check, so a third use of either has to be argued for
  in that file rather than added quietly. Collapsing them into one would leave
  the day screen with no way to tell a control from a warning at a glance — a
  duration chip and a deadline mark would read alike.
- **Confirm is the one filled control.** A blue rectangle, white word. It was a
  hanko — a persimmon name seal drawn on a layer beneath the text with a
  turbulence filter for an uneven bite — and it cost two composited layers and
  two separate bugs: a word painted outside its own raster and coming back as
  `ONFIRME`, and a filter swap on the day switch that made the whole face
  invisible.

- **Blue is actionable, plus two things that are not.** The Starts steppers, the
  duration chip, `+ Block`, Undo, Save, Back, Clear and a focused field are all
  presses. The two that are not:

  - the **line of the divider**, which says *here is where you are* — the
    nearest thing to an action that is not one;
  - **`.said.good`**, a setup check that came back working, which is the one
    thing on that screen you can act on the strength of. It needs a colour of
    its own: `.said.bad` is persimmon and `.said.thin` is faint, and those three
    readings must not look alike (§2.8).

  **Confirm is not on this list.** It stopped being blue when it became the
  seal, and the layout check asserts as much by name.

  The near miss is the **active** label. It says much the same thing as the
  divider a line above it, so blue is the obvious reach — and it is wrong,
  because it sits in the slot the duration chip occupies on every other block.
  Blue there is an invitation to press something that does nothing. Pinned by
  name so it cannot drift back.

- **The warn colour warns; it does not narrate.** The deadline mark, a day
  running past midnight, a feed that failed, Delete and the backing of the swipe
  that offers it, a setup check that failed, and the seal. It has lost one job —
  a missed block, a concept that no longer exists — and the **block** swipe
  backing, which filled the whole card under a finger for an action that carries
  an undo. The **thing** swipe backing took the colour back, on the removing side
  only and as one word: that delete asks and then writes for good, and the colour
  is what says which of the two swipes you are in before your finger comes off
  (§3.1).

- **Nothing is styled for a feature that is gone.** The layout check reads the
  stylesheet both ways: no class worn that is undefined, and no class defined
  that nothing wears. The second half was missing, and the paste pipeline left
  `.preview` and `.pline` behind when it was deleted — four orphan rules, two of
  them coloured, which the two ink lists above counted as live uses for two
  releases.
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
