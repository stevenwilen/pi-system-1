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

  console.log('\nthe note, verbatim, on its own line');
  {
    const base = { title: 'UF application', start_time: '09:00:00', duration_minutes: 120 };

    const noted = m.composeMessage({ ...base, note: 'Finish the essay draft', message_text: null });
    check('it follows the header', noted === '<b>UF application</b>\n09:00 to 11:00\n\nFinish the essay draft',
      JSON.stringify(noted));

    const GAP = '11 days since you last did this.';

    const both = m.composeMessage({
      ...base, note: 'Finish the essay draft', message_text: GAP,
    });
    check('their words come before ours',
      both.indexOf('Finish the essay draft') < both.indexOf(GAP), both);
    check('and each gets its own line',
      both === `<b>UF application</b>\n09:00 to 11:00\n\nFinish the essay draft\n\n${GAP}`,
      JSON.stringify(both));

    check('no note is no line', m.composeMessage({ ...base, note: null, message_text: GAP }) ===
      `<b>UF application</b>\n09:00 to 11:00\n\n${GAP}`);
    check('an empty note is no line either',
      !m.composeMessage({ ...base, note: '', message_text: null }).includes('\n\n'));

    // Verbatim means verbatim. Nothing here trims, truncates or rewrites.
    const odd = m.composeMessage({ ...base, note: '  a <b>bold</b> claim  ', message_text: null });
    check('it is not trimmed or escaped here', odd.includes('  a <b>bold</b> claim  '), JSON.stringify(odd));
    check('escaping is telegram.js\'s job, and it does it', (() => {
      const src = require('fs').readFileSync(ROOT + '/telegram.js', 'utf8');
      return /replace\(\/</.test(src) && /toTelegramHtml/.test(src);
    })());
  }

  console.log('\nthe gap, and nothing but the gap');
  {
    const line = (entry, lastSeen) => m.contextLine({ entry, lastSeen, date: DATE });

    check('the gap is named', line({}, day(-11)) === '11 days since you last did this.',
      String(line({}, day(-11))));
    check('a short gap is not worth naming', line({}, day(-2)) === null,
      String(line({}, day(-2))));
    check('the threshold is three days', line({}, day(-3)) === '3 days since you last did this.',
      String(line({}, day(-3))));
    check('never scheduled says nothing rather than guessing',
      line({}, null) === null, String(line({}, null)));

    // The deadline used to be named here and used to beat the gap. It is on
    // the screen as a warning mark instead, where it can be read against
    // everything else wanting the same days.
    check('a deadline is not named',
      line({ due: day(2) }, day(-40)) === '40 days since you last did this.',
      String(line({ due: day(2) }, day(-40))));
    check('and does not suppress the gap either',
      line({ due: day(2) }, day(-11)) === '11 days since you last did this.',
      String(line({ due: day(2) }, day(-11))));
    check('a due entry with no gap gets nothing at all',
      line({ due: day(2) }, null) === null, String(line({ due: day(2) }, null)));

    check('there is no deadline composer left', m.dueLine === undefined);

    const src = require('fs')
      .readFileSync(ROOT + '/messages.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    check('and nothing in the file writes one', !/Due (in|today|tomorrow)|Was due/.test(src));

    // Anything typed straight into the builder, or one whose entry has since
    // been deleted.
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
          { title: habit.title, entryId: habit.id, start_minutes: 480, duration_minutes: 60,
            note: 'twenty pages, no phone' },
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
      .select('title, message_text, note, start_time, duration_minutes')
      .eq('plan_id', plan.id)
      .order('sort_order');

    for (const b of written) console.log(`    ${b.title}: ${JSON.stringify(b.message_text)}`);

    check('the note reached the row', written[0].note === 'twenty pages, no phone',
      String(written[0].note));
    check('and a block without one stored null', written[1].note === null,
      String(written[1].note));
    check('the message carries both the note and the gap',
      m.composeMessage(written[0]).includes('twenty pages, no phone') &&
        m.composeMessage(written[0]).includes('11 days since'),
      m.composeMessage(written[0]).replace(/\n/g, ' / '));

    check('the habit carries its gap',
      written[0].message_text === '11 days since you last did this.', String(written[0].message_text));
    // It has a due date and has never been scheduled, so there is no gap to
    // name and the deadline is not named anywhere in a message any more.
    check('the task with a deadline carries no line at all',
      written[1].message_text === null, String(written[1].message_text));
    check('and certainly not its due date',
      !/Due/.test(written[1].message_text || ''), String(written[1].message_text));
    check('the manual block carries nothing', written[2].message_text === null,
      String(written[2].message_text));

    // The plan being confirmed must not count as a scheduling of its own, or
    // every line would claim zero days.
    check('the day being saved did not reset the clock',
      !/0 days/.test(written[0].message_text), written[0].message_text);

    // A deleted thing says nothing, even while a block for it survives.
    //
    // This is reachable in four taps: schedule a thing, delete the thing, keep
    // the block, confirm. It used to compose a line from the deleted row and
    // send a deadline the next morning for something thrown away the night
    // before, because this was the one read of `entries` with no status
    // filter on it.
    await supabase.from('entries').update({ status: 'deleted' }).eq('user_id', U).eq('id', task.id);

    const res2 = await fetch(`${BASE}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        date: DATE,
        wake_minutes: 480,
        blocks: [
          { title: habit.title, entryId: habit.id, start_minutes: 480, duration_minutes: 60 },
          { title: task.title, entryId: task.id, start_minutes: 540, duration_minutes: 60 },
        ],
      }),
    });
    check('the day still saves with a block for a deleted thing', res2.status === 200, `${res2.status}`);

    const { data: after } = await supabase
      .from('blocks')
      .select('title, message_text')
      .eq('plan_id', plan.id)
      .order('sort_order');

    check('the deleted thing gets no line', after[1].message_text === null,
      String(after[1].message_text));
    check('and certainly not its deadline', !/Due in/.test(after[1].message_text || ''),
      String(after[1].message_text));
    check('the block itself survives', after[1].title === task.title, after[1].title);
    check('and the thing still on the list is unaffected',
      after[0].message_text === '11 days since you last did this.', String(after[0].message_text));

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
