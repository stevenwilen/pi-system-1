// Outbound delivery, on a timer.
//
// The eight weekly digest jobs are gone. What replaces them is per-block
// delivery: at each block's start time, send the text the brain already wrote
// and stored at confirm time. See SPEC section 5.
//
// That delivery is NOT built yet. It needs columns on `blocks` that do not
// exist, so this file currently carries the machinery and nothing to fire.
// Everything here is used by the real thing when it lands.
//
// Run: node scheduler.js

require('dotenv').config();

const cron = require('node-cron');

const supabase = require('./db');
const { sendTelegram } = require('./telegram');

// The tick interval, in minutes.
//
// Blocks sit on 30-minute boundaries, so the final value has to divide into
// that cleanly. It is deliberately still 15 rather than 30: a tick that only
// fires on the boundary must be exactly on time or it misses, whereas a
// shorter tick that asks "which blocks have started and not been sent" is
// self-correcting after a restart. Settled when delivery is built.
const WINDOW = 15;

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

// Walks every user in their own timezone. Nothing is due yet: the query that
// finds started-but-unsent blocks needs columns that do not exist.
async function tick() {
  let profiles;
  try {
    profiles = await allProfiles();
  } catch (err) {
    console.error(err.message);
    return;
  }

  for (const profile of profiles) {
    try {
      localNow(profile.timezone);
    } catch {
      console.error(
        `skipping ${profile.user_id}: bad timezone ${profile.timezone}`
      );
      continue;
    }

    // Block delivery goes here.
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
};

// Starting the loop on require is deliberate: server.js requires this module
// so the web process and the scheduler share one Railway service.
cron.schedule(`*/${WINDOW} * * * *`, tick);
console.log(`scheduler running, checking every ${WINDOW} minutes`);
console.log('no delivery wired yet: per-block sending is not built');
tick();
