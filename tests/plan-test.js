// Step 3 against the real database, with real non-empty rows.
//
// The point of the last section is the loop closing: an entry scheduled into a
// block must change what the stale panel says about it. That is the thing that
// was never exercised while plans and blocks sat empty.
const H = require('./harness');
const U = H.TEST_USER_ID;
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
const PORT = 3984;
const BASE = `http://127.0.0.1:${PORT}`;

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

async function call(path, body, method = 'POST') {
  const res = await fetch(BASE + path, body
    ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const server = H.spawnServer(PORT);

// A date far from anything real, so nothing the person plans is disturbed.
const DATE = '2031-03-09';

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const supabase = H.db;

  // The test creates its own entry rather than borrowing one. Depending on
  // the notebook having rows makes the suite fail whenever it is reset, and
  // the reset is a supported thing to do.
  const created = await call('/entries', { type: 'habit', title: '__probe habit', frequency: 'daily' });
  if (!created.data.entry) throw new Error(`could not create probe entry: ${created.data.error}`);
  const probeId = created.data.entry.id;

  const feed = (await call('/entries')).data;
  const target = feed.items.find((i) => i.id === probeId);
  console.log(`  using entry: "${target.title}" (${target.type}), currently ${target.days} days\n`);

  console.log('validation');
  check('rejects a bad date', (await call('/plan', { date: 'nope', blocks: [] })).status === 400);
  check('rejects an empty plan', (await call('/plan', { date: DATE, blocks: [] })).status === 400);
  const offStep = await call('/plan', { date: DATE, blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 45 }] });
  check('rejects a duration off the 30 minute step', offStep.status === 400, offStep.data.error);
  const pinnedOdd = await call('/plan', { date: DATE, blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 45, pinned: true }] });
  check('but allows an odd length for a pinned calendar event', pinnedOdd.status === 200);
  check('rejects a start outside the day', (await call('/plan', { date: DATE, blocks: [{ title: 'x', start_minutes: 1500, duration_minutes: 30 }] })).status === 400);
  check('rejects a blank title', (await call('/plan', { date: DATE, blocks: [{ title: '  ', start_minutes: 480, duration_minutes: 30 }] })).status === 400);

  console.log('\nconfirm writes plans and blocks');
  const plan = {
    date: DATE,
    blocks: [
      { title: target.title, entryId: target.id, start_minutes: 480, duration_minutes: 60, pinned: false },
      { title: 'Dentist', entryId: null, start_minutes: 600, duration_minutes: 45, pinned: true },
      { title: 'Deep work', entryId: null, start_minutes: 645, duration_minutes: 120, pinned: false },
    ],
  };
  const saved = await call('/plan', plan);
  check('confirm returns 200', saved.status === 200, JSON.stringify(saved.data));
  check('reports the block count', saved.data.blocks === 3);

  const { data: planRow } = await supabase.from('plans').select('id, status, wake_time').eq('user_id', U).eq('date', DATE).maybeSingle();
  check('plan row exists and is confirmed', planRow && planRow.status === 'confirmed');
  check('wake_time is the first block start', planRow && planRow.wake_time.startsWith('08:00'), planRow && planRow.wake_time);

  const { data: blockRows } = await supabase.from('blocks').select('*').eq('plan_id', planRow.id).order('sort_order');
  check('three block rows written', blockRows.length === 3, `${blockRows.length}`);
  check('start_time stored as a real time', blockRows[0].start_time.startsWith('08:00'), blockRows[0].start_time);
  check('duration stored in minutes', blockRows[0].duration_minutes === 60);
  check('entry_id links to the real entry', blockRows[0].entry_id === target.id);
  check('pinned flag survives', blockRows[1].pinned === true);
  check('sort_order preserves the list order', blockRows.map((b) => b.sort_order).join(',') === '0,1,2');

  console.log('\nreading it back');
  const back = (await call(`/plan/${DATE}`)).data;
  check('plan is returned', back.plan && back.plan.status === 'confirmed');
  check('blocks come back in order', back.blocks.map((b) => b.title).join('|') === `${target.title}|Dentist|Deep work`);
  check('minutes round trip exactly', back.blocks[0].start_minutes === 480 && back.blocks[0].duration_minutes === 60);
  check('pinned round trips', back.blocks[1].pinned === true);
  check('entryId round trips', back.blocks[0].entryId === target.id);

  console.log('\nthe wake time is a fact about the day, not an inference');
  {
    // The case that made inferring it wrong: a pinned appointment two hours
    // before the day is meant to start. The old code took the earliest block,
    // so this day would have gone on record as a 06:00 start.
    const early = await call('/plan', {
      date: DATE,
      wake_minutes: 8 * 60,
      blocks: [
        { title: 'Dentist', start_minutes: 360, duration_minutes: 45, pinned: true },
        { title: 'Work', start_minutes: 480, duration_minutes: 60 },
      ],
    });
    check('a day with an earlier pinned event saves', early.status === 200, JSON.stringify(early.data));

    const { data: row } = await supabase
      .from('plans').select('wake_time').eq('user_id', U).eq('date', DATE).maybeSingle();
    check('the stored wake time is the one that was sent', row.wake_time.startsWith('08:00'), row.wake_time);
    check('and not the 06:00 pinned block', !row.wake_time.startsWith('06:00'));

    const reopened = (await call(`/plan/${DATE}`)).data;
    check('it comes back as minutes', reopened.plan.wake_minutes === 480, `${reopened.plan.wake_minutes}`);

    // Quarter hours are the step the builder moves in.
    await call('/plan', { date: DATE, wake_minutes: 555, blocks: [{ title: 'x', start_minutes: 555, duration_minutes: 30 }] });
    const quarter = (await call(`/plan/${DATE}`)).data;
    check('a quarter past round trips', quarter.plan.wake_minutes === 555, `${quarter.plan.wake_minutes}`);

    for (const [label, value] of [
      ['past the end of the day', 1440],
      ['negative', -1],
      ['not a whole minute', 480.5],
    ]) {
      const r = await call('/plan', { date: DATE, wake_minutes: value, blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 30 }] });
      check(`rejects a wake time ${label}`, r.status === 400, `${r.status} ${r.data.error || ''}`);
    }

    // Older clients send no wake time at all and must keep working.
    const legacy = await call('/plan', { date: DATE, blocks: [{ title: 'x', start_minutes: 600, duration_minutes: 30 }] });
    check('omitting it still saves', legacy.status === 200);
    const { data: fell } = await supabase
      .from('plans').select('wake_time').eq('user_id', U).eq('date', DATE).maybeSingle();
    check('and falls back to the first block', fell.wake_time.startsWith('10:00'), fell.wake_time);
  }

  console.log('\nre-confirming replaces, never appends');
  const again = await call('/plan', { date: DATE, blocks: [{ title: 'Only this', start_minutes: 540, duration_minutes: 30 }] });
  check('second confirm succeeds', again.status === 200);
  const { data: after } = await supabase.from('blocks').select('id, title').eq('plan_id', planRow.id);
  check('one block, not four', after.length === 1, `${after.length}`);
  check('and it is the new one', after[0].title === 'Only this');
  const { count: planCount } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('date', DATE);
  check('still a single plan row for the day', planCount === 1);

  console.log('\nthe loop closes: scheduling resets staleness');

  // A genuinely past date, eleven days back, so `days` is a real positive
  // number rather than the 0 a future plan would produce. A zero here would
  // look like a pass while proving nothing.
  const today = feed.today;
  const elevenAgo = new Date(`${today}T12:00:00Z`);
  elevenAgo.setUTCDate(elevenAgo.getUTCDate() - 11);
  const past = elevenAgo.toISOString().slice(0, 10);

  await call('/plan', {
    date: past,
    blocks: [{ title: target.title, entryId: target.id, start_minutes: 480, duration_minutes: 60 }],
  });

  const refreshed = (await call('/entries')).data;
  const seen = refreshed.items.find((i) => i.id === target.id) || refreshed.paused.find((i) => i.id === target.id);
  check('entry reports the plan date it appeared in', seen && seen.last_scheduled === past, `${seen && seen.last_scheduled} (today is ${today})`);
  check('days counts back to that plan, not to created_at', seen && seen.days === 11, `${seen && seen.days} days`);

  // Two plans, and the panel must follow the most recent one.
  const recent = new Date(`${today}T12:00:00Z`);
  recent.setUTCDate(recent.getUTCDate() - 3);
  const recentDate = recent.toISOString().slice(0, 10);
  await call('/plan', {
    date: recentDate,
    blocks: [{ title: target.title, entryId: target.id, start_minutes: 480, duration_minutes: 60 }],
  });

  const twice = (await call('/entries')).data;
  const latest = twice.items.find((i) => i.id === target.id);
  check('the most recent plan wins', latest && latest.last_scheduled === recentDate, `${latest && latest.last_scheduled}`);
  check('and the count follows it', latest && latest.days === 3, `${latest && latest.days} days`);

  // With a real spread of ages on the board, the ordering has to hold.
  check('list is ordered coldest first',
    twice.items.every((it, i, a) => i === 0 || a[i - 1].days >= it.days),
    twice.items.map((i) => i.days).join(','));

  // 3 days since it was last scheduled is genuinely colder than an entry
  // added yesterday and never scheduled, so it belongs above them.
  check('scheduled 3 days ago outranks anything newer',
    twice.items.findIndex((i) => i.id === target.id) === 0,
    `target at index ${twice.items.findIndex((i) => i.id === target.id)}, ages ${twice.items.map((i) => i.days).join(',')}`);

  console.log('\nremoving the plans puts the clock back');
  // The plans go first and the entry last, so this can still be observed.
  for (const d of [DATE, past, recentDate]) {
    const { data: p } = await supabase.from('plans').select('id').eq('user_id', U).eq('date', d).maybeSingle();
    if (p) await supabase.from('plans').delete().eq('user_id', U).eq('id', p.id); // cascades to blocks
  }

  const final = (await call('/entries')).data;
  const restored = final.items.find((i) => i.id === target.id);
  check('entry counts from when it was added again', restored && restored.last_scheduled === null && restored.days === target.days,
    `${restored && restored.days} days, last_scheduled ${restored && restored.last_scheduled}`);

  console.log('\ncleanup');
  await supabase.from('entries').delete().eq('user_id', U).eq('id', probeId);
  const { count: plansLeft } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U);
  const { count: blocksLeft } = await supabase.from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  const { count: probeLeft } = await supabase.from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('id', probeId);
  check('no plans left behind', plansLeft === 0, `${plansLeft}`);
  check('no blocks left behind', blocksLeft === 0, `${blocksLeft}`);
  check('probe entry removed', probeLeft === 0, `${probeLeft}`);

  console.log(bad === 0 ? '\nStep 3 clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e.message); server.kill(); process.exit(1); });
