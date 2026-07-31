// The evening nudge.
//
// The condition is the whole feature: it must never fire on a day the person
// has already planned. Everything else here is the wording.
//
// Needs migration-nudge.sql for the window and profile checks; the rest runs
// without it.
const H = require('./harness');
// The test account, discovered rather than written down. It is a real auth
// user now, created by the harness, so its id is not knowable until it
// exists — which is why this is assigned inside the run rather than at the
// top of the file.
let U;
const ROOT = H.ROOT;
process.chdir(ROOT);

const supabase = H.db;

// Patched before scheduler.js is required: it destructures sendTelegram at
// load time, so nothing real is ever sent from this file.
// One stub, installed once, whose behaviour is switched by a variable.
// Reassigning telegram.sendTelegram later does nothing: scheduler.js
// destructures it at load, so the binding it holds is already fixed.
const telegram = require(ROOT + '/telegram.js');
const sent = [];
let sendFails = false;

// How long the stubbed send takes. Zero everywhere except the case about two
// ticks overlapping, where the window being tested is exactly as wide as this
// call — an instant stub closes it and the case proves nothing.
let sendDelay = 0;

telegram.sendTelegram = async (user_id, text) => {
  if (sendFails) return { error: 'telegram is down' };
  if (sendDelay) await new Promise((r) => setTimeout(r, sendDelay));
  sent.push({ user_id, text });
  return { sent: true, stubbed: true };
};

