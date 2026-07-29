// Block messages, composed in code.
//
// This used to be a model call with the whole day in view, and the suite that
// tested it made one real call and then read the prose that came back. There is
// no call now: a block message is its title, its two times, and at most one
// line that is arithmetic on two dates.
//
// So this is fixtures, and the only database work is the end-to-end section
// proving the composed line really lands on the row that delivery reads.
const H = require('./harness');
const U = H.TEST_USER_ID;
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const supabase = H.db;
const m = require(ROOT + '/messages.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const DATE = '2031-05-12';
const day = (n) => {
  const d = new Date(`${DATE}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const made = [];

(async () => {
  await H.assertGuarded();
  await H.ensureProfile();

  console.log('the header is facts from the row');
  {
    const without = {
      title: 'Gym', start_time: '08:00:00', duration_minutes: 60, message_text: null,
    };
    const withText = { ...without, message_text: '11 days since you last did this.' };

    check('title and real times', m.composeMessage(without) === '<b>Gym</b>\n08:00 to 09:00',
      JSON.stringify(m.composeMessage(without)));
    check('the line is appended when there is one',
      m.composeMessage(withText).endsWith('11 days since you last did this.'));
    check('no line still sends something', m.composeMessage(without).length > 0);

    const past = { ...without, start_time: '23:00:00', duration_minutes: 120 };
    check('an end past midnight wraps rather than reading 25:00',
      m.composeMessage(past).includes('23:00 to 01:00'), m.composeMessage(past));
  }

  console.log('\nthe deadline line, measured against the day being planned');
  {
    // Written the evening before and read the following morning, so every one
    // of these is relative to the plan date and not to today.
    check('a week out', m.dueLine(day(7), DATE) === 'Due in 7 days.', m.dueLine(day(7), DATE));
    check('tomorrow', m.dueLine(day(1), DATE) === 'Due tomorrow.', m.dueLine(day(1), DATE));
    check('today', m.dueLine(DATE, DATE) === 'Due today.', m.dueLine(DATE, DATE));
    check('yesterday', m.dueLine(day(-1), DATE) === 'Was due yesterday.', m.dueLine(day(-1), DATE));
    check('long past', m.dueLine(day(-9), DATE) === 'Was due 9 days ago.', m.dueLine(day(-9), DATE));
  }

  console.log('\nwhich fact a block gets');
  {
    const line = (entry, lastSeen) => m.contextLine({ entry, lastSeen, date: DATE });

    check('a deadline beats a gap',
      line({ due: day(2) }, day(-40)) === 'Due in 2 days.',
      String(line({ due: day(2) }, day(-40))));

    check('with no deadline, the gap is named',
      line({ due: null }, day(-11)) === '11 days since you last did this.',
      String(line({ due: null }, day(-11))));

    check('a short gap is not worth naming', line({ due: null }, day(-2)) === null,
      String(line({ due: null }, day(-2))));
    check('the threshold is three days',
      line({ due: null }, day(-3)) === '3 days since you last did this.',
      String(line({ due: null }, day(-3))));

    check('never scheduled says nothing rather than guessing',
      line({ due: null }, null) === null, String(line({ due: null }, null)));

    // A buffer block, or anything typed straight into the builder.
    check('a block with no entry gets no line', line(null, null) === null);
    check('even one with a gap to name', line(null, day(-40)) === null);
  }

  console.log('\nnothing in this path reaches the model');
  {
    const src = require('fs')
      .readFileSync(ROOT + '/messages.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check('no brain', !/runBrain|anthropic/i.test(src));
    check('no tools', !/get_calendar|search_entries/.test(src));
    check('no fencing, because there is no prompt to fence into', !/untrusted|fence/.test(src));
    check('no parser, because there is no reply to parse', !/parseLines/.test(src));
    check('and no database of its own', !/supabase/.test(src));
  }

  console.log('\nend to end: the line lands on the row delivery reads');
  {
    const { data: habit, error: habitErr } = await supabase
      .from('entries')
      .insert({ user_id: U, type: 'habit', title: '__probe habit', frequency: 'daily' })
      .select('id, title')
      .single();
    if (habitErr) throw new Error(habitErr.message);

    const { data: task, error: taskErr } = await supabase
      .from('entries')
      .insert({ user_id: U, type: 'task', title: '__probe task', due: day(3), size: 'a day' })
      .select('id, title')
      .single();
    if (taskErr) throw new Error(taskErr.message);

    // An older plan the habit was on, eleven days before the day being built.
    const { data: old } = await supabase
      .from('plans')
      .insert({ user_id: U, date: day(-11), wake_time: '08:00:00', status: 'confirmed' })
      .select('id')
      .single();
    made.push(old.id);
    await supabase.from('blocks').insert({
      user_id: U, plan_id: old.id, title: habit.title, entry_id: habit.id,
      start_time: '08:00:00', duration_minutes: 60, sort_order: 0, pinned: false,
    });

    // Now confirm the day itself, through the real route logic.
    const PORT = 3977;
    const BASE = `http://127.0.0.1:${PORT}`;
    const server = H.spawnServer(PORT);
    if (!(await H.waitFor(BASE))) throw new Error('server never came up');

    const res = await fetch(`${BASE}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        date: DATE,
        wake_minutes: 480,
        blocks: [
          { title: habit.title, entryId: habit.id, start_minutes: 480, duration_minutes: 60 },
          { title: task.title, entryId: task.id, start_minutes: 540, duration_minutes: 60 },
          { title: 'Buffer', entryId: null, start_minutes: 600, duration_minutes: 30 },
        ],
      }),
    });
    const saved = await res.json();
    check('the day saved', res.status === 200 && saved.blocks === 3, JSON.stringify(saved));

    const { data: plan } = await supabase
      .from('plans').select('id').eq('user_id', U).eq('date', DATE).single();
    made.push(plan.id);

    const { data: written } = await supabase
      .from('blocks')
      .select('title, message_text, start_time, duration_minutes')
      .eq('plan_id', plan.id)
      .order('sort_order');

    for (const b of written) console.log(`    ${b.title}: ${JSON.stringify(b.message_text)}`);

    check('the habit carries its gap',
      written[0].message_text === '11 days since you last did this.', String(written[0].message_text));
    check('the task carries its deadline',
      written[1].message_text === 'Due in 3 days.', String(written[1].message_text));
    check('the buffer carries nothing', written[2].message_text === null,
      String(written[2].message_text));

    // The plan being confirmed must not count as a scheduling of its own, or
    // every line would claim zero days.
    check('the day being saved did not reset the clock',
      !/0 days/.test(written[0].message_text), written[0].message_text);

    console.log('\n    as Telegram would receive them:');
    for (const b of written) {
      console.log('    ' + m.composeMessage(b).replace(/\n/g, '\n    ') + '\n');
    }

    server.kill();
    await supabase.from('entries').delete().eq('user_id', U).in('id', [habit.id, task.id]);
  }

  console.log('cleanup');
  for (const id of made) await supabase.from('plans').delete().eq('user_id', U).eq('id', id);
  await H.cleanup();
  const { count: plansLeft } = await supabase
    .from('plans').select('*', { count: 'exact', head: true }).eq('user_id', U);
  const { count: blocksLeft } = await supabase
    .from('blocks').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('no plans left', plansLeft === 0, `${plansLeft}`);
  check('no blocks left', blocksLeft === 0, `${blocksLeft}`);

  console.log(bad === 0 ? '\nMessages clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  for (const id of made) await supabase.from('plans').delete().eq('user_id', U).eq('id', id);
  await H.cleanup();
  process.exit(1);
});
