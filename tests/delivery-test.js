// Step 5, against real plans and blocks in the real database.
//
// The Telegram transport is stubbed. Everything else is real: real rows, real
// timezone maths, real state transitions. Sending genuine messages to the
// owner's phone is an outward-facing action and not mine to take unasked.
const H = require('./harness');
const U = H.TEST_USER_ID;
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
telegram.sendTelegram = async (user_id, text) => {
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
    message_text: null,
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
    { title: 'Started with a line', start_time: at(-5), duration_minutes: 60,
      message_text: '11 days since you last did this.', created_at: old },
    { title: 'Started, no line', start_time: at(-5), duration_minutes: 30, created_at: old },
    { title: 'Not started yet', start_time: at(60), duration_minutes: 30,
      message_text: 'Later.', created_at: old },
    { title: 'Long past', start_time: at(-90), duration_minutes: 30,
      message_text: 'Should never arrive.', created_at: old },
  ]);

  sent.length = 0;
  await scheduler.deliverDue(profile, now);

  const titles = sent.map((s) => s.text.match(/<b>(.*?)<\/b>/)[1]);
  check('sends the started block that has a line', titles.includes('Started with a line'));
  check('sends the started block without one', titles.includes('Started, no line'));
  check('does not send a block that has not started', !titles.includes('Not started yet'));
  check('does not send a block long past its time', !titles.includes('Long past'), titles.join(', '));
  check('exactly two went out', sent.length === 2, `${sent.length}`);

  const withLine = sent.find((s) => s.text.includes('Started with a line'));
  check('message carries header then line', withLine.text === '<b>Started with a line</b>\n' + scheduler.hhmm(at(-5)) + ' to ' + scheduler.hhmm(hhmmss(nowMinutes + 55)) + '\n\n11 days since you last did this.',
    JSON.stringify(withLine.text));

  const bare = sent.find((s) => s.text.includes('no line'));
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
        message_text: '11 days since you last did this.', created_at: new Date().toISOString(),
      },
    ]);
    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-02' });
    check('it is sent on the first tick', sent.length === 1, `${sent.length} sent`);
    check('with its line', sent[0].text.endsWith('11 days since you last did this.'), JSON.stringify(sent[0] && sent[0].text));
    check('and marked sent', (await statusOf(fresh))[0].message_sent_at !== null);
  }

  console.log('\na block with no line is not a failure');
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
    { title: 'Never agreed to', start_time: at(-5), duration_minutes: 30, message_text: 'nope', created_at: old },
  ]);
  sent.length = 0;
  await scheduler.deliverDue(profile, { ...now, date: '2031-06-04' });
  check('nothing sent for an unconfirmed plan', sent.length === 0, `${sent.length}`);
  check('and its blocks stay queued', (await statusOf(pending))[0].message_sent_at === null);

  console.log('\nno plan at all');
  sent.length = 0;
  await scheduler.deliverDue(profile, { ...now, date: '2031-06-09' });
  check('a day with no plan is quiet', sent.length === 0);

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
