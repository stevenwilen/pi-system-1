// What has been shouting for too long.
//
// A '!!!' says the room has run out. It says it on the day the room ran out and
// it says exactly the same thing a year later, because it is three buckets and
// the bottom one has no floor. So a thing could sit at the loudest the system
// can shout for ever, and the shout stopped meaning anything in the second week.
//
// THIS IS THE ONLY JOB THAT MOVES A ROW NOBODY ASKED IT TO. Every other lane
// reads and sends. So the cases that matter are not really about the message:
// they are about what it refuses to touch, and about it never touching a thing
// twice.
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
const { CADENCE_DAYS, DAYS_NEEDED, WARN_UNITS, SWEEP_UNITS } = require(ROOT + '/warning.js');

/**
 * How old a habit must be to have rotted for `rotted` days.
 *
 * DERIVED, NOT WRITTEN DOWN. These fixtures sat on either side of a boundary
 * that moved the first time the multiplier was tuned, and a fixture one day
 * from a threshold is exactly the kind that passes for the wrong reason after
 * a change like that. Read off the same constants the code uses and the two
 * cannot drift apart.
 *
 * '!!!' begins at three cadences — see markFor — and everything past that is
 * rot.
 */
const habitAged = (frequency, rotted) => 3 * CADENCE_DAYS[frequency] + rotted;

/** Rot days that must be warned about, and rot days that must be swept. */
const warnAt = (frequency) => CADENCE_DAYS[frequency] * WARN_UNITS;
const sweepAt = (frequency) => CADENCE_DAYS[frequency] * SWEEP_UNITS;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const DATE = '2031-09-10';
const at = (hour, minute = 0) => ({ date: DATE, hour, minute, weekday: 'Wed' });
const profile = () => ({ user_id: U, timezone: 'UTC' });

