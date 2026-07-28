// The evening nudge.
//
// The condition is the whole feature: it must never fire on a day the person
// has already planned. Everything else here is the wording.
//
// Needs migration-nudge.sql for the window and profile checks; the rest runs
// without it.
const H = require('./harness');
const U = H.TEST_USER_ID;
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
telegram.sendTelegram = async (user_id, text) => {
  if (sendFails) return { error: 'telegram is down' };
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

const makeEntry = async (fields) => {
  const { data, error } = await supabase
    .from('entries')
    .insert({ user_id: U, status: 'active', ...fields })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id;
};

(async () => {
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

  console.log('\nwhat it names');
  {
    await clear();
    // Ranked 0..3. Two cold, one cold habit, one cold but paused.
    await makeEntry({ type: 'task', title: 'Reading', sort_order: 0, cold: true });
    await makeEntry({ type: 'project', title: 'Spanish', why: 'x', sort_order: 1, cold: true });
    await makeEntry({ type: 'habit', title: 'Gym', frequency: 'daily', sort_order: 2, cold: true });
    await makeEntry({
      type: 'task', title: 'Dentist', sort_order: 3, cold: true,
      paused_at: new Date().toISOString(),
    });

    const text = await scheduler.composeNudge(U);
    const lines = text.split('\n');
    check('two lines, no more', lines.length === 2, JSON.stringify(lines));
    check('the first is always the same', lines[0] === 'No plan for tomorrow yet.');
    check('two cold priorities are named together', lines[1] === 'Reading and Spanish have gone quiet.', lines[1]);
    check('a cold habit is not named', !text.includes('Gym'));
    check('a paused item is not named, cold flag or not', !text.includes('Dentist'));
  }

  console.log('\none, several, none');
  {
    await clear();
    await makeEntry({ type: 'task', title: 'Reading', sort_order: 0, cold: true });
    check('one reads singular', (await scheduler.composeNudge(U)).split('\n')[1] === 'Reading has gone quiet.',
      (await scheduler.composeNudge(U)).split('\n')[1]);

    await clear();
    // Four cold at four different ages. The two named must be the two left
    // longest, which is the pair the panel puts at the top of the list.
    const ago = (n) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString();
    };
    for (const [t, days] of [['Freshest', 1], ['Oldest', 40], ['Middling', 8], ['Next oldest', 25]]) {
      await makeEntry({ type: 'task', title: t, cold: true, created_at: ago(days) });
    }
    const many = await scheduler.composeNudge(U);
    check('four cold still names only two',
      many.split('\n')[1] === 'Oldest and Next oldest have gone quiet.', many.split('\n')[1]);
    check('and they are the two left longest',
      !many.includes('Middling') && !many.includes('Freshest'));

    await clear();
    await makeEntry({ type: 'task', title: 'Warm', sort_order: 0, cold: false });
    const alone = await scheduler.composeNudge(U);
    check('nothing cold means one line only', alone === 'No plan for tomorrow yet.', JSON.stringify(alone));
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

  console.log('\nno model call anywhere in this path');
  {
    const fs = require('fs');
    const src = fs.readFileSync(ROOT + '/scheduler.js', 'utf8');
    const nudge = src.slice(src.indexOf('async function composeNudge'), src.indexOf('async function tick'));
    check('the nudge does not reach the brain', !/runBrain|anthropic/i.test(nudge));
    check('nor call the judge', !/\bjudge\(/.test(nudge));
    check('it only reads rows and sends', /from\('entries'\)/.test(nudge) && /from\('plans'\)/.test(nudge));
    check("'nudge' is a job in the sent_log guard", /alreadySent\(profile\.user_id, 'nudge'/.test(src));
    check('and --run knows it', /nudge: sendNudge/.test(src));
  }

  console.log('\ncleanup');
  await clear();
  await H.cleanup();
  const { count } = await H.raw
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nNudge clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  await H.cleanup();
  process.exit(1);
});
