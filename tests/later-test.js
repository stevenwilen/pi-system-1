// The Wednesday look at what was set down.
//
// Things saved for later leave the Things list on purpose, and the whole risk
// of that is that leaving the list is indistinguishable from being forgotten.
// This job is the only thing that goes looking for them, so the two conditions
// that matter are WHEN it fires and whether it ever fires over nothing.
//
// A message that arrives every Wednesday regardless of the list teaches you to
// stop reading it, and the week it finally matters is the week it goes unread.
const H = require('./harness');
let U;
const ROOT = H.ROOT;
process.chdir(ROOT);

const supabase = H.db;

// Patched before scheduler.js is required: it destructures sendTelegram at
// load time, so nothing real is ever sent from this file.
const telegram = require(ROOT + '/telegram.js');
const sent = [];
let sendFails = false;
let sendSkips = false;

telegram.sendTelegram = async (db, user_id, text) => {
  if (sendFails) return { error: 'telegram is down' };
  // What sendTelegram really answers for an account with no chat linked. Not
  // an error: there is nothing to retry and nothing wrong.
  if (sendSkips) return { skipped: 'no chat linked' };
  sent.push({ user_id, text });
  return { sent: true, stubbed: true };
};

const scheduler = require(ROOT + '/scheduler.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const DATE = '2031-10-08'; // a Wednesday, and nothing else in the suite uses it
const at = (hour, minute = 0, weekday = 'Wed') => ({ date: DATE, hour, minute, weekday });
const profile = (extra = {}) => ({ user_id: U, timezone: 'UTC', ...extra });

const clear = async () => {
  sent.length = 0;
  await supabase.from('entries').delete().eq('user_id', U);
  await supabase.from('sent_log').delete().eq('user_id', U);
};

/** A thing on the list. `set` gives it a paused_at, which is what saves it. */
const add = async (title, { set = false, status = 'active' } = {}) => {
  const { error } = await supabase.from('entries').insert({
    user_id: U,
    type: 'task',
    title,
    status,
    paused_at: set ? new Date().toISOString() : null,
  });
  if (error) throw new Error(error.message);
};

const slots = async () => {
  const { count } = await supabase
    .from('sent_log').select('*', { count: 'exact', head: true })
    .eq('user_id', U).eq('job', 'later');
  return count;
};

(async () => {
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();
  await clear();

  console.log('nothing set down, nothing sent');
  {
    // THE CONDITION THE USER ASKED FOR FIRST. An empty list is not a small
    // message, it is no message.
    await add('still on the list');
    await add('also still on the list');

    await scheduler.sendSavedForLater(profile(), at(17));
    check('a list with nothing saved sends nothing', sent.length === 0, `${sent.length}`);

    // AND IT TAKES NO SLOT. If silence claimed the day, someone who sets
    // something down at ten past five would wait a week to hear about it.
    check('and claims no slot for the day', (await slots()) === 0);

    await add('set this one down', { set: true });
    await scheduler.sendSavedForLater(profile(), at(17, 10));
    check('so setting one down at ten past five still reaches them',
      sent.length === 1, `${sent.length}`);
  }

  console.log('\nwhat the message says');
  {
    await clear();
    await add('Learn guitar', { set: true });
    await add('Fix the bike', { set: true });
    await add('busy with this one');
    // Done and dropped things keep their paused_at — the column is not
    // cleared when a thing leaves — so status is what decides.
    await add('Finished long ago', { set: true, status: 'done' });

    await scheduler.sendSavedForLater(profile(), at(17));
    check('one message', sent.length === 1, `${sent.length}`);

    const text = sent[0] ? sent[0].text : '';
    check('it names what is saved', text.includes('Learn guitar') && text.includes('Fix the bike'), text);
    check('and counts them', text.includes('2 things'), text);
    check('it leaves out what is still on the list', !text.includes('busy with this one'), text);
    check('and what is finished', !text.includes('Finished long ago'), text);
  }

  console.log('\none thing reads as one thing');
  {
    await clear();
    await add('Read Dune', { set: true });
    await scheduler.sendSavedForLater(profile(), at(17));
    const text = sent[0] ? sent[0].text : '';
    check('not "1 things"', !/1 things/.test(text), text);
    check('one thing', text.includes('one thing'), text);
  }

  console.log('\nWednesday at five, and no other time');
  {
    await clear();
    await add('Learn guitar', { set: true });

    for (const day of ['Mon', 'Tue', 'Thu', 'Fri', 'Sat', 'Sun']) {
      await scheduler.sendSavedForLater(profile(), at(17, 0, day));
    }
    check('no other day of the week sends it', sent.length === 0, `${sent.length}`);

    for (const hour of [9, 12, 16, 18, 21]) {
      await scheduler.sendSavedForLater(profile(), at(hour));
    }
    check('nor any other hour of Wednesday', sent.length === 0, `${sent.length}`);

    await scheduler.sendSavedForLater(profile(), at(17, 5));
    check('five o'.concat("'clock does"), sent.length === 1, `${sent.length}`);
  }

  console.log('\nonce, however many times the loop comes round');
  {
    await clear();
    await add('Learn guitar', { set: true });

    await scheduler.sendSavedForLater(profile(), at(17));
    await scheduler.sendSavedForLater(profile(), at(17, 2));
    await scheduler.sendSavedForLater(profile(), at(17, 9));
    check('three ticks inside the window, one message', sent.length === 1, `${sent.length}`);
    check('and one slot', (await slots()) === 1);
  }

  console.log('\nan account with no chat linked');
  {
    await clear();
    await add('Learn guitar', { set: true });
    sendSkips = true;

    let threw = false;
    try {
      await scheduler.sendSavedForLater(profile(), at(17));
    } catch {
      threw = true;
    }
    sendSkips = false;

    check('does not throw', !threw);
    check('and nothing goes out', sent.length === 0, `${sent.length}`);
    // The slot stays taken: there is nothing to retry, and releasing it would
    // mean trying again every tick for the rest of the window.
    check('but the day is spent, so it stops asking', (await slots()) === 1);
  }

  console.log('\na send that fails is tried again');
  {
    await clear();
    await add('Learn guitar', { set: true });
    sendFails = true;

    let threw = false;
    try {
      await scheduler.sendSavedForLater(profile(), at(17));
    } catch {
      threw = true;
    }
    check('a failure does not throw', !threw);
    check('and nothing was recorded as sent', sent.length === 0, `${sent.length}`);
    check('the slot is released', (await slots()) === 0);

    sendFails = false;
    await scheduler.sendSavedForLater(profile(), at(17, 4));
    check('so the next tick inside the window gets it out', sent.length === 1, `${sent.length}`);
  }

  console.log('\nthe job is wired in, not just written');
  {
    const fs = require('fs');
    const src = fs.readFileSync(ROOT + '/scheduler.js', 'utf8');
    check("'later' is a job in the sent_log guard",
      /alreadySent\(profile\.user_id, 'later'/.test(src));
    check('and --run knows it', /later: sendSavedForLater/.test(src));
    check('the loop calls it every tick', /await sendSavedForLater\(profile, now\)/.test(src));
    check('it reads entries and nothing else', /not\('paused_at', 'is', null\)/.test(src));
    check('and only active ones', /\.eq\('status', 'active'\)[\s\S]{0,80}not\('paused_at'/.test(src));
  }

  console.log('\ncleanup');
  await clear();
  await H.cleanup();
  const { count } = await H.service
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nLater clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  await H.cleanup();
  process.exit(1);
});
