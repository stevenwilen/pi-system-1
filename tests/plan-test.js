// Step 3 against the real database, with real non-empty rows.
//
// The point of the last section is the loop closing: an entry scheduled into a
// block must change what the stale panel says about it. That is the thing that
// was never exercised while plans and blocks sat empty.
const H = require('./harness');
// The test account, discovered rather than written down. It is a real auth
// user now, created by the harness, so its id is not knowable until it
// exists — which is why this is assigned inside the run rather than at the
// top of the file.
let U;

// Every request this suite makes, as the test account.
//
// The server takes its user from the token and refuses a request without
// one, so a bare fetch here would not read as a broken test — it would read
// as an account with nothing in it.
let authed = () => {
  throw new Error('the account is not signed in yet');
};
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
  const res = await authed(BASE + path, body
    ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const server = H.spawnServer(PORT);

// A date far from anything real, so nothing the person plans is disturbed.
const DATE = '2031-03-09';

(async () => {
  // Refuses to run at all if the guard is not live.
  U = await H.userId();
  authed = H.as((await H.setup()).a);
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

  // wake_minutes is required, and it is checked before the per-block rules.
  // So every case below sends a valid one: without it they would all come back
  // 400 for the missing wake time and pass while proving nothing about the
  // rule each one names.
  const WAKE = 8 * 60;
  const withWake = (body) => call('/plan', { wake_minutes: WAKE, ...body });

  check('rejects a bad date', (await withWake({ date: 'nope', blocks: [] })).status === 400);

  // A MISSING date, which is not the same case and is the one that shipped.
  // The page posted `date: planDate` — the function rather than its result —
  // and JSON.stringify drops a function-valued key without a word, so the body
  // arrived with no date at all. This is the message that came back, and it
  // named a format rather than an absence, which is why it read as a locale
  // problem on the phone that received it.
  const noDate = await withWake({ blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 30 }] });
  check('rejects a missing date too', noDate.status === 400, `${noDate.status}`);
  check('with the message the phone showed', noDate.data.error === 'date must be YYYY-MM-DD',
    noDate.data.error);
  check('rejects an empty plan', (await withWake({ date: DATE, blocks: [] })).status === 400);
  const offStep = await withWake({ date: DATE, blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 45 }] });
  check('rejects a duration off the 30 minute step', offStep.status === 400, offStep.data.error);
  check('and says so, rather than complaining about the wake time',
    /multiple of 30/.test(offStep.data.error || ''), offStep.data.error);
  // Nothing arrives from a calendar any more, so nothing is exempt from the
  // step. Every block is built with the steppers, so every block lands on it.
  const pinnedOdd = await withWake({ date: DATE, blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 45, pinned: true }] });
  check('and the old exemption for pinned events is gone', pinnedOdd.status === 400, pinnedOdd.data.error);
  const tooShort = await withWake({ date: DATE, blocks: [{ title: 'x', start_minutes: 480, duration_minutes: 15 }] });
  check('rejects a duration under one step', tooShort.status === 400, tooShort.data.error);
  check('rejects a start outside the day', (await withWake({ date: DATE, blocks: [{ title: 'x', start_minutes: 1500, duration_minutes: 30 }] })).status === 400);
  check('rejects a blank title', (await withWake({ date: DATE, blocks: [{ title: '  ', start_minutes: 480, duration_minutes: 30 }] })).status === 400);

  console.log('\nconfirming sends nothing to Telegram');
  {
    // It sent the whole day as one message for a while. That is gone: block
    // messages now arrive fifteen minutes ahead of each block, which is the
    // same information at the moment it is worth having, so a brief at confirm
    // time was saying it all twice.
    const src = require('fs').readFileSync(ROOT + '/routes/plan.js', 'utf8');
    check('the confirm route does not message', !/sendTelegram|composeSchedule/.test(src));
    check('nor compose a day', !/sendSchedule|blocksStillToCome/.test(src));

    // This suite drives a REAL server process, so anything the route sends
    // would go to a real phone. It is safe because spawnServer runs as the
    // test user and that profile has no chat linked — asserted rather than
    // assumed, because the safety is incidental and would go quiet if a chat
    // id ever appeared on this row.
    const { data: prof } = await supabase
      .from('profile').select('telegram_chat_id').eq('user_id', U).maybeSingle();
    check('and the test user has no chat linked anyway',
      prof && prof.telegram_chat_id === null, JSON.stringify(prof));
  }

  console.log('\nconfirm writes plans and blocks');
  const plan = {
    date: DATE,
    wake_minutes: WAKE,
    blocks: [
      { title: target.title, entryId: target.id, start_minutes: 480, duration_minutes: 60 },
      { title: 'Dentist', entryId: null, start_minutes: 600, duration_minutes: 60 },
      { title: 'Deep work', entryId: null, start_minutes: 660, duration_minutes: 120 },
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
  check('nothing is stored as pinned', blockRows.every((b) => b.pinned === false),
    blockRows.map((b) => b.pinned).join(','));
  check('sort_order preserves the list order', blockRows.map((b) => b.sort_order).join(',') === '0,1,2');

  console.log('\nreading it back');
  const back = (await call(`/plan/${DATE}`)).data;
  check('plan is returned', back.plan && back.plan.status === 'confirmed');
  check('blocks come back in order', back.blocks.map((b) => b.title).join('|') === `${target.title}|Dentist|Deep work`);
  check('minutes round trip exactly', back.blocks[0].start_minutes === 480 && back.blocks[0].duration_minutes === 60);
  check('nothing comes back pinned', back.blocks.every((b) => b.pinned === undefined));
  check('entryId round trips', back.blocks[0].entryId === target.id);

  console.log('\nthe wake time is a fact about the day, not an inference');
  {
    // The case that made inferring it wrong: a block sitting two hours before
    // the day is meant to start. The old code took the earliest block, so this
    // day would have gone on record as a 06:00 start.
    const early = await call('/plan', {
      date: DATE,
      wake_minutes: 8 * 60,
      blocks: [
        { title: 'Early errand', start_minutes: 360, duration_minutes: 60 },
        { title: 'Work', start_minutes: 480, duration_minutes: 60 },
      ],
    });
    check('a day with an earlier block saves', early.status === 200, JSON.stringify(early.data));

    const { data: row } = await supabase
      .from('plans').select('wake_time').eq('user_id', U).eq('date', DATE).maybeSingle();
    check('the stored wake time is the one that was sent', row.wake_time.startsWith('08:00'), row.wake_time);
    check('and not the 06:00 block', !row.wake_time.startsWith('06:00'));

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

    // It used to fall back to the earliest block when nothing was sent, for
    // the sake of an older client. There are no older clients: the page is
    // served by this same process from this same deploy and cannot be a
    // version behind. So the fallback was unreachable, and the behaviour it
    // fell back to is the exact inference this field exists to replace.
    const { data: before } = await supabase
      .from('plans').select('wake_time').eq('user_id', U).eq('date', DATE).maybeSingle();

    const omitted = await call('/plan', { date: DATE, blocks: [{ title: 'x', start_minutes: 600, duration_minutes: 30 }] });
    check('omitting it is refused', omitted.status === 400, `${omitted.status} ${omitted.data.error || ''}`);
    check('and the message says why', /required/.test(omitted.data.error || ''), omitted.data.error);

    const nulled = await call('/plan', { date: DATE, wake_minutes: null, blocks: [{ title: 'x', start_minutes: 600, duration_minutes: 30 }] });
    check('null is refused too', nulled.status === 400, `${nulled.status}`);

    // The refusal must not have half-written the day on its way out.
    const { data: after } = await supabase
      .from('plans').select('wake_time').eq('user_id', U).eq('date', DATE).maybeSingle();
    check('the refused request changed nothing',
      (before && before.wake_time) === (after && after.wake_time),
      `${before && before.wake_time} -> ${after && after.wake_time}`);
    check('and it certainly did not infer 10:00 from the first block',
      !(after && after.wake_time.startsWith('10:00')), after && after.wake_time);
  }

  console.log('\nre-confirming replaces, never appends');
  const again = await call('/plan', { date: DATE, wake_minutes: WAKE, blocks: [{ title: 'Only this', start_minutes: 540, duration_minutes: 30 }] });
  check('second confirm succeeds', again.status === 200);
  const { data: after } = await supabase.from('blocks').select('id, title').eq('plan_id', planRow.id);
  check('one block, not four', after.length === 1, `${after.length}`);
  check('and it is the new one', after[0].title === 'Only this');
  const { count: planCount } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U).eq('date', DATE);
  check('still a single plan row for the day', planCount === 1);

  console.log('\nthe note rides with the block');
  {
    const withNotes = await call('/plan', {
      date: DATE,
      wake_minutes: WAKE,
      blocks: [
        { title: 'Reading', start_minutes: 480, duration_minutes: 30, note: '  ch. 4, no phone  ' },
        { title: 'Email', start_minutes: 510, duration_minutes: 30 },
        { title: 'Blank', start_minutes: 540, duration_minutes: 30, note: '   ' },
      ],
    });
    check('a day with notes saves', withNotes.status === 200, JSON.stringify(withNotes.data));

    const { data: rows } = await supabase
      .from('blocks').select('title, note').eq('plan_id', planRow.id).order('sort_order');
    check('it is stored, trimmed', rows[0].note === 'ch. 4, no phone', JSON.stringify(rows[0].note));
    check('a block without one stores null', rows[1].note === null, JSON.stringify(rows[1].note));
    check('and whitespace is not a note', rows[2].note === null, JSON.stringify(rows[2].note));

    const back = (await call(`/plan/${DATE}`)).data;
    check('it comes back on the block', back.blocks[0].note === 'ch. 4, no phone',
      String(back.blocks[0].note));
    check('and stays null where there was none', back.blocks[1].note === null,
      String(back.blocks[1].note));

    // It belongs to the block, so re-confirming without it clears it. That is
    // the point of it living here rather than on the entry.
    await call('/plan', {
      date: DATE, wake_minutes: WAKE,
      blocks: [{ title: 'Reading', start_minutes: 480, duration_minutes: 30 }],
    });
    const after = (await call(`/plan/${DATE}`)).data;
    check('re-confirming without it clears it', after.blocks[0].note === null,
      String(after.blocks[0].note));

    const tooLong = await call('/plan', {
      date: DATE, wake_minutes: WAKE,
      blocks: [{ title: 'Reading', start_minutes: 480, duration_minutes: 30, note: 'x'.repeat(501) }],
    });
    check('an unbounded note is refused', tooLong.status === 400, `${tooLong.status}`);
    check('and told it is a line or two', /line or two/.test(tooLong.data.error || ''),
      tooLong.data.error);

    const notText = await call('/plan', {
      date: DATE, wake_minutes: WAKE,
      blocks: [{ title: 'Reading', start_minutes: 480, duration_minutes: 30, note: { a: 1 } }],
    });
    check('and so is one that is not text', notText.status === 400, `${notText.status}`);
  }

  console.log('\nre-confirming keeps the day, it does not rebuild it');
  {
    // The bug: a re-confirm deleted every block for the date and inserted the
    // whole day again, so every column the confirm does not set fell back to
    // its schema default. message_sent_at went null, and a block that had
    // already gone out could be sent a second time.
    const RD = '2031-04-02';

    // From a known state, so a run that aborted partway through this section
    // cannot leave rows behind that the next run reads as its own.
    for (const d of [RD, '2031-04-03']) {
      const { data: old } = await supabase
        .from('plans').select('id').eq('user_id', U).eq('date', d).maybeSingle();
      if (old) await supabase.from('plans').delete().eq('user_id', U).eq('id', old.id);
    }

    const first = await call('/plan', {
      date: RD, wake_minutes: WAKE,
      blocks: [
        { title: 'Alpha', start_minutes: 480, duration_minutes: 30, note: 'first' },
        { title: 'Beta', start_minutes: 510, duration_minutes: 30 },
        { title: 'Gamma', start_minutes: 540, duration_minutes: 30 },
      ],
    });
    check('a new day saves', first.status === 200, JSON.stringify(first.data));
    check('and hands back an id per block',
      Array.isArray(first.data.ids) && first.data.ids.length === 3 && first.data.ids.every(Boolean),
      JSON.stringify(first.data.ids));

    const { data: rp } = await supabase
      .from('plans').select('id').eq('user_id', U).eq('date', RD).single();

    const read = async () => (await supabase
      .from('blocks')
      .select('id, title, start_time, duration_minutes, note, sort_order, message_sent_at')
      .eq('plan_id', rp.id).order('sort_order')).data;

    const before = await read();
    const [alpha, beta, gamma] = before;

    // The day has run: Alpha and Beta both delivered.
    const SENT = '2031-04-02T08:05:00.000Z';
    await supabase.from('blocks').update({ message_sent_at: SENT })
      .eq('user_id', U).eq('id', alpha.id);
    await supabase.from('blocks').update({ message_sent_at: SENT })
      .eq('user_id', U).eq('id', beta.id);

    const payload = (bs) => ({ date: RD, wake_minutes: WAKE, blocks: bs });
    const same = [
      { id: alpha.id, title: 'Alpha', start_minutes: 480, duration_minutes: 30, note: 'first' },
      { id: beta.id, title: 'Beta', start_minutes: 510, duration_minutes: 30 },
      { id: gamma.id, title: 'Gamma', start_minutes: 540, duration_minutes: 30 },
    ];

    console.log('  an identical re-confirm');
    const again = await call('/plan', payload(same));
    check('is accepted', again.status === 200, JSON.stringify(again.data));

    const after = await read();
    check('the same rows, not new ones',
      after.map((b) => b.id).join() === before.map((b) => b.id).join(),
      `${before.map((b) => b.id.slice(0, 4))} -> ${after.map((b) => b.id.slice(0, 4))}`);
    check('a delivered block is still delivered',
      after[0].message_sent_at !== null && after[1].message_sent_at !== null,
      `${after[0].message_sent_at} / ${after[1].message_sent_at}`);
    check('so it cannot be sent a second time', after[1].message_sent_at !== null);
    check('and an undelivered one is untouched', after[2].message_sent_at === null);
    check('the ids come back in the order they were sent',
      again.data.ids.join() === before.map((b) => b.id).join(), JSON.stringify(again.data.ids));

    console.log('  the editable fields still change');
    const edited = await call('/plan', payload([
      { ...same[0], title: 'Alpha renamed', note: 'rewritten' },
      same[1], same[2],
    ]));
    check('a delivered block can be retitled', edited.status === 200, JSON.stringify(edited.data));
    const afterEdit = await read();
    check('the new title landed', afterEdit[0].title === 'Alpha renamed', afterEdit[0].title);
    check('and the new note', afterEdit[0].note === 'rewritten', String(afterEdit[0].note));
    check('while it is still delivered', afterEdit[0].message_sent_at !== null);

    // Alpha and Beta have gone out; only Gamma is still editable and
    // removable, so it is the one the removal cases use.
    console.log('  removing an undelivered block');
    const dropped = await call('/plan', payload([same[0], same[1]]));
    check('is accepted', dropped.status === 200, JSON.stringify(dropped.data));
    const afterDrop = await read();
    check('only that row is gone', afterDrop.length === 2, `${afterDrop.length}`);
    check('and it is the right one',
      !afterDrop.some((b) => b.id === gamma.id) &&
        afterDrop.some((b) => b.id === alpha.id) && afterDrop.some((b) => b.id === beta.id));
    check('the survivors kept their history',
      afterDrop.find((b) => b.id === alpha.id).message_sent_at !== null);

    console.log('  adding one');
    const added = await call('/plan', payload([
      same[0], same[1], { title: 'Delta', start_minutes: 570, duration_minutes: 30 },
    ]));
    check('is accepted', added.status === 200, JSON.stringify(added.data));
    const afterAdd = await read();
    check('three rows now', afterAdd.length === 3, `${afterAdd.length}`);
    check('the existing ids are unchanged',
      afterAdd.some((b) => b.id === alpha.id) && afterAdd.some((b) => b.id === beta.id));
    check('and it is reported back', added.data.ids.length === 3 && added.data.ids.every(Boolean),
      JSON.stringify(added.data.ids));
    check('with the existing ones in place',
      added.data.ids[0] === alpha.id && added.data.ids[1] === beta.id);
    check('the new one got a fresh id',
      added.data.ids[2] !== alpha.id && added.data.ids[2] !== beta.id);
    check('the delivered one is STILL delivered after all that',
      afterAdd.find((b) => b.id === alpha.id).message_sent_at !== null);

    // Undelivered, so it is the block the "can still be edited" cases use.
    const delta = { id: added.data.ids[2], title: 'Delta', start_minutes: 570, duration_minutes: 30 };

    console.log('  a delivered block cannot be retimed');
    const moved = await call('/plan', payload([{ ...same[0], start_minutes: 600 }, same[1], delta]));
    check('retiming it is refused', moved.status === 400, `${moved.status}`);
    check('and the message says why',
      /already sent.*cannot be moved or resized/.test(moved.data.error || ''), moved.data.error);

    const resized = await call('/plan', payload([{ ...same[0], duration_minutes: 60 }, same[1], delta]));
    check('resizing it is refused too', resized.status === 400, `${resized.status}`);

    const stillThere = await read();
    check('and the refusal wrote nothing at all',
      stillThere.length === 3 &&
        stillThere.find((b) => b.id === alpha.id).start_time.startsWith('08:00'),
      `${stillThere.length} rows`);

    const undeliveredMove = await call('/plan', payload([
      same[0], same[1], { ...delta, start_minutes: 660 },
    ]));
    check('but an undelivered block moves freely', undeliveredMove.status === 200,
      JSON.stringify(undeliveredMove.data));

    console.log('  but it CAN be removed');
    {
      // Retiming and resizing only. Removal used to be refused here too, on
      // the grounds that the day that happened is not editable — which held
      // while a removed block and a missed block meant different things. They
      // no longer do: taking a block out IS how you say it did not happen.
      //
      // Delta first, which never went out, so the undelivered path is proved
      // separately from the delivered one.
      const fine = await call('/plan', payload([same[0], same[1]]));
      check('an undelivered block removes cleanly', fine.status === 200,
        JSON.stringify(fine.data));
      check('and only it went', (await read()).length === 2, `${(await read()).length}`);
    }

    console.log('  an id that is not this plan\'s');
    const foreign = await call('/plan', payload([
      { ...same[0], id: '00000000-0000-0000-0000-0000000000ff' }, same[1],
    ]));
    check('is refused', foreign.status === 400, `${foreign.status}`);
    check('naming the block', /is not part of the plan/.test(foreign.data.error || ''),
      foreign.data.error);

    // A real row, belonging to the real person's plan rather than this one.
    // The guard has to be "not in THIS plan", not merely "exists".
    const otherDay = await call('/plan', {
      date: '2031-04-03', wake_minutes: WAKE,
      blocks: [{ title: 'Elsewhere', start_minutes: 480, duration_minutes: 30 }],
    });
    const elsewhereId = otherDay.data.ids[0];
    const crossed = await call('/plan', payload([{ ...same[0], id: elsewhereId }]));
    check('an id from another day is refused as well', crossed.status === 400, `${crossed.status}`);

    const dup = await call('/plan', payload([same[0], { ...same[0] }]));
    check('and the same id twice is refused', dup.status === 400,
      `${dup.status} ${dup.data.error || ''}`);

    // Two, not three: the successful move above sent two blocks and so
    // dropped Delta. What matters here is that none of the four refusals
    // moved that number, and that Alpha still carries its history.
    const untouched = await read();
    check('none of those refusals changed anything',
      untouched.length === 2 &&
        untouched.find((b) => b.id === alpha.id).message_sent_at !== null,
      `${untouched.length} rows`);

    // Last, because it destroys the row the id cases above were built on: the
    // delivered block goes too. This is the whole of the simplification —
    // there is no rule left that removal has to get past.
    console.log('  a delivered block removes as well');
    {
      const goneOut = await call('/plan', payload([same[1]]));
      check('leaving a delivered block out is accepted', goneOut.status === 200,
        JSON.stringify(goneOut.data));

      const left = await read();
      check('and it really went', !left.some((b) => b.id === alpha.id), `${left.length} rows`);
      check('leaving only the one still named', left.length === 1 && left[0].id === beta.id,
        JSON.stringify(left.map((b) => b.title)));
      check('and no error mentions removal any more',
        !/cannot be removed/.test(JSON.stringify(goneOut.data)), JSON.stringify(goneOut.data));
    }

    // Clean up both dates this section made.
    for (const d of [RD, '2031-04-03']) {
      const { data: p } = await supabase
        .from('plans').select('id').eq('user_id', U).eq('date', d).maybeSingle();
      if (p) await supabase.from('plans').delete().eq('user_id', U).eq('id', p.id);
    }
  }

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
    wake_minutes: WAKE,
    blocks: [{ title: target.title, entryId: target.id, start_minutes: 480, duration_minutes: 60 }],
  });

  const refreshed = (await call('/entries')).data;
  const seen = refreshed.items.find((i) => i.id === target.id);
  check('entry reports the plan date it appeared in', seen && seen.last_scheduled === past, `${seen && seen.last_scheduled} (today is ${today})`);
  check('days counts back to that plan, not to created_at', seen && seen.days === 11, `${seen && seen.days} days`);

  // Two plans, and the panel must follow the most recent one.
  const recent = new Date(`${today}T12:00:00Z`);
  recent.setUTCDate(recent.getUTCDate() - 3);
  const recentDate = recent.toISOString().slice(0, 10);
  await call('/plan', {
    date: recentDate,
    wake_minutes: WAKE,
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
