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

// Kept before it is replaced, for a case that asks the genuine article one
// question: what does it return for a profile with no chat linked?
const real = telegram.sendTelegram;

// Makes the stub answer the way the real sender does for an unlinked account.
//
// A FLAG RATHER THAN SWAPPING THE REAL ONE BACK IN. scheduler.js destructures
// sendTelegram when it loads, so anything assigned to telegram.sendTelegram
// afterwards is invisible to it — the note at the top of this file says so, and
// this case was written ignoring it. The scheduler went on calling the stub,
// the stub reported success, and the block was marked sent by the success path
// while the case claimed to be testing the skip path.
let skipSend = false;

telegram.sendTelegram = async (db, user_id, text) => {
  if (skipSend) return { skipped: 'no telegram_chat_id for this user' };
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

  // EVERY ROW CARRIES EVERY KEY, which is what these defaults are for and why
  // `completed` had to join them. A batch insert aligns its columns across the
  // rows it is given, so a key present on one row and absent from another is
  // sent as an explicit NULL for the row that lacked it — not as "leave it to
  // the column default". One case here passes `completed: false` for an
  // untimed item, and that alone was enough to make every timed block beside
  // it violate the NOT NULL on the same column.
  const rows = blocks.map((b, i) => ({
    user_id: U,
    plan_id: plan.id,
    sort_order: i,
    entry_id: null,
    pinned: false,
    note: null,
    message_sent_at: null,
    completed: true,
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

  // HEADERS ONLY. A note now goes out as a message of its own and carries no
  // title, so it has no <b> to match — which is what makes this the count of
  // blocks that were delivered rather than of messages that left.
  const titles = sent.filter((s) => /<b>/.test(s.text)).map((s) => s.text.match(/<b>(.*?)<\/b>/)[1]);
  check('sends the started block that has a note', titles.includes('Started with a note'));
  check('sends the started block without one', titles.includes('Started, no note'));
  check('does not send a block that has not started', !titles.includes('Not started yet'));
  check('does not send a block long past its time', !titles.includes('Long past'), titles.join(', '));
  check('exactly two blocks went out', titles.length === 2, `${titles.length}`);

  // THREE MESSAGES FOR TWO BLOCKS, because one of them had a note. This is the
  // check that would catch the note being composed and never sent.
  check('and three messages, because one carried a note', sent.length === 3,
    `${sent.length}: ${sent.map((s) => JSON.stringify(s.text.slice(0, 30))).join(', ')}`);

  // Twelve hour, the way it arrives on a phone. Built here rather than taken
  // from messages.js, so this is a second opinion on the format rather than
  // the same function agreeing with itself.
  const ampm = (mins) => {
    const at12 = ((mins % 1440) + 1440) % 1440;
    const h = Math.floor(at12 / 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(at12 % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };

  const withLine = sent.find((s) => s.text.includes('Started with a note'));
  check('the header is the header, and carries no note',
    withLine.text === `<b>Started with a note</b>\n${ampm(nowMinutes - 5)} to ${ampm(nowMinutes + 55)}`,
    JSON.stringify(withLine.text));

  // THE NOTE, ON ITS OWN, AND AFTER IT. Order matters and is not incidental —
  // it is sent second on purpose, so the phone shows the block first.
  const noteAt = sent.findIndex((s) => s.text === 'twenty pages, no phone');
  const headerAt = sent.indexOf(withLine);
  check('the note went out as a message of its own', noteAt !== -1,
    sent.map((s) => JSON.stringify(s.text)).join(' | '));
  check('with no title and no times on it',
    noteAt !== -1 && !sent[noteAt].text.includes('<b>') && !sent[noteAt].text.includes('AM') &&
      !sent[noteAt].text.includes('PM'), noteAt !== -1 ? JSON.stringify(sent[noteAt].text) : '');
  check('and under the block it belongs to, not above it', noteAt > headerAt,
    `header ${headerAt}, note ${noteAt}`);
  check('to the same person', noteAt !== -1 && sent[noteAt].user_id === withLine.user_id);

  const bare = sent.find((s) => s.text.includes('no note'));
  check('a block without one sends nothing after it',
    !bare.text.includes('\n\n') && sent.filter((s) => s.user_id === bare.user_id &&
      s.text.includes('Started, no note')).length === 1, JSON.stringify(bare.text));

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
    // Two messages, one block: the header, then the note under it.
    check('it is sent on the first tick', sent.length === 2, `${sent.length} sent`);
    check('the header first', sent[0] && /<b>Just confirmed<\/b>/.test(sent[0].text),
      JSON.stringify(sent[0] && sent[0].text));
    check('with its note under it', sent[1] && sent[1].text === 'twenty pages, no phone',
      JSON.stringify(sent[1] && sent[1].text));
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

  console.log('\nan untimed item is not in this queue at all');
  {
    // A THING COMMITTED TO THE DAY AND NOT TO AN HOUR. It has no start time,
    // so there is nothing for the loop to be early or late for.
    //
    // THE FAILURE THIS GUARDS AGAINST IS NOT "IT DOES NOTHING". toMinutes(null)
    // is NaN, and every comparison against NaN is false — so an untimed item
    // would fall past the too-early test, past the too-late test, and be SENT,
    // as a message reading "NaN:NaN to NaN:NaN". A guard that fails open into a
    // delivered message is worth checking by name.
    const mixed = await makePlan('2031-06-12', 'confirmed', [
      { title: 'Ring the dentist', start_time: null, duration_minutes: null, completed: false, created_at: old },
      { title: 'Deep work', start_time: at(-1), duration_minutes: 30, note: 'the pricing page', created_at: old },
    ]);

    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-12' });

    // One block with a note: its header and then the note. The untimed item is
    // not delivered here at all — it goes out with the anytime lane.
    check('the timed block goes out', sent.length === 2, String(sent.length));
    check('and it is the one with an hour',
      sent[0] && /Deep work/.test(sent[0].text), JSON.stringify(sent[0] && sent[0].text));
    check('its note following on its own',
      sent[1] && sent[1].text === 'the pricing page', JSON.stringify(sent[1] && sent[1].text));
    check('nothing anywhere says NaN',
      !sent.some((m) => /NaN/.test(m.text)), JSON.stringify(sent.map((m) => m.text)));

    const rows = await statusOf(mixed);
    const untimedRow = rows.find((r) => r.title === 'Ring the dentist');
    const timedRow = rows.find((r) => r.title === 'Deep work');

    check('the timed one is marked sent', timedRow.message_sent_at !== null);
    // NOT EXPIRED EITHER, which is the half a "nothing was sent" check would
    // miss. Expiring writes message_sent_at as well — same column, opposite
    // meaning — so an untimed item that got retired would look identical to
    // one correctly skipped if only the message count were checked.
    check('AND THE UNTIMED ONE IS NEITHER SENT NOR RETIRED',
      untimedRow.message_sent_at === null, String(untimedRow.message_sent_at));

    // A tick at the end of the day, when a timed block that far back would
    // long since have been retired. It must still be left alone.
    sent.length = 0;
    await scheduler.deliverDue(profile, { ...now, date: '2031-06-12', hour: 23, minute: 30 });
    check('and a later tick does not retire it either',
      (await statusOf(mixed)).find((r) => r.title === 'Ring the dentist').message_sent_at === null);
    check('with nothing sent for it', sent.length === 0, String(sent.length));
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

  console.log('\nan account with no telegram is skipped, not failed');
  {
    // WHAT THIS IS FOR. `skipped` used to fall through to the failure branch,
    // which released the claim so the next tick would retry — and there is
    // nothing about an unlinked account that a retry improves. The cost was
    // twelve claim/release cycles and twelve error lines per block per day,
    // ending in an [EXPIRED] warning about a delivery that was never possible.
    //
    // First, the real sender's own answer for a profile with no chat linked.
    // One question, asked directly, with no scheduler in the way.
    await supabase.from('profile').update({ telegram_chat_id: null }).eq('user_id', U);
    const direct = await real(supabase, U, 'nowhere to go');
    check('the sender reports a skip, not an error', Boolean(direct.skipped),
      JSON.stringify(direct));
    check('and does not claim to have sent', !direct.sent, JSON.stringify(direct));

    // Then what the scheduler does with that answer, which is the part that
    // changed.
    skipSend = true;

    const DATE = '2031-07-02';
    await supabase.from('profile').update({ telegram_chat_id: null }).eq('user_id', U);

    const { data: plan } = await supabase
      .from('plans')
      .insert({ user_id: U, date: DATE, wake_time: '08:00:00', status: 'confirmed' })
      .select().single();
    made.push(plan.id);

    const { data: block } = await supabase
      .from('blocks')
      .insert({
        user_id: U, plan_id: plan.id, title: 'Nowhere to send this',
        start_time: '09:00:00', duration_minutes: 30, sort_order: 0,
      })
      .select().single();

    // hour and minute, which is the shape deliverDue reads. Written as
    // `minutes` first, which left the tick at midday: the 09:00 block was then
    // three hours late, took the EXPIRED path, and the claim it left behind
    // made this case pass without ever reaching the skip it is about.
    sent.length = 0;
    const at = { ...now, date: DATE, hour: 9, minute: 5 };
    await scheduler.deliverDue(profile, at);

    const claimed = async () => {
      const { data } = await supabase
        .from('blocks').select('message_sent_at').eq('id', block.id).maybeSingle();
      return data && data.message_sent_at;
    };

    check('it did not throw', true);
    // Claimed and LEFT claimed. Releasing it is what caused the retry storm.
    check('the block is resolved rather than queued again', Boolean(await claimed()),
      String(await claimed()));

    const before = await claimed();
    await scheduler.deliverDue(profile, { ...at, minute: 20 });
    check('and a later tick does not pick it up again', (await claimed()) === before);
    check('and nothing was put on the wire', sent.length === 0, JSON.stringify(sent));

    skipSend = false;
  }

  console.log('\nand the other account still gets theirs');
  {
    // THE HALF THAT STOPS THE ABOVE MEANING NOTHING. "Nothing was sent" is
    // also what a completely broken delivery loop looks like.
    sent.length = 0;
    const DATE = '2031-07-03';

    const { data: plan } = await supabase
      .from('plans')
      .insert({ user_id: U, date: DATE, wake_time: '08:00:00', status: 'confirmed' })
      .select().single();
    made.push(plan.id);

    await supabase.from('blocks').insert({
      user_id: U, plan_id: plan.id, title: 'This one lands',
      start_time: '09:00:00', duration_minutes: 30, sort_order: 0,
    });

    await supabase.from('profile').update({ telegram_chat_id: '5550100' }).eq('user_id', U);

    await scheduler.deliverDue(profile, { ...now, date: DATE, hour: 9, minute: 5 });
    check('a linked account is still delivered to', sent.length === 1, `${sent.length}`);
    check('with its own block', /This one lands/.test((sent[0] || {}).text || ''),
      (sent[0] || {}).text);

    await supabase.from('profile').update({ telegram_chat_id: null }).eq('user_id', U);
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
