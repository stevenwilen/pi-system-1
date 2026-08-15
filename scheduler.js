// Outbound delivery, on a timer.
//
// Two jobs, and no model call in either. At each block's start time, send the
// text that was composed in code and stored when the day was confirmed. In the
// evening, if tomorrow has no confirmed plan, say so once.
//
// Run: node scheduler.js

require('dotenv').config();

const cron = require('node-cron');

const { service: supabase } = require('./db');
const { toMinutes, tomorrowOf } = require('./clock');
const { sendTelegram } = require('./telegram');
const { composeMessages } = require('./messages');
const { ONE_OFF } = require('./entry-shape');
const { rotState, daysUntilSweep } = require('./warning');
const { lastScheduled, daysBetween } = require('./staleness');

// The tick interval, in minutes.
//
// Deliberately shorter than the 30 minutes blocks sit on. A tick that only
// fires on the boundary has to be exactly on time or the block is missed for
// good, whereas asking "which blocks have started and not been sent" recovers
// by itself after a restart or a deploy.
const WINDOW = 15;

// How late a block may still be sent. Two ticks: enough to survive a restart
// or a slow deploy, short enough that nothing arrives long after the fact.
// A block older than this is marked sent without being sent, because "Gym,
// 08:00" arriving at 14:00 is worse than nothing.
const GRACE_MINUTES = 30;

// How far ahead of a block its message goes out.
//
// A message arriving at the moment a block starts is already late: you find out
// you should be doing something as the time to start doing it passes. Fifteen
// minutes is one tick of the loop, so a block's message lands on the tick before
// it — the same arithmetic, one step earlier.
//
// The message itself is unchanged. It names the block's own hours, so a heads-up
// at 08:45 still reads "9:00 AM to 10:00 AM", which is what makes it a warning
// rather than a correction.
const LEAD_MINUTES = 15;

// When the evening nudge goes out, for anyone who has not said otherwise.
// Late enough that the evening has had a chance to happen, early enough that
// planning tomorrow is still a reasonable thing to ask of someone.
const NUDGE_HOUR = 20;

// Telegram rejects anything over 4096 characters.
const MAX_MESSAGE = 4000;

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

// What time is it where this user lives?
function localNow(timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday, // 'Mon' ... 'Sun'
  };
}

// An hour and a minute as minutes past midnight. Named apart from clock.js's
// toMinutes, which takes a stored time string, because two functions with the
// same name and different arguments in one file is a trap.
function minutesOf(hour, minute) {
  return hour * 60 + minute;
}

// True when `now` sits in the WINDOW-minute window opening at `target`.
// Wraps around midnight so a 23:55 target still fires.
function inWindow(nowMinutes, targetMinutes) {
  const delta = (((nowMinutes - targetMinutes) % 1440) + 1440) % 1440;
  return delta < WINDOW;
}

