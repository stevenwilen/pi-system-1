// A note on a thing, and the one moment it is spent.
//
// TWO NOTES LIVE IN THIS SYSTEM AND THEY ARE NOT THE SAME CLAIM. A block's
// note says what you are doing in that session; it belongs to Tuesday morning
// and stays there. A thing's note says what to remember WHEN you next put this
// in a day — and if it stayed where it was written it would be read again on
// every future scheduling, which is how a sentence about one morning becomes a
// standing instruction nobody meant to give.
//
// So it moves. Confirming a day writes it onto the first new block for that
// thing and clears the column. Everything below is about that move: that it
// waits until the day is confirmed, that it lands exactly once, and that the
// row it came from is empty afterwards.
//
// Checked against real rows through the real routes, because the claim is
// about what the database holds and not about what the code looks like.
const H = require('./harness');

const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Its own port. 3990 and 3995 belong elsewhere.
const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;

let U;
let A;
let B;
let server;

const post = async (as, p, body) => {
  const r = await H.as(as)(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (as, p) => (await H.as(as)(BASE + p)).json();

// Rows this suite made, cleaned up whatever happens.
const made = { entries: [], plans: [] };

async function thing(type, title) {
  const { data, error } = await H.db
    .from('entries')
    .insert({ user_id: U, type, title })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  made.entries.push(data.id);
  return data.id;
}

/** The row itself, read straight out of the table rather than off a screen. */
async function noteOf(id) {
  const { data } = await H.db.from('entries').select('note').eq('user_id', U).eq('id', id).single();
  return (data || {}).note;
}

/** The blocks of a day, in order, with what each one is carrying. */
async function blocksOn(date) {
  const { data: plan } = await H.db
    .from('plans').select('id').eq('user_id', U).eq('date', date).maybeSingle();
  if (!plan) return [];
  if (!made.plans.includes(plan.id)) made.plans.push(plan.id);

  const { data } = await H.db
    .from('blocks')
    .select('id, title, entry_id, note, sort_order')
    .eq('user_id', U)
    .eq('plan_id', plan.id)
    .order('sort_order');
  return data || [];
}

/**
 * The id of the first block of a day.
 *
 * A re-confirm has to send the ids back or every block is dropped and
 * re-inserted, which is a different bug in the same route.
 */
const again0 = (rows) => rows[0] && rows[0].id;

const block = (title, entryId, at, note) => ({
  title,
  entryId: entryId || null,
  start_minutes: at,
  duration_minutes: 30,
  ...(note === undefined ? {} : { note }),
});

async function cleanup() {
  for (const id of made.plans) {
    await H.db.from('blocks').delete().eq('user_id', U).eq('plan_id', id);
    await H.db.from('plans').delete().eq('user_id', U).eq('id', id);
  }
  for (const id of made.entries) {
    await H.db.from('entries').delete().eq('user_id', U).eq('id', id);
  }
  made.plans.length = 0;
  made.entries.length = 0;
}

(async () => {
  const accounts = await H.setup();
  A = accounts.a;
  B = accounts.b;
  U = await H.userId();
  await H.assertGuarded();
  await H.cleanup();
  await H.ensureProfile(undefined, undefined, 'a');
  await H.ensureProfile(undefined, undefined, 'b');

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  try {
    console.log('1. a note is written on the thing and stays there');
    {
      const study = await thing('project', 'Rewire the study');

      const written = await post(A, `/entries/${study}/note`, { note: '  start with the pricing page  ' });
      check('it saves', written.status === 200, JSON.stringify(written.body));
      check('trimmed', (await noteOf(study)) === 'start with the pricing page',
        JSON.stringify(await noteOf(study)));

      const listed = (await get(A, '/entries')).items.find((i) => i.id === study);
      check('and the list carries it back in full',
        listed.note === 'start with the pricing page', JSON.stringify(listed.note));

      // WHAT MUST NOT SPEND IT. Everything here is something a person does
      // between writing the note and scheduling the thing, and none of it is
      // scheduling the thing.
      await post(A, `/entries/${study}/update`, { title: 'Rewire the study room' });
      check('editing the row leaves it alone', (await noteOf(study)) === 'start with the pricing page',
        JSON.stringify(await noteOf(study)));

      const other = await thing('task', 'Return the router');
      await post(A, '/plan', {
        date: '2031-03-01', wake_minutes: 480,
        blocks: [block('Return the router', other, 540)],
      });
      check('confirming a day without it leaves it alone',
        (await noteOf(study)) === 'start with the pricing page',
        JSON.stringify(await noteOf(study)));

      await post(A, '/plan', {
        date: '2031-03-02', wake_minutes: 480,
        blocks: [block('Something typed straight in', null, 540)],
      });
      check('and so does a day of blocks tied to nothing',
        (await noteOf(study)) === 'start with the pricing page',
        JSON.stringify(await noteOf(study)));

      // Read back one more time, because a note nobody can find again is the
      // same as one that was never kept.
      const again = (await get(A, '/entries')).items.find((i) => i.id === study);
      check('it is still on the list at the end of all that',
        again.note === 'start with the pricing page', JSON.stringify(again.note));

      await cleanup();
    }

    console.log('\n2. scheduling it moves the note and empties the thing');
    {
      const study = await thing('project', 'Rewire the study');
      await post(A, `/entries/${study}/note`, { note: 'start with the pricing page' });

      const DAY = '2031-03-10';
      const done = await post(A, '/plan', {
        date: DAY, wake_minutes: 480,
        blocks: [block('Rewire the study', study, 540)],
      });
      check('the day confirms', done.status === 200, JSON.stringify(done.body));

      const rows = await blocksOn(DAY);
      check('the block carries the note now',
        rows.length === 1 && rows[0].note === 'start with the pricing page',
        JSON.stringify(rows));
      check('AND THE THING IS EMPTY', (await noteOf(study)) === null,
        JSON.stringify(await noteOf(study)));

      // The confirm says where it went, so the screen can show the arrival
      // without reloading the day.
      check('the answer says where it landed',
        Array.isArray(done.body.notes) && done.body.notes[0] === 'start with the pricing page',
        JSON.stringify(done.body.notes));

      const listed = (await get(A, '/entries')).items.find((i) => i.id === study);
      check('and the list no longer offers it', listed.note === null,
        JSON.stringify(listed.note));

      // SPENT MEANS SPENT. Re-confirming the same day must not hand it out
      // again, and there is nothing left to hand out anyway.
      //
      // Sent back with the note on it, which is what the page does: the block
      // is holding the words the last confirm handed it. A payload that left
      // the note out would be asking for it to be cleared, and that request is
      // honoured — see below.
      const id = again0(await blocksOn(DAY));
      const again = await post(A, '/plan', {
        date: DAY, wake_minutes: 480,
        blocks: [{ id, ...block('Rewire the study', study, 540, 'start with the pricing page') }],
      });
      const after = await blocksOn(DAY);
      check('re-confirming does not deliver it twice',
        again.body.notes.every((n) => n === null), JSON.stringify(again.body.notes));
      check('and the block keeps the one it was given',
        after.some((b) => b.note === 'start with the pricing page'), JSON.stringify(after));
      check('while the thing stays empty', (await noteOf(study)) === null,
        JSON.stringify(await noteOf(study)));

      // AND THE BLOCK RULE STILL HOLDS OVER IT. Once the words are on a block
      // they are that block's, so re-confirming without them clears them like
      // any other field of the day — there is nowhere for them to go back to,
      // because the thing has already given them up.
      const stripped = await post(A, '/plan', {
        date: DAY, wake_minutes: 480,
        blocks: [{ id, ...block('Rewire the study', study, 540) }],
      });
      check('a confirm that omits the note clears it, like anything else',
        stripped.status === 200 && (await blocksOn(DAY))[0].note === null,
        JSON.stringify(await blocksOn(DAY)));
      check('and it does not fall back onto the thing',
        (await noteOf(study)) === null, JSON.stringify(await noteOf(study)));

      await cleanup();
    }

    console.log('\n3. scheduled twice in one day, the note goes to the first block only');
    {
      const study = await thing('project', 'Rewire the study');
      await post(A, `/entries/${study}/note`, { note: 'bring the blue folder' });

      const DAY = '2031-03-11';
      const done = await post(A, '/plan', {
        date: DAY, wake_minutes: 480,
        blocks: [
          block('Rewire the study', study, 540),
          block('Rewire the study', study, 780),
        ],
      });
      check('the day confirms', done.status === 200, JSON.stringify(done.body));

      const rows = await blocksOn(DAY);
      check('there are two blocks for it', rows.length === 2, JSON.stringify(rows));
      check('the first has the note', rows[0].note === 'bring the blue folder',
        JSON.stringify(rows[0]));
      // TWO SESSIONS OF THE SAME WORK IS NOT THE SAME MESSAGE TWICE. This is
      // the case that would look right on screen and be wrong: the words would
      // appear on both blocks and read as deliberate.
      check('AND THE SECOND HAS NOTHING', rows[1].note === null, JSON.stringify(rows[1]));
      check('the answer names one position, not both',
        done.body.notes.filter(Boolean).length === 1, JSON.stringify(done.body.notes));
      check('and the thing is empty either way', (await noteOf(study)) === null,
        JSON.stringify(await noteOf(study)));

      await cleanup();
    }

    console.log('\n4. a block that already has its own note keeps it');
    {
      const study = await thing('project', 'Rewire the study');
      await post(A, `/entries/${study}/note`, { note: 'the message on the thing' });

      const DAY = '2031-03-12';
      await post(A, '/plan', {
        date: DAY, wake_minutes: 480,
        blocks: [block('Rewire the study', study, 540, 'what I am doing this morning')],
      });

      const rows = await blocksOn(DAY);
      check('the words written on the block survive',
        rows[0].note === 'what I am doing this morning', JSON.stringify(rows[0]));
      // NOTHING IS THROWN AWAY. The person said something more recent about
      // this session, and the message waiting on the thing is still waiting
      // for a scheduling with room for it.
      check('and the thing keeps its own, undelivered',
        (await noteOf(study)) === 'the message on the thing',
        JSON.stringify(await noteOf(study)));

      await cleanup();
    }

    console.log('\n5. clearing, refusing, and whose note it is');
    {
      const study = await thing('project', 'Rewire the study');

      await post(A, `/entries/${study}/note`, { note: 'something' });
      const cleared = await post(A, `/entries/${study}/note`, { note: '   ' });
      check('whitespace is not a note', cleared.status === 200 && cleared.body.note === null,
        JSON.stringify(cleared.body));
      check('and the column is null, not empty text', (await noteOf(study)) === null,
        JSON.stringify(await noteOf(study)));

      const nulled = await post(A, `/entries/${study}/note`, { note: null });
      check('null clears it too', nulled.status === 200, JSON.stringify(nulled.body));

      const wrong = await post(A, `/entries/${study}/note`, { note: { a: 1 } });
      check('a note must be text', wrong.status === 400, JSON.stringify(wrong.body));

      const huge = await post(A, `/entries/${study}/note`, { note: 'x'.repeat(501) });
      check('and it has a ceiling', huge.status === 400, JSON.stringify(huge.body));
      check('the ceiling is the same one a block has, because the text moves',
        /line or two/.test(huge.body.error || ''), huge.body.error);

      // The route reads and writes with the caller's own client, so this is row
      // level security asked one more way — but a note is free text that goes
      // out verbatim in a message, and writing one onto somebody else's thing
      // would put words in their day.
      await post(A, `/entries/${study}/note`, { note: 'mine' });
      const theirs = await post(B, `/entries/${study}/note`, { note: 'not yours' });
      check('B cannot write a note onto A\'s thing', theirs.status !== 200,
        `${theirs.status} ${JSON.stringify(theirs.body)}`);
      check('and A\'s note is untouched', (await noteOf(study)) === 'mine',
        JSON.stringify(await noteOf(study)));

      await cleanup();
    }
  } finally {
    await cleanup();
    if (server) server.kill();
  }

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nNotes hold');
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error('harness error:', e.message, '\n', e);
  try {
    await cleanup();
  } catch {
    // Nothing to do about it; the run is already failing.
  }
  if (server) server.kill();
  process.exit(1);
});
