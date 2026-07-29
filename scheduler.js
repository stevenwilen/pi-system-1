// Outbound delivery, on a timer.
//
// Two jobs, and no model call in either. At each block's start time, send the
// text that was composed in code and stored when the day was confirmed. In the
// evening, if tomorrow has no confirmed plan, say so once.
//
// Run: node scheduler.js

require('dotenv').config();

const cron = require('node-cron');

const supabase = require('./db');
const { toMinutes, tomorrowOf } = require('./clock');
const { sendTelegram } = require('./telegram');
const { composeMessage } = require('./messages');

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

async function markSent(user_id, job, date) {
  const { error } = await supabase
    .from('sent_log')
    .insert({ user_id, job, sent_for_date: date });

  // 23505 is unique_violation: something already claimed this slot. That is
  // the constraint doing its job, not a failure.
  if (error && error.code !== '23505') {
    console.error(`[SEND] ${job}: could not write sent_log: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

async function deliver(user_id, text) {
  const body =
    text.length > MAX_MESSAGE
      ? `${text.slice(0, MAX_MESSAGE)}\n…(truncated)`
      : text;

  return sendTelegram(user_id, body);
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
    .order('start_time');

  if (error) throw new Error(`could not read blocks: ${error.message}`);
  return data || [];
}

async function markBlockSent(id) {
  const { error } = await supabase
    .from('blocks')
    .update({ message_sent_at: new Date().toISOString() })
    .eq('id', id);

  if (error) console.error(`[SEND] block ${id}: could not mark sent: ${error.message}`);
}

/**
 * One user, one tick.
 *
 * Marking a block sent is what makes this safe to run every fifteen minutes:
 * a block leaves the queue the moment it is delivered, so a slow tick or an
 * overlapping one cannot send it twice.
 *
 * There is no longer a grace window for a block whose text has not been
 * written yet. The text is composed in code and inserted with the block, so a
 * block that exists has whatever line it is ever going to have.
 */
async function deliverDue(profile, now) {
  const nowMinutes = minutesOf(now.hour, now.minute);
  const blocks = await dueBlocks(profile.user_id, now.date);

  for (const block of blocks) {
    const start = toMinutes(block.start_time);
    const late = nowMinutes - start;

    if (late < 0) continue; // not started yet

    if (late > GRACE_MINUTES) {
      // Long past. Retire it rather than delivering a message about a block
      // the person has already lived through.
      //
      // Logged loudly and under its own tag on purpose. From the phone end,
      // a message that never arrives looks the same whether the block expired
      // or the scheduler is dead, and those need opposite responses. This line
      // says the loop ran, found the block, and chose not to send.
      console.warn(
        `[EXPIRED] "${block.title}" was due at ${hhmm(block.start_time)} and is ${late} minutes late, past the ${GRACE_MINUTES} minute window. Not sent, and it will not be retried. The scheduler is running normally.`
      );
      await markBlockSent(block.id);
      continue;
    }

    const result = await deliver(profile.user_id, composeMessage(block));

    if (result.sent) {
      await markBlockSent(block.id);
      console.log(`[SEND] ${block.title}`);
    } else {
      // No mark, so the next tick retries while the block is still in grace.
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
    if (!force) await markSent(profile.user_id, 'nudge', now.date);
    console.log(`[NUDGE] ${asks} is already confirmed, sending nothing`);
    return;
  }

  const text = NUDGE_TEXT[kind];
  const sent = await deliver(profile.user_id, text);

  if (sent.sent) {
    if (!force) await markSent(profile.user_id, 'nudge', now.date);
    console.log(`[NUDGE] sent: ${text}`);
  } else {
    // No mark, so the next tick inside the window tries again.
    console.error(`[NUDGE] ${JSON.stringify(sent)}`);
  }
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