const scheduler = require(ROOT + '/scheduler.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const DATE = '2031-09-10';
const TOMORROW = '2031-09-11';
const at = (hour, minute = 0) => ({ date: DATE, hour, minute, weekday: 'Wed' });
const profile = (extra = {}) => ({ user_id: U, timezone: 'UTC', ...extra });

const clear = async () => {
  sent.length = 0;
  await supabase.from('blocks').delete().eq('user_id', U);
  await supabase.from('plans').delete().eq('user_id', U);
  await supabase.from('entries').delete().eq('user_id', U);
  await supabase.from('sent_log').delete().eq('user_id', U);
};

const makePlan = async (date, status) => {
  const { error } = await supabase
    .from('plans')
    .insert({ user_id: U, date, wake_time: '08:00:00', status });
  if (error) throw new Error(error.message);
};

(async () => {
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();
  await clear();

  console.log('the condition: it never fires on a day already planned');
  {
    await makePlan(TOMORROW, 'confirmed');
    await scheduler.sendNudge(profile(), at(20), { force: true });
    check('a confirmed plan for tomorrow sends nothing', sent.length === 0, JSON.stringify(sent));

    await clear();
    await makePlan(TOMORROW, 'pending');
    await scheduler.sendNudge(profile(), at(20), { force: true });
    check('a plan left pending still nudges', sent.length === 1, JSON.stringify(sent.map((s) => s.text)));

    // The trap: a plan confirmed for TODAY says nothing about tomorrow.
    await clear();
    await makePlan(DATE, 'confirmed');
    await scheduler.sendNudge(profile(), at(20), { force: true });
    check("today's plan does not count as tomorrow's", sent.length === 1, JSON.stringify(sent.map((s) => s.text)));

    await clear();
    await scheduler.sendNudge(profile(), at(20), { force: true });
    check('no plan at all nudges', sent.length === 1);
    check('and says so plainly', sent[0].text === 'No plan for tomorrow yet.', JSON.stringify(sent[0].text));
  }

  console.log('\nwhich day it asks about follows how this person plans');
  {
    const evening = (extra = {}) => profile({ plans_in: 'evening', ...extra });
    const morning = (extra = {}) => profile({ plans_in: 'morning', ...extra });

    // An evening planner is asked about tomorrow.
    await clear();
    await makePlan(TOMORROW, 'confirmed');
    await scheduler.sendNudge(evening(), at(20), { force: true });
    check('evening: tomorrow confirmed, so nothing', sent.length === 0, JSON.stringify(sent));

    await clear();
    await makePlan(DATE, 'confirmed');
    await scheduler.sendNudge(evening(), at(20), { force: true });
    check('evening: today confirmed is not tomorrow', sent.length === 1);
    check('and it names tomorrow', sent[0].text === 'No plan for tomorrow yet.', sent[0].text);

    // A morning planner is asked about the day they are in.
    await clear();
    await makePlan(DATE, 'confirmed');
    await scheduler.sendNudge(morning(), at(20), { force: true });
    check('morning: today confirmed, so nothing', sent.length === 0, JSON.stringify(sent));

    await clear();
    await makePlan(TOMORROW, 'confirmed');
    await scheduler.sendNudge(morning(), at(20), { force: true });
    check('morning: tomorrow confirmed is not today', sent.length === 1);
    check('and it names today', sent[0].text === 'No plan for today yet.', sent[0].text);

    // Null is the shape every row had before the column existed.
    await clear();
    await makePlan(TOMORROW, 'confirmed');
    await scheduler.sendNudge(profile({ plans_in: null }), at(20), { force: true });
    check('an unset preference reads as evening', sent.length === 0, JSON.stringify(sent));

    await clear();
    await scheduler.sendNudge(profile({ plans_in: null }), at(20), { force: true });
    check('and says so', sent[0].text === 'No plan for tomorrow yet.', sent[0].text);
  }

  console.log('\none line, and only one');
  {
    // It used to name what had gone quiet on a second line, which needed a
    // daily verdict written by a model call. That lane is gone, and a version
    // built from days-since alone would name something every single night —
    // a nudge that always fires is a digest.
    await clear();
    await scheduler.sendNudge(profile(), at(20), { force: true });
    check('exactly one line', sent[0].text.split('\n').length === 1, JSON.stringify(sent[0].text));
    check('it is the whole message', sent[0].text === scheduler.NUDGE_TEXT.evening, sent[0].text);
    check('nothing is named', !/quiet/.test(sent[0].text));
  }

  console.log('\nthe hour');
  {
    await clear();
    const fired = async (hour, extra) => {
      sent.length = 0;
      await supabase.from('sent_log').delete().eq('user_id', U);
      await scheduler.sendNudge(profile(extra), at(hour));
      return sent.length > 0;
    };

    check('fires at 20:00 by default', await fired(20));
    check('not at 19:00', !(await fired(19)));
    check('not at 21:00', !(await fired(21)));
    check('not at noon', !(await fired(12)));

    check('a profile hour is honoured', await fired(7, { nudge_hour: 7 }));
    check('and the default no longer fires', !(await fired(20, { nudge_hour: 7 })));
    check('null falls back to 20', await fired(20, { nudge_hour: null }));
    check('hour 0 is a real hour, not a missing one', await fired(0, { nudge_hour: 0 }));
  }

  console.log('\nsent once an evening, whatever restarts');
  {
    await clear();
    await scheduler.sendNudge(profile(), at(20));
    check('the first tick sends', sent.length === 1);

    await scheduler.sendNudge(profile(), at(20, 5));
    check('the next tick in the window does not', sent.length === 1, `${sent.length} sends`);

    const { data: log } = await supabase
      .from('sent_log').select('job, sent_for_date').eq('user_id', U).eq('job', 'nudge');
    check('one sent_log row claims the evening', log.length === 1, JSON.stringify(log));
    check('keyed to the day it fired on', log[0].sent_for_date === DATE, log[0].sent_for_date);
  }

  console.log('\na planned evening is claimed too, so it is not reconsidered');
  {
    await clear();
    await makePlan(TOMORROW, 'confirmed');
    await scheduler.sendNudge(profile(), at(20));
    check('still silent', sent.length === 0);
    const { count } = await supabase
      .from('sent_log').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('job', 'nudge');
    check('and the evening is marked resolved', count === 1, `${count}`);
  }

  console.log('\ntwo ticks at once nudge once');
  {
    // Same shape as the block duplicate. The sent_log row was written after
    // the send returned, so between reading "not sent yet" and writing it
    // there was a window as wide as the plan query plus the Telegram call.
    // A Railway deploy overlaps two containers, and scheduler.js ticks the
    // moment it is required, so a second caller really does arrive there.
    //
    // The unique constraint on (user_id, job, sent_for_date) has been the lock
    // the whole time — it was just being used as a receipt.
    await clear();
    await makePlan(TOMORROW, 'pending');
    sendDelay = 250;

    await Promise.all([
      scheduler.sendNudge(profile(), at(20)),
      scheduler.sendNudge(profile(), at(20)),
    ]);
    sendDelay = 0;

    check('one nudge, not two', sent.length === 1,
      `${sent.length}: ${JSON.stringify(sent.map((s) => s.text))}`);

    const { count } = await supabase
      .from('sent_log').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('job', 'nudge');
    check('and one row holding the slot', count === 1, `${count}`);
  }

  console.log('\nfailure behaviour');
  {
    await clear();
    sendFails = true;
    let threw = false;
    try {
      await scheduler.sendNudge(profile(), at(20));
    } catch {
      threw = true;
    }
    check('a failed send does not throw', !threw);
    check('and nothing was recorded as sent', sent.length === 0, `${sent.length}`);

    const { count } = await supabase
      .from('sent_log').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('job', 'nudge');
    check('and leaves no row, so the next tick retries', count === 0, `${count}`);

    sendFails = false;
    await scheduler.sendNudge(profile(), at(20));
    check('the retry then goes out', sent.length === 1, `${sent.length}`);
  }

  console.log('\nno model call anywhere in this file');
  {
    const fs = require('fs');
    const src = fs.readFileSync(ROOT + '/scheduler.js', 'utf8');
    check('the scheduler does not reach the brain', !/runBrain|anthropic/i.test(src));
    check('nor call a judge', !/\bjudge\(/.test(src));
    check('the nudge reads the plan row and nothing else', /from\('plans'\)/.test(src));
    check("'nudge' is a job in the sent_log guard", /alreadySent\(profile\.user_id, 'nudge'/.test(src));
    check('and --run knows it', /nudge: sendNudge/.test(src));
    check('the removed lanes are really gone', !/finance|coldness/i.test(src));
  }

  console.log('\ncleanup');
  await clear();
  await H.cleanup();
  const { count } = await H.service
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nNudge clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  await H.cleanup();
  process.exit(1);
});