/** A date `days` before the fixture's today. */
const back = (days) => {
  const d = new Date(`${DATE}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const clear = async () => {
  await supabase.from('sent_log').delete().eq('user_id', U);
  await supabase.from('entries').delete().eq('user_id', U);
  sent.length = 0;
};

/**
 * A row aged on purpose.
 *
 * `created_at` is what staleness measures from when nothing has been scheduled,
 * so a habit's age is set by backdating it. A dated row is aged by its due date
 * instead, which is what its own clock runs on.
 */
const make = async (fields, agedDays = 0) => {
  const { data, error } = await supabase
    .from('entries')
    .insert({
      user_id: U,
      status: 'active',
      created_at: new Date(Date.parse(`${DATE}T12:00:00Z`) - agedDays * 86400000).toISOString(),
      ...fields,
    })
    .select('id, title')
    .single();
  if (error) throw new Error(`could not make ${fields.title}: ${error.message}`);
  return data;
};

const stateOf = async (id) => {
  const { data } = await supabase
    .from('entries').select('status, paused_at, priority').eq('id', id).maybeSingle();
  return data || {};
};

(async () => {
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();
  await clear();

  // --- the rows it moves ----------------------------------------------------

  console.log('what is far gone is set aside, and what is nearly gone is warned about');
  {
    // Four daily habits, one in each state the sweep can be in, and each set
    // exactly on its threshold rather than vaguely near it.
    const gone = await make({ type: 'habit', title: 'Stretch', frequency: 'daily' },
      habitAged('daily', sweepAt('daily')));
    const nearly = await make({ type: 'habit', title: 'Spanish', frequency: 'daily' },
      habitAged('daily', warnAt('daily')));
    // Loud, and nowhere near the end of its rope: '!!!' as of today.
    const shouting = await make({ type: 'habit', title: 'Reading', frequency: 'daily' },
      habitAged('daily', 0));
    // Not even '!!!'.
    const fine = await make({ type: 'habit', title: 'Piano', frequency: 'daily' }, 1);

    await scheduler.sweepRotting(profile(), at(11));

    check('the far gone one is set aside', (await stateOf(gone.id)).paused_at !== null);
    check('and is still active, not deleted', (await stateOf(gone.id)).status === 'active',
      (await stateOf(gone.id)).status);

    check('the nearly gone one is left where it is', (await stateOf(nearly.id)).paused_at === null);
    check('so is the one that only just turned', (await stateOf(shouting.id)).paused_at === null);
    check('and so is the one inside its rhythm', (await stateOf(fine.id)).paused_at === null);

    check('one message went out', sent.length === 1, String(sent.length));
    const text = sent[0] ? sent[0].text : '';
    check('it names what was set aside', text.includes('Stretch'), JSON.stringify(text));
    check('and what is about to be', text.includes('Spanish'), JSON.stringify(text));
    check('it does not name the one that only just turned', !text.includes('Reading'), JSON.stringify(text));
    check('nor the one that is fine', !text.includes('Piano'), JSON.stringify(text));

    // NOTHING IS LOST, and the message has to say so. A thing that vanishes
    // without being told where it went is indistinguishable from one deleted.
    check('and it says where they went and how to get them back',
      /Saved for later/.test(text) && /back/.test(text), JSON.stringify(text));

    await clear();
  }

  console.log('\neach kind is measured against its own clock');
  {
    // The same number of days means different things to different rows, which
    // is the whole design. A weekly habit at 42 days is exactly as far gone as
    // a daily one at 6.
    const weeklyGone = await make({ type: 'habit', title: 'Weekly gone', frequency: 'weekly' },
      habitAged('weekly', sweepAt('weekly')));
    const weeklySafe = await make({ type: 'habit', title: 'Weekly safe', frequency: 'weekly' },
      habitAged('weekly', sweepAt('weekly') - 1));
    // The same number of days that would sweep a weekly one, and nowhere near
    // enough for a monthly: it is not even '!!!' until ninety.
    const monthlySafe = await make({ type: 'habit', title: 'Monthly safe', frequency: 'monthly' },
      habitAged('weekly', sweepAt('weekly')));

    // A task whose length is a day, well past its deadline.
    const taskGone = await make({
      type: 'task', title: 'Task gone', due: back(4), size: 'a day',
    });
    // A project of months, the same number of days past its deadline — nowhere
    // near gone, because its own unit is forty days.
    const projectSafe = await make({
      type: 'project', title: 'Project safe', due: back(4), size: 'months',
    });

    await scheduler.sweepRotting(profile(), at(11));

    check('a weekly habit at its own sweep point is set aside',
      (await stateOf(weeklyGone.id)).paused_at !== null);
    check('one day short of it is not', (await stateOf(weeklySafe.id)).paused_at === null);
    check('the same age is nothing at all to a monthly one',
      (await stateOf(monthlySafe.id)).paused_at === null,
      `${habitAged('weekly', sweepAt('weekly'))} days, and monthly is not !!! until ${3 * CADENCE_DAYS.monthly}`);

    check('a day-long task four days past its deadline is set aside',
      (await stateOf(taskGone.id)).paused_at !== null);
    check('a months-long project the same four days past its own is not',
      (await stateOf(projectSafe.id)).paused_at === null,
      `unit is ${DAYS_NEEDED.months} days`);

    await clear();
  }

  // --- the rows it refuses to touch -----------------------------------------

  console.log('\nwhat it will not touch, however far gone');
  {
    const pinned = await make({ type: 'habit', title: 'Pinned', frequency: 'daily', priority: 1 }, 90);
    const saved = await make({
      type: 'habit', title: 'Already saved', frequency: 'daily', paused_at: new Date().toISOString(),
    }, 90);
    const undated = await make({ type: 'task', title: 'No deadline' }, 400);
    const noLength = await make({ type: 'task', title: 'No length', due: back(200) }, 400);

    await scheduler.sweepRotting(profile(), at(11));

    // A PIN IS SOMEBODY SAYING "THIS ONE" OUTRIGHT. Overruling it on a timer
    // would be the system arguing with a decision it was told about.
    check('a pinned thing is never swept', (await stateOf(pinned.id)).paused_at === null);
    check('and is never even mentioned',
      !sent.some((s) => s.text.includes('Pinned')), sent.map((s) => s.text).join(' | '));

    check('something already set aside is left alone',
      (await stateOf(saved.id)).status === 'active');

    // NOTHING TO MEASURE IS NOT THE SAME AS FINE — but it is the same as
    // nothing to do. A task with no deadline is never '!!!' at all, however
    // old, because nothing about it is running out.
    check('a task with no deadline is never swept, however old',
      (await stateOf(undated.id)).paused_at === null);
    check('nor one with a deadline and no length',
      (await stateOf(noLength.id)).paused_at === null);

    check('and with nothing to say, nothing is sent', sent.length === 0,
      sent.map((s) => s.text).join(' | '));

    await clear();
  }

  // --- it says it once ------------------------------------------------------

  console.log('\nit runs once a day, and never moves the same row twice');
  {
    const gone = await make({ type: 'habit', title: 'Stretch', frequency: 'daily' }, habitAged('daily', sweepAt('daily')));

    await scheduler.sweepRotting(profile(), at(11));
    check('the first run moves it', (await stateOf(gone.id)).paused_at !== null);
    check('and sends one message', sent.length === 1, String(sent.length));

    const movedAt = (await stateOf(gone.id)).paused_at;

    sent.length = 0;
    await scheduler.sweepRotting(profile(), at(11, 10));
    check('a second run the same day sends nothing', sent.length === 0, String(sent.length));
    check('and does not move it again', (await stateOf(gone.id)).paused_at === movedAt);

    await clear();
  }

  console.log('\nit keeps to its hour');
  {
    const gone = await make({ type: 'habit', title: 'Stretch', frequency: 'daily' }, habitAged('daily', sweepAt('daily')));

    await scheduler.sweepRotting(profile(), at(3));
    check('nothing happens at three in the morning',
      (await stateOf(gone.id)).paused_at === null && sent.length === 0);

    await scheduler.sweepRotting(profile(), at(23));
    check('nor late at night',
      (await stateOf(gone.id)).paused_at === null && sent.length === 0);

    await scheduler.sweepRotting(profile(), at(11));
    check('and it does happen at its own hour', (await stateOf(gone.id)).paused_at !== null);

    await clear();
  }

  console.log('\nthe tidying happens whether or not a phone is listening');
  {
    // The rows move first and the message goes after, so somebody with no
    // Telegram linked still gets the tidying — they read about it on the list
    // instead of on a phone.
    sendSkips = true;
    const gone = await make({ type: 'habit', title: 'Stretch', frequency: 'daily' }, habitAged('daily', sweepAt('daily')));

    await scheduler.sweepRotting(profile(), at(11));
    check('it is still set aside with nowhere to send', (await stateOf(gone.id)).paused_at !== null);
    check('and nothing was sent', sent.length === 0);
    sendSkips = false;

    await clear();
  }

  console.log('\ncleanup');
  await clear();
  const { count } = await H.service
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nRot clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message, '\n', (e.stack || '').split('\n').slice(0, 4).join('\n'));
  try { await clear(); } catch {}
  process.exit(1);
});