function hhmm(time) {
  return String(time).slice(0, 5);
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async function allProfiles() {
  const { data, error } = await supabase
    .from('profile')
    .select('user_id, timezone, default_wake_time, telegram_chat_id, nudge_hour, plans_in');

  if (error) throw new Error(`could not load profiles: ${error.message}`);
  return data || [];
}

// The already-sent guard. A row's existence proves this went out for this user
// on this date, so it survives restarts and redeploys.
//
// Keyed (user_id, job, date). Blocks do not use it — they carry their own
// message_sent_at — so the only job behind it now is the nudge.
async function alreadySent(user_id, job, date) {
  const { data, error } = await supabase
    .from('sent_log')
    .select('id')
    .eq('user_id', user_id)
    .eq('job', job)
    .eq('sent_for_date', date)
    .maybeSingle();

  if (error) {
    // Can't tell, so don't send. If sent_log is unreadable the caller's own
    // queries are almost certainly failing too.
    console.error(`[SEND] ${job}: could not read sent_log: ${error.message}`);
    return true;
  }

  return Boolean(data);
}

/**
 * Take the once-a-day slot, and say whether we were the one who got it.
 *
 * The unique constraint on (user_id, job, sent_for_date) is the lock — which
 * the schema has said all along, while this was used as a receipt written
 * afterwards. Insert first and read the answer: 23505 is unique_violation,
 * meaning somebody else holds the slot, and that is the constraint doing its
 * job rather than a failure.
 */
async function claimSlot(user_id, job, date) {
  const { error } = await supabase
    .from('sent_log')
    .insert({ user_id, job, sent_for_date: date });

  if (!error) return true;
  if (error.code === '23505') return false;

  // Can't establish that we own it, so don't send.
  console.error(`[SEND] ${job}: could not claim the slot: ${error.message}`);
  return false;
}

/** Give the slot back, so a failed send is retried inside its window. */
async function releaseSlot(user_id, job, date) {
  const { error } = await supabase
    .from('sent_log')
    .delete()
    .eq('user_id', user_id)
    .eq('job', job)
    .eq('sent_for_date', date);

  if (error) console.error(`[SEND] ${job}: could not release the slot: ${error.message}`);
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

async function deliver(user_id, text) {
  const body =
    text.length > MAX_MESSAGE
      ? `${text.slice(0, MAX_MESSAGE)}\n…(truncated)`
      : text;

  return sendTelegram(supabase, user_id, body);
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

/**
 * Blocks of today's confirmed plan that have started and not been sent.
 *
 * Only a confirmed plan delivers. A day left pending was built and never
 * agreed to, and messaging someone about it would be the system deciding.
 */
async function dueBlocks(user_id, date) {
  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select('id')
    .eq('user_id', user_id)
    .eq('date', date)
    .eq('status', 'confirmed')
    .maybeSingle();

  if (planErr) throw new Error(`could not read plan: ${planErr.message}`);
  if (!plan) return [];

  const { data, error } = await supabase
    .from('blocks')
    .select('id, title, start_time, duration_minutes, note, created_at')
    .eq('plan_id', plan.id)
    .is('message_sent_at', null)
    // AN UNTIMED ITEM IS NOT IN THIS QUEUE AT ALL. It has no hour to fire at,
    // so there is nothing for the loop below to be early or late for — and it
    // must not be marked sent or retired either, because `message_sent_at` is
    // what this queue is made of and an item that never leaves it is simply an
    // item that is never asked about again.
    .not('start_time', 'is', null)
    .order('start_time');

  if (error) throw new Error(`could not read blocks: ${error.message}`);
  return data || [];
}

/**
 * Take this block out of the queue, and say whether we were the one who did.
 *
 * `.is('message_sent_at', null)` in the filter is what makes this safe. The
 * database compares and sets in one statement, so of two callers arriving
 * together exactly one updates a row and the other updates none — and it is
 * told so, because the update reports what it changed.
 *
 * THE MARK USED TO BE WRITTEN AFTER THE SEND CAME BACK. That left the row
 * sitting unclaimed for exactly as long as the Telegram call took, and the
 * queue is "message_sent_at IS NULL" — so anything else looking in that window
 * saw an unsent block and sent it a second time. Two things put a second
 * reader there: a Railway deploy overlaps the old container and the new one,
 * and this module runs a tick the moment it is required, so every start
 * re-checks the whole grace window rather than waiting for the next quarter
 * hour. Neither is a fault. Checking and then acting was.
 *
 * Claiming first means a crash between the claim and the send loses that
 * message rather than repeating it. That is the right way round: a message
 * that never arrives is a gap in a day, and one that arrives twice is the
 * system looking broken.
 */
async function claimBlock(id) {
  const { data, error } = await supabase
    .from('blocks')
    .update({ message_sent_at: new Date().toISOString() })
    .eq('id', id)
    .is('message_sent_at', null)
    .select('id');

  if (error) {
    // Can't establish that we own it, so don't send. A missed block is
    // recoverable on the next tick; a duplicate is not recoverable at all.
    console.error(`[SEND] block ${id}: could not claim: ${error.message}`);
    return false;
  }

  return Boolean(data && data.length);
}

/**
 * Put a claimed block back in the queue.
 *
 * Only after a send that failed. The claim is what stops a second sender, so
 * releasing it is what allows the retry the failure deserves — and the retry
 * is bounded anyway, because the block leaves the queue for good once it is
 * past the grace window.
 */
async function releaseBlock(id) {
  const { error } = await supabase
    .from('blocks')
    .update({ message_sent_at: null })
    .eq('id', id);

  if (error) console.error(`[SEND] block ${id}: could not release: ${error.message}`);
}

/**
 * One user, one tick.
 *
 * Claiming a block is what makes this safe to run every fifteen minutes, and
 * safe to run twice over: the claim is a compare-and-set at the database, so a
 * slow tick, an overlapping one, or a second container mid-deploy cannot send
 * the same block twice. See claimBlock.
 *
 * There is no longer a grace window for a block whose text has not been
 * written yet. The text is composed in code and inserted with the block, so a
 * block that exists has whatever line it is ever going to have.
 */
async function deliverDue(profile, now) {
  const nowMinutes = minutesOf(now.hour, now.minute);
  const blocks = await dueBlocks(profile.user_id, now.date);

  for (const block of blocks) {
    // Belt and braces with the filter in dueBlocks, and worth the duplication
    // for the shape of the failure it prevents. `toMinutes(null)` is NaN, and
    // every comparison below is false against NaN — so an untimed item would
    // fall past the "too early" test, past the "too late" test, and be SENT,
    // as a message reading "NaN:NaN to NaN:NaN". A guard that fails open into
    // a delivered message is the one kind worth writing twice.
    if (block.start_time === null || block.start_time === undefined) continue;

    const start = toMinutes(block.start_time);
    const late = nowMinutes - start;

    // Still further off than the lead. `late` stays measured against the block's
    // own start, so the expiry below and the [EXPIRED] line keep meaning what
    // they say — it is only the moment of sending that moves earlier.
    if (late < -LEAD_MINUTES) continue;

    if (late > GRACE_MINUTES) {
      // Long past. Retire it rather than delivering a message about a block
      // the person has already lived through.
      //
      // Claimed rather than plainly marked, so the warning below is written by
      // whichever caller actually retired it and not once per caller.
      //
      // Logged loudly and under its own tag on purpose. From the phone end,
      // a message that never arrives looks the same whether the block expired
      // or the scheduler is dead, and those need opposite responses. This line
      // says the loop ran, found the block, and chose not to send.
      if (await claimBlock(block.id)) {
        console.warn(
          `[EXPIRED] "${block.title}" was due at ${hhmm(block.start_time)} and is ${late} minutes late, past the ${GRACE_MINUTES} minute window. Not sent, and it will not be retried. The scheduler is running normally.`
        );
      }
      continue;
    }

    // Before the send, not after. Whoever takes the row owns the delivery, and
    // everyone else moves on without one.
    if (!(await claimBlock(block.id))) continue;

    const [header, note] = composeMessages(block);
    const result = await deliver(profile.user_id, header);

    if (result.sent) {
      // THE NOTE FOLLOWS, on its own, and cannot be retried on its own.
      //
      // The claim is over the block, not over each message — one row, taken
      // once, by whoever owns the delivery. So there is no state in which the
      // header has gone and the note has not, other than this one, and the
      // choice here is between two bad outcomes: release the block and the
      // next tick sends the header a SECOND time to get the note out, or keep
      // it and the note is lost.
      //
      // The duplicate is worse. A repeated notification at the top of the hour
      // reads as the system malfunctioning, and it would land during the block
      // the person is already in. A missing note is a message that says less
      // than it should have, which is what it said before this change on every
      // block that had one.
      //
      // Logged under its own tag for the same reason [EXPIRED] is: from the
      // phone end a note that never arrives looks like a note nobody wrote.
      if (note) {
        const second = await deliver(profile.user_id, note);
        if (!second.sent) {
          console.error(
            `[NOTE] "${block.title}": the header was delivered and the note was not. It will not be retried, because retrying would send the header again. ${JSON.stringify(second)}`
          );
        }
      }
      console.log(`[SEND] ${block.title}`);
    } else if (result.skipped) {
      // NOT A FAILURE, and this is the third outcome rather than a flavour of
      // the second. Someone who has not linked Telegram has nowhere to receive
      // a message, and there is nothing about that a retry improves.
      //
      // Treated as a failure it cost: the claim released and re-taken on every
      // tick for the whole grace window, an error logged each time, and finally
      // an [EXPIRED] warning about a delivery that was never going to happen.
      // Twelve alarming lines per block per day for an account that is simply
      // not using Telegram.
      //
      // The claim STAYS. The block is done with — not delivered, but resolved
      // — and leaving it claimed is what stops the next tick picking it up.
      console.log(`[SEND] ${block.title}: no telegram linked, nothing to send`);
    } else {
      // Back in the queue, so the next tick retries while it is still in grace.
      await releaseBlock(block.id);
      console.error(`[SEND] ${block.title}: ${JSON.stringify(result)}`);
    }
  }
}

// --- the evening nudge ------------------------------------------------------
//
// The one thing this system cannot do for someone is notice that they never
// opened it. Every other message is about something they already decided;
// this one is about the evening they did not spend deciding.
//
// One line, and it used to be two. The second named what had gone quiet, which
// required a daily verdict written by a model call, and that whole lane is
// gone. Rebuilding the line from days-since alone would have meant naming
// something every single night, including the nights when nothing was actually
// neglected — a nudge that always fires is a digest, and this is deliberately
// not that.

// One message per kind of planner, because the day it asks about is the whole
// content of it. Telling an evening planner about today would be naming a day
// they are already halfway through; telling a morning planner about tomorrow
// would be asking for a plan they do not make until they wake up.
const NUDGE_TEXT = {
  evening: 'No plan for tomorrow yet.',
  morning: 'No plan for today yet.',
};

/** Which day this person's nudge is about. Null reads as evening. */
const plansIn = (profile) => (profile.plans_in === 'morning' ? 'morning' : 'evening');

/**
 * Tell them the day ahead has no shape yet, once, in their evening.
 *
 * Silent on any day tomorrow is already confirmed. That is the whole condition
 * and it is checked against the row rather than inferred from anything: a
 * person who has planned their day must never be told they have not.
 */
async function sendNudge(profile, now, { force = false } = {}) {
  const hour = Number.isInteger(profile.nudge_hour) ? profile.nudge_hour : NUDGE_HOUR;
  const nowMinutes = minutesOf(now.hour, now.minute);
  if (!force && !inWindow(nowMinutes, minutesOf(hour, 0))) return;

  if (!force && (await alreadySent(profile.user_id, 'nudge', now.date))) return;

  // The day this person's plan is about. An evening planner is asked about
  // tomorrow, a morning planner about the day they are in.
  const kind = plansIn(profile);
  const asks = kind === 'morning' ? now.date : tomorrowOf(now.date);

  const { data: plan, error } = await supabase
    .from('plans')
    .select('id')
    .eq('user_id', profile.user_id)
    .eq('date', asks)
    .eq('status', 'confirmed')
    .maybeSingle();

  // Unreadable is not the same as absent. Saying nothing is the safe wrong
  // answer here, because the alternative is telling someone who has planned
  // their day that they have not.
  if (error) throw new Error(`could not read the plan for ${asks}: ${error.message}`);

  if (plan) {
    // Claimed anyway, so the rest of the evening does not ask again.
    if (!force) await claimSlot(profile.user_id, 'nudge', now.date);
    console.log(`[NUDGE] ${asks} is already confirmed, sending nothing`);
    return;
  }

  // The lock, immediately before the send rather than after it.
  //
  // The check above is an early-out and not a guard: between reading it and
  // sending there was a window as wide as the plan query plus the Telegram
  // call, and a second container — one mid-deploy, or one that had just
  // started and ticked on require — sat inside it and sent the nudge again.
  // Only one caller can insert this row, so only one gets past here.
  if (!force && !(await claimSlot(profile.user_id, 'nudge', now.date))) return;

  const text = NUDGE_TEXT[kind];
  const sent = await deliver(profile.user_id, text);

  if (sent.sent) {
    console.log(`[NUDGE] sent: ${text}`);
  } else if (sent.skipped) {
    // The same third outcome as a block. The slot stays taken: there is
    // nothing to retry, and releasing it would mean asking again every tick
    // for the rest of the window.
    console.log('[NUDGE] no telegram linked, nothing to send');
  } else {
    // Slot back, so the next tick inside the window tries again.
    if (!force) await releaseSlot(profile.user_id, 'nudge', now.date);
    console.error(`[NUDGE] ${JSON.stringify(sent)}`);
  }
}

// --- the weekly look at what was set down --------------------------------
//
// Things saved for later leave the list on purpose, and the whole risk of that
// is that leaving the list is indistinguishable from being forgotten. This is
// the one thing that goes looking for them.
//
// WEDNESDAY AT FIVE. Mid-week and late afternoon: far enough into the week that
// what you meant to do has met what actually happened, and early enough in the
// evening to still act on it.
const LATER_DAY = 'Wed';
const LATER_HOUR = 17;

// SILENT WHEN THERE IS NOTHING SET DOWN, and that is the difference between a
// reminder and a digest. A message that arrives every Wednesday whatever the
// state of the list teaches you to stop reading it, and the week it finally
// matters is the week it goes unread.
async function sendSavedForLater(profile, now, { force = false } = {}) {
  if (!force && now.weekday !== LATER_DAY) return;
  if (!force && !inWindow(minutesOf(now.hour, now.minute), minutesOf(LATER_HOUR, 0))) return;

  if (!force && (await alreadySent(profile.user_id, 'later', now.date))) return;

  const { data: saved, error } = await supabase
    .from('entries')
    .select('title, type, paused_at')
    .eq('user_id', profile.user_id)
    .eq('status', 'active')
    .not('paused_at', 'is', null)
    .order('paused_at');

  // Unreadable is not the same as empty. Saying nothing is the safe wrong
  // answer, because the alternative is telling someone their list is clear
  // when it is only unreachable.
  if (error) throw new Error(`could not read what is saved: ${error.message}`);

  if (!saved || !saved.length) {
    // NOT CLAIMED. Nothing was sent and nothing is owed, so there is no slot to
    // take — and taking one would only mean a person who sets something down at
    // ten past five waits a week to hear about it.
    return;
  }

  // The lock immediately before the send, for the reason the nudge gives: the
  // read above is an early-out, not a guard, and a second container mid-deploy
  // sits inside the window between them.
  if (!force && !(await claimSlot(profile.user_id, 'later', now.date))) return;

  const text = savedText(saved);
  const sent = await deliver(profile.user_id, text);

  if (sent.sent) {
    console.log(`[LATER] sent ${saved.length} saved thing(s)`);
  } else if (sent.skipped) {
    // The slot stays taken. There is nothing to retry for an account with no
    // chat linked, and releasing it would mean asking again every tick.
    console.log('[LATER] no telegram linked, nothing to send');
  } else {
    if (!force) await releaseSlot(profile.user_id, 'later', now.date);
    console.error(`[LATER] ${JSON.stringify(sent)}`);
  }
}

/**
 * The message. Titles and nothing else.
 *
 * No dates, no counts of how long each has sat there, no encouragement. This
 * is a list read out, and everything else would be the system having an
 * opinion about a decision that was deliberate.
 */
function savedText(saved) {
  const lines = saved.map((e) => `• ${e.title}`).join('\n');
  const many = saved.length === 1 ? 'one thing' : `${saved.length} things`;
  return `You have ${many} saved for later:\n\n${lines}`;
}

// --- what had no hour ------------------------------------------------------
//
// An anytime item has no time BY DESIGN, so a reminder about one has to invent
// a moment. The one the day already provides is the end of it: the work you
// gave hours to is finished, and what is left is what you deliberately did not
// give an hour to.
//
// That reads as "here is your day, and here is what had no place in it", and
// the moment comes out of the person's own plan rather than a constant chosen
// here. On a day ending at three it arrives at three; on a day of meetings
// until seven it waits until seven, rather than landing mid-meeting and being
// forgotten — which is what any fixed hour would do to one of those two days.
//
// TWO GUARDRAILS, because a plan can be any shape. Never before LOOSE_FLOOR: a
// day that ends at noon still has an afternoon in it, and a reminder at noon
// spends it. Never after the nudge hour: past that the day is gone, and this
// has to arrive before "plan tomorrow" rather than after it. On a day with no
// timed blocks at all the floor is the whole rule.
const LOOSE_FLOOR = 16;

/** The minute the day's timed work ends. Zero for a day with none. */
function dayEnds(blocks) {
  let end = 0;
  for (const b of blocks) {
    if (b.start_time === null || b.start_time === undefined) continue;
    end = Math.max(end, toMinutes(b.start_time) + Number(b.duration_minutes || 0));
  }
  return end;
}

// SILENT WHEN NOTHING IS LEFT, the same rule the Wednesday message follows and
// for the same reason: one that arrives whatever the state of the list teaches
// you to stop reading it, and the day it matters is the day it goes unread.
//
// ONCE. One message is a reminder and a second is nagging, which this system
// does not do.
/**
 * One-offs whose day is behind them.
 *
 * THE OTHER HALF OF THE TICK, and the half that cannot be done from the page.
 * An untimed one-off is finished the moment it is ticked, but a timed block has
 * no tick at all — taking it out of the day is how you say it did not happen,
 * which means a block still sitting in a day that is over is a block that did.
 * That is not a rule invented here: it is how this system reads every day it
 * has ever read (§2.4), and it is the same reasoning `staleness.js` uses to
 * decide when something was last done.
 *
 * SENDS NOTHING. Every other lane exists to put a message on a phone; this one
 * only tidies, and it is here because it needs the same daily sweep across
 * every account and the same service key to do it with.
 *
 * STRICTLY BEFORE TODAY. A one-off scheduled for this afternoon is not finished
 * because the sweep ran this morning, and one confirmed for tomorrow is not
 * finished at all. The date comparison is the whole guard.
 */
async function finishOneOffs(profile, now) {
  // Every one-off still being carried. Small by nature — a one-off that is
  // working leaves within a day of being scheduled — so this is a short list
  // even on an account that has been running for years.
  const { data: entries, error: entryErr } = await supabase
    .from('entries')
    .select('id')
    .eq('user_id', profile.user_id)
    // A task. The column is shared with a habit's cadence, so the type is what
    // keeps a weekly habit from being swept off the list as though it were a
    // thing that happens once.
    .eq('type', 'task')
    .eq('frequency', ONE_OFF)
    .eq('status', 'active');

  if (entryErr) throw new Error(`could not read one-offs: ${entryErr.message}`);
  if (!entries || !entries.length) return [];

  // The days that are over, and only the ones that were agreed to. A day built
  // and never confirmed is a draft, and finishing something off the back of a
  // draft would be the system deciding what happened.
  const { data: plans, error: planErr } = await supabase
    .from('plans')
    .select('id')
    .eq('user_id', profile.user_id)
    .eq('status', 'confirmed')
    .lt('date', now.date);

  if (planErr) throw new Error(`could not read past plans: ${planErr.message}`);
  if (!plans || !plans.length) return [];

  const { data: blocks, error: blockErr } = await supabase
    .from('blocks')
    .select('entry_id')
    .eq('user_id', profile.user_id)
    .in('plan_id', plans.map((p) => p.id))
    .in('entry_id', entries.map((e) => e.id));

  if (blockErr) throw new Error(`could not read past blocks: ${blockErr.message}`);

  const over = [...new Set((blocks || []).map((b) => b.entry_id).filter(Boolean))];
  if (!over.length) return [];

  // `done`, not `deleted`: this is work that happened, and the two are recorded
  // apart on purpose (§2.3). The status filter is what makes a second sweep
  // over the same day a no-op rather than a second write.
  const { data: moved, error } = await supabase
    .from('entries')
    .update({ status: 'done' })
    .eq('user_id', profile.user_id)
    .eq('status', 'active')
    .in('id', over)
    .select('id, title');

  if (error) throw new Error(`could not finish one-offs: ${error.message}`);

  for (const row of moved || []) {
    console.log(`[ONEOFF] ${profile.user_id}: finished ${JSON.stringify(row.title)}`);
  }

  return moved || [];
}

// --- what has been shouting for too long ------------------------------------

// The hour it runs, once a day. Late morning rather than evening: something
// being set aside is not news you want at bedtime, and the warning that
// precedes it is worth a day you can still act in.
const ROT_HOUR = 11;

/**
 * Warn about what is about to be set aside, and set aside what is past due.
 *
 * THE PROBLEM THIS ANSWERS. A '!!!' says the room has run out. It says it on
 * the day the room ran out and says exactly the same thing a year later,
 * because it is three buckets and the bottom one has no floor. So a thing could
 * sit at the loudest the system can shout for ever, and the shout stopped
 * meaning anything in the second week.
 *
 * SET ASIDE, NOT DELETED. It moves to Saved for later, which is a place that
 * already exists, already has a heading saying these were put there on purpose,
 * and already gets its own Wednesday message. Deleting would have been the
 * other reading of "removed", and `status = 'deleted'` is a tombstone this
 * system cannot undo from any screen — an automatic, timer-driven, irreversible
 * write against real rows, whose only notice is a Telegram message that may
 * never arrive. Setting aside is one tap from being back.
 *
 * NOTHING IS SAID IN THE APP, deliberately. The list shows what it always
 * showed; this speaks on the phone or not at all.
 *
 * TWO EXEMPTIONS. A pin is someone saying "this one" outright, and overruling
 * that with a timer would be the system arguing with a decision it was told
 * about. Something already set aside is already where this would put it.
 */
async function sweepRotting(profile, now, { force = false } = {}) {
  if (!force && !inWindow(minutesOf(now.hour, now.minute), minutesOf(ROT_HOUR, 0))) return;
  if (!force && (await alreadySent(profile.user_id, 'rot', now.date))) return;

  const { data: rows, error } = await supabase
    .from('entries')
    .select('id, type, title, frequency, due, size, priority, paused_at, created_at')
    .eq('user_id', profile.user_id)
    .eq('status', 'active')
    // Exempt, both of them, and asked of the database rather than filtered
    // afterwards so a row that should never be touched is never even read as a
    // candidate.
    .is('priority', null)
    .is('paused_at', null);

  if (error) throw new Error(`could not read what is rotting: ${error.message}`);
  if (!rows || !rows.length) return;

  // The same staleness the list is ordered by, and the same one a habit's mark
  // is made of. Asked once for every row rather than per row.
  const latest = await lastScheduled(supabase, profile.user_id);

  const warn = [];
  const sweep = [];

  for (const r of rows) {
    const since = latest.get(r.id) || String(r.created_at).slice(0, 10);
    const item = {
      type: r.type,
      frequency: r.frequency,
      due: r.due ? String(r.due).slice(0, 10) : null,
      size: r.size,
      today: now.date,
      days: Math.max(0, daysBetween(since, now.date)),
    };

    const state = rotState(item);
    if (state === 'sweep') sweep.push({ ...r, item });
    else if (state === 'warn') warn.push({ ...r, item, inDays: daysUntilSweep(item) });
  }

  if (!warn.length && !sweep.length) return;

  // THE WRITE FIRST, and the message after it. A message promising something is
  // about to happen, sent before the thing that already should have happened,
  // would describe a list the person cannot check — and if the update then
  // failed they would be told about a move that never took place.
  if (sweep.length) {
    const { error: moveErr } = await supabase
      .from('entries')
      .update({ paused_at: new Date().toISOString() })
      .eq('user_id', profile.user_id)
      .eq('status', 'active')
      .is('paused_at', null)
      .in('id', sweep.map((s) => s.id));

    if (moveErr) throw new Error(`could not set aside: ${moveErr.message}`);

    for (const s of sweep) {
      console.log(`[ROT] ${profile.user_id}: set aside ${JSON.stringify(s.title)}`);
    }
  }

  if (!force && !(await claimSlot(profile.user_id, 'rot', now.date))) return;

  const sent = await deliver(profile.user_id, rotText(warn, sweep));

  if (sent.sent) {
    console.log(`[ROT] warned about ${warn.length}, set aside ${sweep.length}`);
  } else if (sent.skipped) {
    // The rows still moved. Someone with no Telegram linked still gets the
    // tidying — they simply read about it on the list rather than on a phone.
    console.log('[ROT] no telegram linked, nothing to send');
  } else {
    // NO RELEASE, unlike every other lane. The rows have already been moved,
    // and a retry would say it again about a list that has already changed.
    console.error(`[ROT] rows moved but the message failed: ${JSON.stringify(sent)}`);
  }
}

/**
 * The message. What went, and what is about to.
 *
 * Plain, and it names the way back. Something set aside without being told how
 * to retrieve it is indistinguishable from something lost.
 */
function rotText(warn, sweep) {
  const parts = [];

  if (sweep.length) {
    const many = sweep.length === 1 ? 'One thing has' : `${sweep.length} things have`;
    parts.push(
      `<b>${many} been set aside</b>\n\n` +
        sweep.map((s) => `• ${s.title}`).join('\n') +
        '\n\nNothing is lost — they are under Saved for later, and one tap puts any of them back.'
    );
  }

  if (warn.length) {
    const lines = warn
      .map((wRow) => `• ${wRow.title} — ${wRow.inDays === 1 ? 'tomorrow' : `in ${wRow.inDays} days`}`)
      .join('\n');
    parts.push(`<b>About to be set aside</b>\n\n${lines}`);
  }

  return parts.join('\n\n');
}

async function sendAnytime(profile, now, { force = false } = {}) {
  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select('id')
    .eq('user_id', profile.user_id)
    .eq('date', now.date)
    .eq('status', 'confirmed')
    .maybeSingle();

  if (planErr) throw new Error(`could not read plan: ${planErr.message}`);

  // A day built and never agreed to. Delivery holds the same line, and a
  // reminder about a pending plan would be the system deciding.
  if (!plan) return;

  const { data: blocks, error } = await supabase
    .from('blocks')
    .select('title, start_time, duration_minutes, completed, sort_order')
    .eq('user_id', profile.user_id)
    .eq('plan_id', plan.id)
    .order('sort_order');

  // Unreadable is not empty. Saying nothing is the safe wrong answer; the
  // alternative is telling someone their day is clear when it is unreachable.
  if (error) throw new Error(`could not read the day: ${error.message}`);

  const nudge = Number.isInteger(profile.nudge_hour) ? profile.nudge_hour : NUDGE_HOUR;
  const at = Math.min(
    Math.max(dayEnds(blocks || []), minutesOf(LOOSE_FLOOR, 0)),
    minutesOf(nudge, 0)
  );

  if (!force && !inWindow(minutesOf(now.hour, now.minute), at)) return;
  if (!force && (await alreadySent(profile.user_id, 'loose', now.date))) return;

  const loose = (blocks || []).filter(
    (b) => (b.start_time === null || b.start_time === undefined) && !b.completed
  );

  // NOT CLAIMED when there is nothing to say. Nothing was sent and nothing is
  // owed — and taking the slot would mean a person who adds one at ten past
  // hears nothing at all.
  if (!loose.length) return;

  // The lock immediately before the send, for the reason the nudge gives: the
  // reads above are an early-out rather than a guard, and a second container
  // mid-deploy sits inside the window between them.
  if (!force && !(await claimSlot(profile.user_id, 'loose', now.date))) return;

  const sent = await deliver(profile.user_id, looseText(loose));

  if (sent.sent) {
    console.log(`[LOOSE] sent ${loose.length} thing(s) with no hour`);
  } else if (sent.skipped) {
    // The slot stays taken. Nothing to retry for an account with no chat, and
    // releasing it would mean asking again every tick for the rest of the day.
    console.log('[LOOSE] no telegram linked, nothing to send');
  } else {
    if (!force) await releaseSlot(profile.user_id, 'loose', now.date);
    console.error(`[LOOSE] ${JSON.stringify(sent)}`);
  }
}

/**
 * The message. Titles and nothing else, like the Wednesday one.
 *
 * No hours — they have none, which is the point — and no encouragement. A list
 * read out. "Left today" rather than "still not done": the first is a fact
 * about the day and the second is an opinion about the person.
 */
function looseText(loose) {
  const lines = loose.map((b) => `• ${b.title}`).join('\n');
  const many = loose.length === 1 ? 'one thing' : `${loose.length} things`;
  return `You have ${many} left today:\n\n${lines}`;
}

async function tick() {
  let profiles;
  try {
    profiles = await allProfiles();
  } catch (err) {
    console.error(err.message);
    return;
  }

  for (const profile of profiles) {
    let now;
    try {
      now = localNow(profile.timezone);
    } catch {
      console.error(`skipping ${profile.user_id}: bad timezone ${profile.timezone}`);
      continue;
    }

    // The two lanes are independent. One failing must not silence the other,
    // and neither must stop the next person being served.
    try {
      await deliverDue(profile, now);
    } catch (err) {
      console.error(`[SEND] ${profile.user_id}: ${err.message}`);
    }

    try {
      await sendNudge(profile, now);
    } catch (err) {
      console.error(`[NUDGE] ${profile.user_id}: ${err.message}`);
    }

    try {
      await sendSavedForLater(profile, now);
    } catch (err) {
      console.error(`[LATER] ${profile.user_id}: ${err.message}`);
    }

    try {
      await sendAnytime(profile, now);
    } catch (err) {
      console.error(`[LOOSE] ${profile.user_id}: ${err.message}`);
    }

    // In its own try, like every other lane: this one WRITES, and a throw here
    // must not take the rest of somebody's day down with it.
    try {
      await sweepRotting(profile, now);
    } catch (err) {
      console.error(`[ROT] ${profile.user_id}: ${err.message}`);
    }

    // Sends nothing. It is here because it needs the same daily sweep across
    // every account that the lanes above it need.
    try {
      await finishOneOffs(profile, now);
    } catch (err) {
      console.error(`[ONEOFF] ${profile.user_id}: ${err.message}`);
    }
  }
}

// Test surface, and nothing else.
//
// No production code imports this module: server.js requires it for the side
// effect of starting cron and takes nothing from it. So everything below is
// here for one reason, which is to let a suite drive one real user through one
// real delivery without waiting fifteen minutes for the timer.
module.exports = {
  allProfiles, // pick the profile to drive
  localNow, //    build the 'now' to drive it at
  deliverDue, //  the tick itself, for one user
  hhmm, //        so a test can spell the time the same way the message does
  sendNudge, //   the evening nudge, for one user at one moment
  NUDGE_TEXT, //  the whole message, for a test that checks the wording
  sendAnytime, //  the sweep of what had no hour, at the end of the day
  looseText, //   its wording, so a test reads the real thing
  LOOSE_FLOOR, // and the floor under it
  sendSavedForLater, // the Wednesday look at what was set down
  savedText, //   its wording, so a test reads the real thing
  LATER_DAY, //   and when it goes, so a test cannot drift from the job
  LATER_HOUR,
  finishOneOffs, // the sweep that takes a done one-off off the list
  sweepRotting, // the one lane that moves a row nobody asked it to
  rotText, //     its wording, so a test reads the real thing
  ROT_HOUR, //    and its hour, so a test cannot drift from the job
};

// ---------------------------------------------------------------------------
// running one job by hand
// ---------------------------------------------------------------------------
//
//   node scheduler.js --run nudge
//
// Fires one job for every profile, now, ignoring both the hour it is meant to
// run at and the sent_log guard, so it can be tried repeatedly without a row
// blocking the second attempt. Nothing is written to sent_log either, for the
// same reason.
//
// What it does NOT skip is the condition the job exists for. `--run nudge` on
// an evening that is already planned still sends nothing, because that is the
// behaviour worth testing rather than the timing.

const JOBS = {
  blocks: deliverDue,
  nudge: sendNudge,
  later: sendSavedForLater,
  loose: sendAnytime,
  oneoff: finishOneOffs,
  rot: sweepRotting,
};

async function runOnce(name) {
  const job = JOBS[name];

  if (!job) {
    console.error(
      `unknown job ${JSON.stringify(name)}. One of: ${Object.keys(JOBS).join(', ')}`
    );
    process.exitCode = 1;
    return;
  }

  let profiles;
  try {
    profiles = await allProfiles();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  for (const profile of profiles) {
    const now = localNow(profile.timezone);
    console.log(
      `[RUN] ${name} for ${profile.user_id}, local ${now.date} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`
    );

    try {
      await job(profile, now, { force: true });
    } catch (err) {
      console.error(`[RUN] ${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

const runAt = process.argv.indexOf('--run');

if (runAt !== -1) {
  // A manual run must not also start the timer, or the process would sit there
  // afterwards ticking against the real database.
  runOnce(process.argv[runAt + 1]);
} else if (process.env.SCHEDULER_DISABLED !== '1') {
  // Starting the loop on require is deliberate: server.js requires this module
  // so the web process and the scheduler share one Railway service.
  // Set SCHEDULER_DISABLED=1 to load this module without starting the loop.
  // That is how a test drives a single tick: without it, requiring the file
  // would also fire cron against the real database and send real messages.
  cron.schedule(`*/${WINDOW} * * * *`, tick);
  console.log(`scheduler running, checking every ${WINDOW} minutes`);
  tick();
}
