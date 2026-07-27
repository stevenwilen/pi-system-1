// Outbound delivery, on a timer.
//
// At each block's start time, send the text the brain already wrote and stored
// when the day was confirmed. No model call happens here: this reads a row and
// sends it. See SPEC section 5.
//
// Run: node scheduler.js

require('dotenv').config();

const cron = require('node-cron');

const supabase = require('./db');
const { sendTelegram } = require('./telegram');
const { composeMessage } = require('./messages');
const { generateDaily } = require('./finance-insight');
const { judge } = require('./coldness');

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

// Block messages are written after the confirm response goes out and take
// around half a minute. If a block is due and has no text yet, and the day was
// confirmed this recently, generation is probably still running. Let the next
// tick have it: a message fifteen minutes late beats one permanently stripped
// back to its header.
const GENERATION_GRACE_MS = 2 * 60 * 1000;

// The hour the finance line goes out, in the person's own time. Evening: the
// day's spending has mostly happened, and there is still time to act on it.
const FINANCE_HOUR = 18;

// The coldness verdict runs before the evening, so the panel is already judged
// by the time anyone opens it to plan tomorrow. Nothing is sent; it only
// writes to rows.
const COLD_HOUR = 16;

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

function toMinutes(hour, minute) {
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
    .select('user_id, timezone, default_wake_time, telegram_chat_id');

  if (error) throw new Error(`could not load profiles: ${error.message}`);
  return data || [];
}

// The already-sent guard. A row's existence proves this went out for this user
// on this date, so it survives restarts and redeploys.
//
// Still keyed (user_id, job, date), which cannot express "block 4 of today".
// Re-keying it is part of building block delivery.

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

// Outbound text used to be copied into `messages` so the chat and the bot read
// as one thread. There is no chat now, nothing reads that table, and the text
// of a block message lives on the block itself, so the copy is not written.
// The table and its rows stay.
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

const toMinutesOfDay = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

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
    .select('id, title, start_time, duration_minutes, message_text, created_at')
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
 */
async function deliverDue(profile, now) {
  const nowMinutes = toMinutes(now.hour, now.minute);
  const blocks = await dueBlocks(profile.user_id, now.date);

  for (const block of blocks) {
    const start = toMinutesOfDay(block.start_time);
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

    if (!block.message_text && Date.now() - new Date(block.created_at).getTime() < GENERATION_GRACE_MS) {
      // Confirmed moments ago, so the line is probably still being written.
      // Leave it queued; the next tick is still inside the grace window.
      console.log(`[SEND] ${block.title}: just confirmed, waiting for its line`);
      continue;
    }

    const result = await deliver(profile.user_id, composeMessage(block));

    if (result.sent) {
      await markBlockSent(block.id);
      console.log(`[SEND] ${block.title}${block.message_text ? '' : ' (header only)'}`);
    } else {
      // No mark, so the next tick retries while the block is still in grace.
      console.error(`[SEND] ${block.title}: ${JSON.stringify(result)}`);
    }
  }
}

/**
 * The one finance line for today.
 *
 * A separate lane on its own cadence: once a day, at a fixed hour, regardless
 * of whether a plan exists. sent_log is the guard, so a restart inside the
 * window cannot send a second one, and a failed send leaves no row so the next
 * tick retries.
 */
async function deliverFinance(profile, now) {
  const nowMinutes = toMinutes(now.hour, now.minute);
  if (!inWindow(nowMinutes, toMinutes(FINANCE_HOUR, 0))) return;

  if (await alreadySent(profile.user_id, 'finance', now.date)) return;

  const result = await generateDaily(profile.user_id, now.date);

  if (!result.text) {
    // Nothing worth sending is a real outcome, not a failure. It is claimed in
    // sent_log all the same, so a skipped day is not retried every fifteen
    // minutes for the rest of the evening.
    console.log(`[FINANCE] nothing to send today: ${result.skipped}`);
    await markSent(profile.user_id, 'finance', now.date);
    return;
  }

  const sent = await deliver(profile.user_id, result.text);
  if (sent.sent) {
    await markSent(profile.user_id, 'finance', now.date);
    console.log(`[FINANCE] sent: ${result.text}`);
  } else {
    console.error(`[FINANCE] ${JSON.stringify(sent)}`);
  }
}

/**
 * Judge what has gone cold, once a day, before the evening.
 *
 * Sends nothing. It writes verdicts to rows so the panel is already judged
 * when it is opened, which is what keeps the model off the read path.
 */
async function judgeColdness(profile, now) {
  const nowMinutes = toMinutes(now.hour, now.minute);
  if (!inWindow(nowMinutes, toMinutes(COLD_HOUR, 0))) return;

  if (await alreadySent(profile.user_id, 'coldness', now.date)) return;

  const result = await judge(profile.user_id, now.date);

  // Claimed either way. A day where nothing could be judged should not be
  // retried every fifteen minutes until midnight, and judge() has already left
  // the previous verdicts standing.
  await markSent(profile.user_id, 'coldness', now.date);

  if (!result.judged) console.log(`[COLD] nothing judged today: ${result.reason}`);
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
      await deliverFinance(profile, now);
    } catch (err) {
      console.error(`[FINANCE] ${profile.user_id}: ${err.message}`);
    }

    try {
      await judgeColdness(profile, now);
    } catch (err) {
      console.error(`[COLD] ${profile.user_id}: ${err.message}`);
    }
  }
}

module.exports = {
  localNow,
  toMinutes,
  inWindow,
  hhmm,
  allProfiles,
  alreadySent,
  markSent,
  deliver,
  // Exported so a test can drive one user through one tick without waiting
  // fifteen minutes for cron.
  deliverDue,
  deliverFinance,
  judgeColdness,
  dueBlocks,
  tick,
  GRACE_MINUTES,
  GENERATION_GRACE_MS,
  FINANCE_HOUR,
  COLD_HOUR,
};

// Starting the loop on require is deliberate: server.js requires this module
// so the web process and the scheduler share one Railway service.
// Set SCHEDULER_DISABLED=1 to load this module without starting the loop. That
// is how a test drives a single tick: without it, requiring the file would
// also fire cron against the real database and send real messages.
if (process.env.SCHEDULER_DISABLED !== '1') {
  cron.schedule(`*/${WINDOW} * * * *`, tick);
  console.log(`scheduler running, checking every ${WINDOW} minutes`);
  tick();
}
