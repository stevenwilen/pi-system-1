// Step 4. Real plan, real blocks, real entries, and one real model call.
const H = require('./harness');
const U = H.TEST_USER_ID;
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const supabase = H.db;
const m = require(ROOT + '/messages.js');
const { lastScheduled } = require(ROOT + '/staleness.js');


let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const made = [];

async function makePlan(date, blocks) {
  const { data: plan } = await supabase
    .from('plans').insert({ user_id: U, date, wake_time: '08:00:00', status: 'confirmed' })
    .select('id').single();
  made.push(plan.id);
  if (blocks.length) {
    // Every key on every row. A PostgREST bulk insert takes the union of keys
    // across the array and sends NULL for any a given object is missing, so a
    // row that simply omits `pinned` violates its NOT NULL rather than picking
    // up the column default.
    const { error } = await supabase.from('blocks').insert(
      blocks.map((b, i) => ({
        user_id: U,
        plan_id: plan.id,
        sort_order: i,
        entry_id: null,
        pinned: false,
        ...b,
      }))
    );
    if (error) throw new Error(`block insert for ${date}: ${error.message}`);
  }
  return plan.id;
}

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  console.log('parser');
  check('accepts a clean reply', m.parseLines('1| one\n2| two', 2) instanceof Map);
  check('tolerates surrounding blank lines', m.parseLines('\n1| one\n\n2| two\n', 2).size === 2);
  check('rejects a missing block', m.parseLines('1| one', 2) === null);
  check('rejects an extra block', m.parseLines('1| a\n2| b\n3| c', 2) === null);
  check('rejects a duplicate index', m.parseLines('1| a\n1| b', 2) === null);
  check('rejects an out of range index', m.parseLines('1| a\n5| b', 2) === null);
  check('rejects an empty line', m.parseLines('1| \n2| b', 2) === null);
  check('rejects an overlong line', m.parseLines(`1| ${'x'.repeat(200)}\n2| b`, 2) === null);
  check('rejects prose', m.parseLines('Here are your messages!', 2) === null);
  check('rejects JSON', m.parseLines('[{"1":"a"}]', 2) === null);

  console.log('\ncompose, and the failure fallback');
  const withText = { title: 'Gym', start_time: '08:00:00', duration_minutes: 60, message_text: '11 days since you last did this.' };
  const without = { title: 'Gym', start_time: '08:00:00', duration_minutes: 60, message_text: null };
  check('header carries title and real times', m.composeMessage(without) === '<b>Gym</b>\n08:00 to 09:00', JSON.stringify(m.composeMessage(without)));
  check('line is appended when present', m.composeMessage(withText).endsWith('11 days since you last did this.'));
  check('no stored line still sends something', m.composeMessage(without).length > 0);

  console.log('\nstaleness excludes the plan being confirmed');
  // Creates its own entry: the notebook can legitimately be empty.
  const { data: habit, error: habitErr } = await supabase
    .from('entries')
    .insert({ user_id: U, type: 'habit', title: '__probe habit', frequency: '4-5x/week' })
    .select('id, title')
    .single();
  if (habitErr) throw new Error(habitErr.message);
  const probeEntry = habit.id;

  const oldPlan = await makePlan('2031-05-01', [
    { title: habit.title, entry_id: habit.id, start_time: '08:00:00', duration_minutes: 60 },
  ]);
  const newPlan = await makePlan('2031-05-12', [
    { title: habit.title, entry_id: habit.id, start_time: '08:00:00', duration_minutes: 60 },
    { title: 'Dentist', entry_id: null, start_time: '10:00:00', duration_minutes: 45, pinned: true },
  ]);

  const naive = await lastScheduled(U);
  const excluded = await lastScheduled(U, { excludePlanId: newPlan });
  check('without exclusion it sees the plan itself', naive.get(habit.id) === '2031-05-12', naive.get(habit.id));
  check('with exclusion it sees the previous one', excluded.get(habit.id) === '2031-05-01', excluded.get(habit.id));

  console.log('\nbriefing');
  const briefing = await m.buildBriefing(U, newPlan);
  const text = m.renderBriefing(briefing);
  console.log('\n' + text.split('\n').map((l) => '    ' + l).join('\n') + '\n');

  check('names the date', text.includes('2031-05-12'));
  check('states the shape of the day', /runs 08:00 to 10:45, with 1h 45m across 2 blocks/.test(text), text.split('\n')[1]);
  check('marks the pinned block as immovable', /fixed calendar event, cannot move/.test(text));
  check('carries the habit frequency', /meant to happen/.test(text));
  check('reports 11 days, not 0', /last scheduled 11 days before this day/.test(text));
  check('no why invented for a habit', !/why it matters/.test(text));

  console.log('\none real model call');
  const before = Date.now();
  const result = await m.generateForPlan(U, newPlan);
  console.log(`    took ${Math.round((Date.now() - before) / 1000)}s`);

  check('wrote a line for every block', result.written === 2, JSON.stringify(result));

  const { data: written } = await supabase
    .from('blocks').select('title, message_text, start_time, duration_minutes').eq('plan_id', newPlan).order('sort_order');

  for (const b of written) console.log(`    ${b.title}: ${JSON.stringify(b.message_text)}`);

  check('both blocks have text', written.every((b) => b.message_text && b.message_text.trim().length));
  check('lines stay within one sentence', written.every((b) => b.message_text.length <= 180));
  check('no line repeats the clock time', written.every((b) => !/\d{1,2}:\d{2}/.test(b.message_text)));
  check('no line asks a question', written.every((b) => !b.message_text.includes('?')));
  check('no em dashes', written.every((b) => !b.message_text.includes('\u2014')));
  check('staleness reached the output', written.some((b) => /11 day|eleven day/i.test(b.message_text)),
    'at least one line should mention the gap');

  console.log('\nfull messages as Telegram would receive them:');
  for (const b of written) console.log('    ' + m.composeMessage(b).replace(/\n/g, '\n    ') + '\n');

  console.log('failure paths');
  const missing = await m.generateForPlan(U, '00000000-0000-0000-0000-0000000000ff');
  check('unknown plan returns rather than throws', missing.written === 0 && Boolean(missing.reason), JSON.stringify(missing));

  const emptyPlan = await makePlan('2031-05-20', []);
  const noBlocks = await m.generateForPlan(U, emptyPlan);
  check('plan with no blocks returns rather than throws', noBlocks.written === 0, JSON.stringify(noBlocks));

  console.log('\ncleanup');
  await supabase.from('entries').delete().eq('user_id', U).eq('id', probeEntry);
  for (const id of made) await supabase.from('plans').delete().eq('user_id', U).eq('id', id);
  const { count: plansLeft } = await supabase.from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U);
  const { count: blocksLeft } = await supabase.from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('no plans left', plansLeft === 0, `${plansLeft}`);
  check('no blocks left', blocksLeft === 0, `${blocksLeft}`);

  console.log(bad === 0 ? '\nStep 4 clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  for (const id of made) await supabase.from('plans').delete().eq('user_id', U).eq('id', id);
  process.exit(1);
});
