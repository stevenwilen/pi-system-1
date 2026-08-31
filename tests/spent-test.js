// Notes whose session has happened.
//
// A note on a thing is a first step for the next time it is scheduled. Once that
// session has been and gone the words are spent, and this lane is the only thing
// that clears them.
//
// THE CASES THAT MATTER ARE THE ONES IT REFUSES. Clearing a note is a small
// write and an irreversible one: the words are not recoverable from anywhere,
// because the block's copy belongs to a day rather than to the thing. So most of
// what follows is about the rows it has to leave alone.
const H = require('./harness');
let U;
const ROOT = H.ROOT;
process.chdir(ROOT);

const supabase = H.db;

// Loaded with cron disabled. Without this, requiring the module starts the
// timer and fires every lane against the real database.
process.env.SCHEDULER_DISABLED = '1';
const scheduler = require(ROOT + '/scheduler.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Dates nothing else in the suite uses, and the days either side of one.
const TODAY = '2031-11-12';
const YESTERDAY = '2031-11-11';
const TOMORROW = '2031-11-13';

const now = () => ({ date: TODAY, hour: 11, minute: 0, weekday: 'Wed' });
const profile = () => ({ user_id: U, timezone: 'UTC' });

const clear = async () => {
  // Every delete filters on the account. The harness refuses one that does not,
  // and it is right to: a delete on blocks by plan_id alone would be a write
  // with nothing tying it to a test account.
  await supabase.from('blocks').delete().eq('user_id', U);
  await supabase.from('plans').delete().eq('user_id', U);
  await supabase.from('entries').delete().eq('user_id', U);
};

const thing = async (type, title, note, extra = {}) => {
  const row = { user_id: U, type, title, note, status: 'active', ...extra };
  if (type === 'habit' && !row.frequency) row.frequency = 'daily';
  const { data, error } = await supabase.from('entries').insert(row).select('id').single();
  if (error) throw new Error(`could not make ${title}: ${error.message}`);
  return data.id;
};

/** A day, and one block in it for each entry named. */
const dayWith = async (date, status, entryIds) => {
  const { data: plan, error } = await supabase
    .from('plans')
    .insert({ user_id: U, date, status, wake_time: '08:00:00' })
    .select('id')
    .single();
  if (error) throw new Error(`could not make the ${date} plan: ${error.message}`);

  let at = 0;
  for (const id of entryIds) {
    const { error: blockErr } = await supabase.from('blocks').insert({
      user_id: U,
      plan_id: plan.id,
      entry_id: id,
      title: 'a session',
      start_time: '09:00:00',
      duration_minutes: 30,
      sort_order: at,
    });
    if (blockErr) throw new Error(`could not make a block: ${blockErr.message}`);
    at += 1;
  }
  return plan.id;
};

const noteOf = async (id) => {
  const { data } = await supabase.from('entries').select('note').eq('id', id).maybeSingle();
  return data ? data.note : '(row gone)';
};

(async () => {
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();
  await clear();

  console.log('a note is spent by a day that has passed');
  {
    const task = await thing('task', 'Rewire the study', 'start with the pricing page');
    const project = await thing('project', 'UF application', 'open the essay draft');
    await dayWith(YESTERDAY, 'confirmed', [task, project]);

    await scheduler.clearSpentNotes(profile(), now());

    check('a task loses its note', (await noteOf(task)) === null,
      JSON.stringify(await noteOf(task)));
    check('and so does a project', (await noteOf(project)) === null,
      JSON.stringify(await noteOf(project)));

    await clear();
  }

  console.log('\na habit keeps its note, however many days have passed');
  {
    // A habit's note is standing: it is read every time the habit is scheduled,
    // so clearing it would destroy it rather than spend it.
    const habit = await thing('habit', 'Reading', 'ten pages, no phone');
    const task = await thing('task', 'Rewire the study', 'start with the pricing page');
    await dayWith(YESTERDAY, 'confirmed', [habit, task]);

    await scheduler.clearSpentNotes(profile(), now());

    check('the habit keeps its words', (await noteOf(habit)) === 'ten pages, no phone',
      JSON.stringify(await noteOf(habit)));
    check('while the task beside it is spent', (await noteOf(task)) === null,
      JSON.stringify(await noteOf(task)));

    await clear();
  }

  console.log('\nand a one-off task is spent like any other task');
  {
    // THE REASON THE FILTER IS ON THE TYPE. A one-off stores its flag in the
    // frequency column, so a filter on that column would have read this row as
    // a habit and left its note behind for ever.
    const oneOff = await thing('task', 'Call the dentist', 'ask about the Thursday slot', {
      frequency: 'one off',
    });
    await dayWith(YESTERDAY, 'confirmed', [oneOff]);

    await scheduler.clearSpentNotes(profile(), now());
    check('its note is spent', (await noteOf(oneOff)) === null,
      JSON.stringify(await noteOf(oneOff)));

    await clear();
  }

  console.log('\nnothing is spent by a day that has not finished');
  {
    // STRICTLY BEFORE TODAY. A block scheduled for this afternoon has not
    // happened because the sweep ran this morning.
    const todayTask = await thing('task', 'Today', 'the words for today');
    const laterTask = await thing('task', 'Tomorrow', 'the words for tomorrow');
    await dayWith(TODAY, 'confirmed', [todayTask]);
    await dayWith(TOMORROW, 'confirmed', [laterTask]);

    await scheduler.clearSpentNotes(profile(), now());

    check('today keeps its note', (await noteOf(todayTask)) === 'the words for today',
      JSON.stringify(await noteOf(todayTask)));
    check('and so does tomorrow', (await noteOf(laterTask)) === 'the words for tomorrow',
      JSON.stringify(await noteOf(laterTask)));

    await clear();
  }

  console.log('\nnor by a day that was never agreed to');
  {
    // A day built and never confirmed is a draft. Spending a note off the back
    // of one would be the system deciding what happened.
    const task = await thing('task', 'Rewire the study', 'start with the pricing page');
    await dayWith(YESTERDAY, 'pending', [task]);

    await scheduler.clearSpentNotes(profile(), now());
    check('a pending day spends nothing',
      (await noteOf(task)) === 'start with the pricing page',
      JSON.stringify(await noteOf(task)));

    await clear();
  }

  console.log('\nnor by a day the block was taken out of');
  {
    // THE HALF THAT MAKES THIS SAFE. Taking a block out of the day is how you
    // say it did not happen, so a thing that was scheduled and then pulled has
    // not had its session and keeps the words for the next attempt.
    const kept = await thing('task', 'Did happen', 'the words that are spent');
    const pulled = await thing('task', 'Did not happen', 'the words that survive');
    await dayWith(YESTERDAY, 'confirmed', [kept, pulled]);

    // Out of the day, the way a confirm removes one.
    await supabase.from('blocks').delete().eq('user_id', U).eq('entry_id', pulled);

    await scheduler.clearSpentNotes(profile(), now());

    check('the one that stayed is spent', (await noteOf(kept)) === null,
      JSON.stringify(await noteOf(kept)));
    check('the one that was pulled keeps its words',
      (await noteOf(pulled)) === 'the words that survive',
      JSON.stringify(await noteOf(pulled)));

    await clear();
  }

  console.log('\nand a second sweep over the same day writes nothing');
  {
    // Nothing is stored about whether a note was spent. The "note is not null"
    // filter is what makes this a no-op rather than a second write, and what a
    // case can see is that the second run reports no rows.
    const task = await thing('task', 'Rewire the study', 'start with the pricing page');
    await dayWith(YESTERDAY, 'confirmed', [task]);

    const first = await scheduler.clearSpentNotes(profile(), now());
    check('the first sweep clears one', first.length === 1, String(first.length));

    const second = await scheduler.clearSpentNotes(profile(), now());
    check('the second clears none', second.length === 0, String(second.length));
    check('and the note is still gone', (await noteOf(task)) === null,
      JSON.stringify(await noteOf(task)));

    await clear();
  }

  console.log('\nthe block keeps its own copy of the words');
  {
    // The block's note is the record of what that session was for. It belongs
    // to the day rather than to the thing, and nothing in this lane touches it.
    const task = await thing('task', 'Rewire the study', 'start with the pricing page');
    const planId = await dayWith(YESTERDAY, 'confirmed', [task]);
    await supabase
      .from('blocks')
      .update({ note: 'start with the pricing page' })
      .eq('user_id', U)
      .eq('plan_id', planId);

    await scheduler.clearSpentNotes(profile(), now());

    const { data: block } = await supabase
      .from('blocks')
      .select('note')
      .eq('user_id', U)
      .eq('plan_id', planId)
      .maybeSingle();

    check('the thing is spent', (await noteOf(task)) === null,
      JSON.stringify(await noteOf(task)));
    check('and the block still holds the words',
      block && block.note === 'start with the pricing page',
      JSON.stringify(block && block.note));

    await clear();
  }

  console.log('\ncleanup');
  await clear();
  const { count } = await H.service
    .from('entries')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nSpent notes clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message, '\n', (e.stack || '').split('\n').slice(0, 4).join('\n'));
  try { await clear(); } catch {}
  process.exit(1);
});
