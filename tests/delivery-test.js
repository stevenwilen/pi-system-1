// Step 5, against real plans and blocks in the real database.
//
// The Telegram transport is stubbed. Everything else is real: real rows, real
// timezone maths, real state transitions. Sending genuine messages to the
// owner's phone is an outward-facing action and not mine to take unasked.
const H = require('./harness');
// The test account, discovered rather than written down. It is a real auth
// user now, created by the harness, so its id is not knowable until it
// exists — which is why this is assigned inside the run rather than at the
// top of the file.
let U;
process.env.SCHEDULER_DISABLED = '1';

// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const supabase = H.db;

// Patch before scheduler.js is required: it destructures sendTelegram at load
// time, so the patch has to be on the cached module first.
const telegram = require(ROOT + '/telegram.js');
const sent = [];

// How long the stubbed send takes. Zero for every ordinary case, because they
// only care what came out — but the window in which a block is sent and not
// yet marked is exactly as wide as this call, so a case about that window has
// to make it real. A Telegram round trip is a few hundred milliseconds; an
// instant stub closes the window the bug lives in.
let sendDelay = 0;

telegram.sendTelegram = async (user_id, text) => {
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

const made = [];
const hhmmss = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;

async function makePlan(date, status, blocks) {
  const { data: plan, error } = await supabase
    .from('plans')
    .insert({ user_id: U, date, wake_time: '08:00:00', status })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  made.push(plan.id);

  const rows = blocks.map((b, i) => ({
    user_id: U,
    plan_id: plan.id,
    sort_order: i,
    entry_id: null,
    pinned: false,
    note: null,
    message_sent_at: null,
    ...b,
  }));
  const { error: blockErr } = await supabase.from('blocks').insert(rows);
  if (blockErr) throw new Error(blockErr.message);
  return plan.id;
}

const statusOf = async (planId) => {
  const { data } = await supabase
    .from('blocks').select('title, message_sent_at').eq('plan_id', planId).order('sort_order');
  return data;
};

(async () => {
  // Refuses to run at all if the guard is not live.
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();

  const profile = (await scheduler.allProfiles()).find((p) => p.user_id === U);

  // Driven at a fixed midday rather than the real clock.
  //
  // The offsets below reach 90 minutes back, and `at` clamps to the start of
  // the day so it cannot produce a negative time. Run shortly after midnight
  // that clamp turned "90 minutes ago" into 00:00, which is only a few minutes
  // late and therefore still inside the grace window, so a block that had to
  // expire was delivered instead. The test failed for the first ninety minutes
  // of every day and passed for the other twenty-two and a half hours.
  //
  // Only the hour is synthetic. The date stays real, because that is what the
  // plan is written for.
  const today = scheduler.localNow(profile.timezone);
  const now = { ...today, hour: 12, minute: 0 };
  const nowMinutes = 12 * 60;
  console.log(`  driving ${now.date} at 12:00 ${profile.timezone} (really ${String(today.hour).padStart(2, '0')}:${String(today.minute).padStart(2, '0')})\n`);

  const at = (offset) => hhmmss(Math.max(0, Math.min(1439, nowMinutes + offset)));
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  console.log('a confirmed day');
  const planId = await makePlan(now.date, 'confirmed', [
    { title: 'Started with a note', start_time: at(-5), duration_minutes: 60,
      note: 'twenty pages, no phone', created_at: old },
    { title: 'Started, no note', start_time: at(-5), duration_minutes: 30, created_at: old },
    { title: 'Not started yet', start_time: at(60), duration_minutes: 30,
      note: 'Later.', created_at: old },
    { title: 'Long past', start_time: at(-90), duration_minutes: 30,
      note: 'Should never arrive.', created_at: old },
  ]);

  sent.length = 0;
  await scheduler.deliverDue(profile, now);

  const titles = sent.map((s) => s.text.match(/<b>(.*?)<\/b>/)[1]);
  check('sends the started block that has a note', titles.includes('Started with a note'));
  check('sends the started block without one', titles.includes('Started, no note'));
  check('does not send a block that has not started', !titles.includes('Not started yet'));
  check('does not send a block long past its time', !titles.includes('Long past'), titles.join(', '));
  check('exactly two went out', sent.length === 2, `${sent.length}`);

  // Twelve hour, the way it arrives on a phone. Built here rather than taken
  // from messages.js, so this is a second opinion on the format rather than
  // the same function agreeing with itself.
  const ampm = (mins) => {
    const at12 = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(at12 / 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(at12 % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };

  const withLine = sent.find((s) => s.text.includes('Started with a note'));
  check('message carries header then note',
    withLine.text === `<b>Started with a note</b>\n${ampm(nowMinutes - 5)} to ${ampm(nowMinutes + 55)}\n\ntwenty pages, no phone`,
    JSON.stringify(withLine.text));

  const bare = sent.find((s) => s.text.includes('no note'));
  check('fallback is the header alone', !bare.text.includes('\n\n'), JSON.stringify(bare.text));

  let state = await statusOf(planId);
  check('delivered blocks are marked sent', state[0].message_sent_at && state[1].message_sent_at);
  check('the future block is left queued', state[2].message_sent_at === null);
  check('the long-past block is retired without sending', state[3].message_sent_at !== null);

  console.log('\na second tick sends nothing again');
  sent.length = 0;
  await scheduler.deliverDue(profile, now);
  check('no duplicates', sent.length === 0, `${sent.length}`);

  console.log('\na block confirmed seconds ago goes straight out');
  {
    // There used to be a grace window here. The line was written by a model
    // call fired after the confirm response, so a block could exist for the
    // better part of a minute with no text yet, and delivering in that gap
    // would have stripped it to its header for ever. The line is composed in
    // code now and inserted with the block, so a block that exists has
    // whatever text it is ever going to have and there is nothing to wait for.
    const fresh = await makePlan('2031-06-02', 'confirmed', [
      {
        title: 'Just confirmed', start_time: at(-1), duration_minutes: 30,
        note: 'twenty pages, no phone', created_at: new Date().toISOString(),
      },
    ]);
    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-02' });
    check('it is sent on the first tick', sent.length === 1, `${sent.length} sent`);
    check('with its note', sent[0].text.endsWith('twenty pages, no phone'), JSON.stringify(sent[0] && sent[0].text));
    check('and marked sent', (await statusOf(fresh))[0].message_sent_at !== null);
  }

  console.log('\na block with no note is not a failure');
  {
    // A buffer block, or anything typed straight into the builder. It has no
    // entry behind it, so there is no date to count and nothing to say.
    const buffer = await makePlan('2031-06-03', 'confirmed', [
      { title: 'Buffer', start_time: at(-1), duration_minutes: 30, created_at: new Date().toISOString() },
    ]);
    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-03' });
    check('the header goes out on its own', sent.length === 1 && !sent[0].text.includes('\n\n'),
      JSON.stringify(sent[0] && sent[0].text));
    check('and it is marked sent, not retried', (await statusOf(buffer))[0].message_sent_at !== null);
  }

  console.log('\na pending day is never delivered');
  const pending = await makePlan('2031-06-04', 'pending', [
    { title: 'Never agreed to', start_time: at(-5), duration_minutes: 30, note: 'nope', created_at: old },
  ]);
  sent.length = 0;
  await scheduler.deliverDue(profile, { ...now, date: '2031-06-04' });
  check('nothing sent for an unconfirmed plan', sent.length === 0, `${sent.length}`);
  check('and its blocks stay queued', (await statusOf(pending))[0].message_sent_at === null);

  console.log('\nno plan at all');
  sent.length = 0;
  await scheduler.deliverDue(profile, { ...now, date: '2031-06-09' });
  check('a day with no plan is quiet', sent.length === 0);

  console.log('\na block is announced fifteen minutes before it starts');
  {
    // The message used to land as the block began, which is already late: you
    // find out you should be doing something as the time to start passes.
    //
    // The boundaries are the whole of this. Fifteen minutes is one tick of the
    // loop, so a block's message lands on the tick before it — and a block
    // sixteen minutes out must wait for that tick rather than going now.
    const ahead = await makePlan('2031-06-11', 'confirmed', [
      { title: 'Due in 15', start_time: at(15), duration_minutes: 30, note: null, created_at: old },
      { title: 'Due in 16', start_time: at(16), duration_minutes: 30, note: null, created_at: old },
      { title: 'Due in 45', start_time: at(45), duration_minutes: 30, note: null, created_at: old },
    ]);
    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-11' });

    const titles = sent.map((s) => s.text.split('\n')[0]);
    check('the one starting in fifteen goes out',
      titles.some((t) => /Due in 15/.test(t)), JSON.stringify(titles));
    check('the one a minute further off does not',
      !titles.some((t) => /Due in 16/.test(t)), JSON.stringify(titles));
    check('nor the one three quarters of an hour away',
      !titles.some((t) => /Due in 45/.test(t)), JSON.stringify(titles));

    // The message is unchanged: it names the block's own hours, which is what
    // makes an early one a warning rather than a correction.
    const early = sent.find((s) => /Due in 15/.test(s.text));
    check('and it still names the hour the block starts, not the hour it arrived',
      early.text.includes(`${ampm(nowMinutes + 15)} to`), early.text.replace(/\n/g, ' | '));

    const after = await statusOf(ahead);
    check('only the announced one left the queue',
      after.filter((b) => b.message_sent_at).length === 1,
      JSON.stringify(after.map((b) => [b.title, Boolean(b.message_sent_at)])));
  }

  console.log('\ntwo ticks at once send one message, not two');
  {
    // THE DUPLICATE. The queue is "message_sent_at IS NULL" and the mark is
    // written after the send returns, so the row sits unclaimed for exactly as
    // long as the Telegram call takes. Anything else looking in that window
    // sees an unsent block and sends it again.
    //
    // Two things put a second reader there in production. Railway overlaps the
    // old and new containers on a deploy, so for a moment there are two
    // schedulers; and scheduler.js runs a tick immediately on require, so every
    // container start re-checks the whole grace window rather than waiting for
    // the next quarter hour.
    //
    // Two concurrent calls is the same shape and needs no timers: both read the
    // queue, both find the block, both send.
    const raced = await makePlan('2031-06-10', 'confirmed', [
      { title: 'Sent once', start_time: at(-5), duration_minutes: 30, note: null, created_at: old },
    ]);
    sent.length = 0;
    sendDelay = 250;

    await Promise.all([
      scheduler.deliverDue(profile, { ...now, date: '2031-06-10' }),
      scheduler.deliverDue(profile, { ...now, date: '2031-06-10' }),
    ]);
    sendDelay = 0;

    check('the block went out exactly once', sent.length === 1,
      `${sent.length} sends: ${JSON.stringify(sent.map((s) => s.text.split('\n')[0]))}`);
    check('and it is marked sent', (await statusOf(raced))[0].message_sent_at !== null);

    // And a third pass afterwards, which is the restart case: a container that
    // boots inside the grace window must find nothing left to do.
    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-10' });
    check('a tick after the fact sends nothing', sent.length === 0, `${sent.length}`);
  }

  console.log('\ncleanup');
  for (const id of made) await supabase.from('plans').delete().eq('user_id', U).eq('id', id);
  const { count: plansLeft } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U);
  const { count: blocksLeft } = await supabase.from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('no plans left', plansLeft === 0, `${plansLeft}`);
  check('no blocks left', blocksLeft === 0, `${blocksLeft}`);
  check('nothing was sent to a real phone', sent.every((s) => true) && telegram.sendTelegram.name !== 'sendTelegram');

  console.log(bad === 0 ? '\nStep 5 clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  for (const id of made) await supabase.from('plans').delete().eq('user_id', U).eq('id', id);
  process.exit(1);
});
