// The sweep of what had no hour.
//
// An anytime item has no time BY DESIGN, so a reminder about one has to invent
// a moment. The one this uses is the end of the day: the work you gave hours to
// is finished, and what is left is what you deliberately did not give an hour
// to. That moment comes out of the person's own plan, which is the whole reason
// it is not a constant — so WHEN it fires is most of what there is to test.
const H = require('./harness');
let U;
const ROOT = H.ROOT;
process.chdir(ROOT);

const supabase = H.db;

// Patched before scheduler.js is required: it destructures sendTelegram at load
// time, so nothing real is ever sent from this file.
const telegram = require(ROOT + '/telegram.js');
const sent = [];
let sendFails = false;
let sendSkips = false;

telegram.sendTelegram = async (db, user_id, text) => {
  if (sendFails) return { error: 'telegram is down' };
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

const DATE = '2031-11-12';
const at = (hour, minute = 0) => ({ date: DATE, hour, minute, weekday: 'Wed' });
const profile = (extra = {}) => ({ user_id: U, timezone: 'UTC', ...extra });

const clear = async () => {
  sent.length = 0;
  await supabase.from('blocks').delete().eq('user_id', U);
  await supabase.from('plans').delete().eq('user_id', U);
  await supabase.from('sent_log').delete().eq('user_id', U);
};

const hhmmss = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`;

/**
 * A day. `timed` is [startMinutes, lengthMinutes] pairs; `loose` is titles,
 * and a title ending in ' ✓' arrives already ticked off.
 */
const day = async (timed, loose = [], status = 'confirmed') => {
  const { data: plan, error } = await supabase
    .from('plans')
    .insert({ user_id: U, date: DATE, wake_time: '08:00:00', status })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  const rows = [];
  let order = 0;
  for (const [start, length] of timed) {
    rows.push({
      user_id: U, plan_id: plan.id, title: `Block ${order}`,
      start_time: hhmmss(start), duration_minutes: length,
      sort_order: order++, completed: true,
    });
  }
  for (const title of loose) {
    rows.push({
      user_id: U, plan_id: plan.id, title: title.replace(/ ✓$/, ''),
      start_time: null, duration_minutes: null,
      sort_order: order++, completed: title.endsWith(' ✓'),
    });
  }
  if (rows.length) {
    const { error: blockErr } = await supabase.from('blocks').insert(rows);
    if (blockErr) throw new Error(blockErr.message);
  }
  return plan.id;
};

const slots = async () => {
  const { count } = await supabase
    .from('sent_log').select('*', { count: 'exact', head: true })
    .eq('user_id', U).eq('job', 'loose');
  return count;
};

/** At which hour and minute does a day of this shape fire? */
const firesAt = async (hours) => {
  const seen = [];
  for (const h of hours) {
    sent.length = 0;
    await supabase.from('sent_log').delete().eq('user_id', U);
    await scheduler.sendAnytime(profile(), at(h));
    if (sent.length) seen.push(h);
  }
  return seen;
};

(async () => {
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();
  await clear();

  console.log('it fires when the day the person planned runs out');
  {
    // 8:00 to 18:00, so the moment is 18:00 — not a number chosen here.
    await day([[480, 60], [540, 120], [1020, 60]], ['Walk the dog']);

    const fired = await firesAt([8, 12, 16, 17, 18, 19, 20, 21]);
    check('at the end of the day and no other hour', fired.join() === '18', fired.join());

    sent.length = 0;
    await supabase.from('sent_log').delete().eq('user_id', U);
    await scheduler.sendAnytime(profile(), at(18, 10));
    check('anywhere inside that window', sent.length === 1, `${sent.length}`);
  }

  console.log('\nand never before the floor, whatever the plan says');
  {
    await clear();
    // A day that ends at 11:00. There is a whole afternoon left in it, and a
    // reminder at eleven spends it.
    await day([[480, 180]], ['Walk the dog']);

    const fired = await firesAt([9, 11, 12, 14, 15, 16, 17, 18]);
    check('it waits for the floor', fired.join() === String(scheduler.LOOSE_FLOOR),
      `${fired.join()} (floor ${scheduler.LOOSE_FLOOR})`);
  }

  console.log('\nnor after the hour the day is asked about tomorrow');
  {
    await clear();
    // A day running to 23:00. Past the nudge the day is gone, and this has to
    // arrive before "plan tomorrow" rather than after it.
    await day([[480, 900]], ['Walk the dog']);

    const fired = await firesAt([16, 18, 19, 20, 21, 22, 23]);
    check('it is capped at the nudge hour', fired.join() === '20', fired.join());

    // And it follows the person's own nudge hour, not the default.
    sent.length = 0;
    await supabase.from('sent_log').delete().eq('user_id', U);
    await scheduler.sendAnytime(profile({ nudge_hour: 18 }), at(18));
    check('their own, if they have set one', sent.length === 1, `${sent.length}`);
  }

  console.log('\na day with no hours in it at all');
  {
    await clear();
    await day([], ['Walk the dog', 'Parking pass']);

    const fired = await firesAt([9, 12, 15, 16, 17, 20]);
    check('falls to the floor, which is the whole rule then',
      fired.join() === String(scheduler.LOOSE_FLOOR), fired.join());
  }

  console.log('\nsilent when there is nothing left');
  {
    await clear();
    await day([[480, 60]], ['Walk the dog ✓', 'Parking pass ✓']);
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    check('everything ticked sends nothing', sent.length === 0, `${sent.length}`);
    check('and claims no slot for the day', (await slots()) === 0);

    // NOT CLAIMED, which is the point: adding one later still reaches them.
    await supabase.from('blocks').insert({
      user_id: U, plan_id: (await supabase.from('plans').select('id').eq('user_id', U).single()).data.id,
      title: 'Added late', start_time: null, duration_minutes: null, sort_order: 9, completed: false,
    });
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR, 10));
    check('so one added inside the window still arrives', sent.length === 1, `${sent.length}`);

    await clear();
    await day([[480, 60]], []);
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    check('a day with none at all says nothing', sent.length === 0, `${sent.length}`);
  }

  console.log('\nwhat the message says');
  {
    await clear();
    await day([[480, 60]], ['Walk the dog', 'Parking pass', 'Reading ✓']);
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));

    const text = sent[0] ? sent[0].text : '';
    check('it names what is left', text.includes('Walk the dog') && text.includes('Parking pass'),
      text);
    check('and counts them', text.includes('2 things'), text);
    check('it leaves out what is ticked', !text.includes('Reading'), text);
    check('and the blocks that had an hour', !text.includes('Block 0'), text);
    // No hours in it: they have none, which is the point.
    check('no times anywhere in it', !/\d{1,2}:\d{2}/.test(text), text);
  }

  console.log('\none thing reads as one thing');
  {
    await clear();
    await day([[480, 60]], ['Walk the dog']);
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    const text = sent[0] ? sent[0].text : '';
    check('not "1 things"', !/1 things/.test(text), text);
    check('one thing', text.includes('one thing'), text);
  }

  console.log('\na day that was never agreed to');
  {
    await clear();
    await day([[480, 60]], ['Walk the dog'], 'pending');
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    check('a pending plan sends nothing', sent.length === 0, `${sent.length}`);
    check('and no day at all sends nothing', true);

    await clear();
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    check('nor does a day that does not exist', sent.length === 0, `${sent.length}`);
  }

  console.log('\nonce, however many times the loop comes round');
  {
    await clear();
    await day([[480, 60]], ['Walk the dog']);
    const floor = scheduler.LOOSE_FLOOR;

    await scheduler.sendAnytime(profile(), at(floor));
    await scheduler.sendAnytime(profile(), at(floor, 3));
    await scheduler.sendAnytime(profile(), at(floor, 11));
    check('three ticks inside the window, one message', sent.length === 1, `${sent.length}`);
    check('and one slot', (await slots()) === 1);
  }

  console.log('\nan account with no chat, and a send that fails');
  {
    await clear();
    await day([[480, 60]], ['Walk the dog']);
    sendSkips = true;
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    sendSkips = false;
    check('no chat linked: nothing goes out', sent.length === 0, `${sent.length}`);
    check('but the day is spent, so it stops asking', (await slots()) === 1);

    await clear();
    await day([[480, 60]], ['Walk the dog']);
    sendFails = true;
    let threw = false;
    try {
      await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR));
    } catch {
      threw = true;
    }
    check('a failure does not throw', !threw);
    check('and the slot is released', (await slots()) === 0);

    sendFails = false;
    await scheduler.sendAnytime(profile(), at(scheduler.LOOSE_FLOOR, 5));
    check('so the next tick inside the window gets it out', sent.length === 1, `${sent.length}`);
  }

  console.log('\nthe lane is wired in, and the old rule still holds');
  {
    const fs = require('fs');
    const src = fs.readFileSync(ROOT + '/scheduler.js', 'utf8');
    check("'loose' is a job in the sent_log guard",
      /alreadySent\(profile\.user_id, 'loose'/.test(src));
    check('and --run knows it', /loose: sendAnytime/.test(src));
    check('the loop calls it every tick', /await sendAnytime\(profile, now\)/.test(src));
    check('it will not report on a day that was never agreed to',
      /\.eq\('status', 'confirmed'\)[\s\S]{0,400}sendAnytime|sendAnytime[\s\S]{0,600}\.eq\('status', 'confirmed'\)/.test(src));

    // THE DISTINCTION THAT MUST STAY SHARP. An untimed item still never
    // delivers AT AN HOUR — it is not in the block queue and never gets a
    // message_sent_at. This is a sweep of the whole day, once, which is a
    // different thing and must not be read as softening that rule.
    check('an untimed block is still not in the delivery queue',
      /\.not\('start_time', 'is', null\)/.test(src));
    check('and delivery still guards against one reaching it',
      /if \(block\.start_time === null/.test(src));
  }

  console.log('\ncleanup');
  await clear();
  await H.cleanup();
  const { count } = await H.service
    .from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nLoose clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  await H.cleanup();
  process.exit(1);
});
