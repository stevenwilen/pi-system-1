// Block messages, read straight off the row.
//
// This has shrunk with the thing it tests. It was one real model call and a
// read of the prose that came back; then fixtures for a line composed from two
// dates; and now there is no composition at all. A block message is its title,
// its two times, and whatever the person wrote about the session.
//
// So most of this is fixtures, and the database section proves two things: the
// note reaches the row delivery reads, and confirming a day writes no
// message_text at all any more.
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
    const bare = { title: 'Gym', start_time: '08:00:00', duration_minutes: 60 };

    // Twelve hour, because that is how the person reads a clock. Storage is
    // untouched: the row still says 08:00:00.
    check('title and real times', m.composeMessage(bare) === '<b>Gym</b>\n8:00 AM to 9:00 AM',
      JSON.stringify(m.composeMessage(bare)));
    check('a block with nothing to add still sends something',
      m.composeMessage(bare).length > 0);

    const past = { ...bare, start_time: '23:00:00', duration_minutes: 120 };
    check('an end past midnight wraps rather than reading 25:00',
      m.composeMessage(past).includes('11:00 PM to 1:00 AM'), m.composeMessage(past));
  }

  console.log('\nthe note, verbatim, and nothing else');
  {
    const base = { title: 'UF application', start_time: '09:00:00', duration_minutes: 120 };

    const noted = m.composeMessage({ ...base, note: 'Finish the essay draft' });
    check('it follows the header',
      noted === '<b>UF application</b>\n9:00 AM to 11:00 AM\n\nFinish the essay draft',
      JSON.stringify(noted));

    check('no note is no second part',
      m.composeMessage({ ...base, note: null }) === '<b>UF application</b>\n9:00 AM to 11:00 AM');
    check('an empty note is no second part either',
      !m.composeMessage({ ...base, note: '' }).includes('\n\n'));

    // Verbatim means verbatim. Nothing here trims, truncates or rewrites.
    const odd = m.composeMessage({ ...base, note: '  a <b>bold</b> claim  ' });
    check('it is not trimmed or escaped here', odd.includes('  a <b>bold</b> claim  '),
      JSON.stringify(odd));
    check("escaping is telegram.js's job, and it does it", (() => {
      const src = require('fs').readFileSync(ROOT + '/telegram.js', 'utf8');
      return /replace\(\/</.test(src) && /toTelegramHtml/.test(src);
    })());
  }

  console.log('\nnothing is derived and put in a message any more');
  {
    // Both lines this used to add are gone, for one reason twice: the screen
    // had already shown the person the fact on the evening they made the plan,
    // and repeating it at the block's start time named a thing they had
    // decided about at the hour they could least act on it.
    const withEverything = {
      title: 'UF application', start_time: '09:00:00', duration_minutes: 120,
      note: 'Finish the essay draft',
      // Left over from an older build, and no longer read.
      message_text: '11 days since you last did this.',
    };
    const out = m.composeMessage(withEverything);

    check('a stored line from an older confirm is ignored',
      !out.includes('11 days since'), JSON.stringify(out));
    check('the note is still there', out.includes('Finish the essay draft'));
    check('so the message is exactly two parts',
      out.split('\n\n').length === 2, JSON.stringify(out));

    const src = require('fs')
      .readFileSync(ROOT + '/messages.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check('no deadline is composed', !/Due (in|today|tomorrow)|Was due/.test(src));
    check('no gap is composed', !/days since/.test(src));
    check('there is no context line composer left', m.contextLine === undefined);
    check('nor a deadline one', m.dueLine === undefined);
    check('and message_text is not read', !/message_text/.test(src));
  }

  console.log('\nwhat is still to come');
  {
    // 09:00-10:00 over, 10:00-11:00 running, 11:00-12:00 ahead. It is 10:30.
    const day = [
      { title: 'Third', start_time: '11:00:00', duration_minutes: 60 },
      { title: 'First', start_time: '09:00:00', duration_minutes: 60 },
      { title: 'Second', start_time: '10:00:00', duration_minutes: 60 },
    ];
    const names = (rows) => rows.map((r) => r.title).join(',');

    check('the payload order is not trusted',
      names(m.blocksStillToCome(day, null)) === 'First,Second,Third',
      names(m.blocksStillToCome(day, null)));

    const at1030 = m.blocksStillToCome(day, 10 * 60 + 30);
    check('a block that has ended is gone', !names(at1030).includes('First'), names(at1030));
    check('the one in progress stays, because it is what is going on',
      names(at1030) === 'Second,Third', names(at1030));

    // The two boundaries, which are the only places this can be wrong.
    check('ending exactly now is over',
      names(m.blocksStillToCome(day, 10 * 60)) === 'Second,Third',
      names(m.blocksStillToCome(day, 10 * 60)));
    check('starting exactly now has begun, and is going on',
      names(m.blocksStillToCome(day, 11 * 60)) === 'Third',
      names(m.blocksStillToCome(day, 11 * 60)));

    check('a day entirely past comes to nothing',
      m.blocksStillToCome(day, 23 * 60).length === 0);
    check('and null means the whole day, for a day that is not today',
      m.blocksStillToCome(day, null).length === 3);
  }

  console.log('\nthe schedule sent at confirm time');
  {
    const day = [
      { title: 'Morning routine', start_time: '09:30:00', duration_minutes: 120 },
      { title: 'Automate mom\'s investment account', start_time: '11:30:00', duration_minutes: 30 },
      { title: 'Eat', start_time: '12:00:00', duration_minutes: 60 },
      { title: 'Pack for trip', start_time: '14:30:00', duration_minutes: 60 },
    ];
    const text = m.composeSchedule(day, 'Today');
    const lines = text.split('\n');

    check('the label is the first line', lines[0] === 'Today', lines[0]);
    check('and stands outside the block, as prose', !/<pre>/.test(lines[0]));

    // The whole point of the monospace block: Telegram's font is proportional,
    // so "9:30 AM" and "11:30 AM" are different widths and padded spaces line
    // nothing up. Inside <pre> they do.
    check('the list is wrapped in pre', /<pre>\n/.test(text) && /\n<\/pre>/.test(text));

    const body = text.slice(text.indexOf('<pre>') + 6, text.indexOf('</pre>') - 1).split('\n');
    check('one line per block', body.length === 4, `${body.length}`);
    check('the times are right-aligned into a column',
      body.every((l) => l.indexOf(':') === body[0].indexOf(':')),
      JSON.stringify(body.map((l) => l.indexOf(':'))));
    check('a single-digit hour is padded, not shifted',
      body[0].startsWith(' 9:30 AM') && body[1].startsWith('11:30 AM'),
      JSON.stringify(body.slice(0, 2)));
    check('and the title follows the time', /9:30 AM {2}Morning routine$/.test(body[0]), body[0]);

    // Start times only. Each end is the next start, and the one end that is
    // not implied is the day's.
    check('no line carries an end time', !body.some((l) => /\bto\b|–/.test(l)),
      JSON.stringify(body));
    check('the last line is the day ending', lines[lines.length - 1] === 'Ends 3:30 PM',
      lines[lines.length - 1]);
    check('and it is outside the block too', text.indexOf('</pre>') < text.indexOf('Ends'));

    // Nothing left to say.
    check('an empty day composes nothing', m.composeSchedule([], 'Today') === null);
    check('and so does a missing one', m.composeSchedule(null, 'Today') === null);

    console.log('\n    as Telegram would receive it:');
    console.log('    ' + text.replace(/\n/g, '\n    ') + '\n');
  }

  console.log('\nthe schedule survives escaping, and a title does not');
  {
    const { toTelegramHtml } = require(ROOT + '/telegram.js');

    const text = m.composeSchedule(
      [{ title: 'Read <Dune> & think', start_time: '09:00:00', duration_minutes: 60 }],
      'Today'
    );
    const out = toTelegramHtml(text);

    check('the pre tags come through as tags',
      /<pre>/.test(out) && /<\/pre>/.test(out), out);
    check('but a title\'s angle brackets are escaped',
      /&lt;Dune&gt;/.test(out) && !/<Dune>/.test(out), out);
    check('and its ampersand too', /&amp;/.test(out), out);

    // The allowlist, stated. Anything not on it renders as text.
    check('a tag that is not allowed stays text',
      /&lt;script&gt;/.test(toTelegramHtml('<script>')), toTelegramHtml('<script>'));
    check('b and i still pass', toTelegramHtml('<b>x</b> <i>y</i>') === '<b>x</b> <i>y</i>',
      toTelegramHtml('<b>x</b> <i>y</i>'));
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
    check('no database of its own', !/supabase/.test(src));
    check('and no date arithmetic left either', !/daysUntil|staleness/.test(src));
  }

  console.log('\nend to end: what confirming a day writes');
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
    // It used to make the habit's message say so; now it makes no difference
    // to the message at all, which is what the checks below are for.
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
      .select('title, note, message_text, start_time, duration_minutes')
      .eq('plan_id', plan.id)
      .order('sort_order');

    check('the note reached the row', written[0].note === 'twenty pages, no phone',
      String(written[0].note));
    check('and a block without one stored null', written[1].note === null,
      String(written[1].note));

    // The whole point of this deploy: confirming composes nothing.
    check('no line was composed for the habit with an eleven day gap',
      written[0].message_text === null, String(written[0].message_text));
    check('nor for the task with a deadline three days out',
      written[1].message_text === null, String(written[1].message_text));
    check('nor for the manual block', written[2].message_text === null,
      String(written[2].message_text));

    console.log('\n    as Telegram would receive them:');
    for (const b of written) {
      console.log('    ' + m.composeMessage(b).replace(/\n/g, '\n    ') + '\n');
    }

    check('the block with a note sends it',
      m.composeMessage(written[0]) ===
        `<b>${habit.title}</b>\n8:00 AM to 9:00 AM\n\ntwenty pages, no phone`,
      JSON.stringify(m.composeMessage(written[0])));
    check('the one without sends the header alone',
      m.composeMessage(written[1]) === `<b>${task.title}</b>\n9:00 AM to 10:00 AM`,
      JSON.stringify(m.composeMessage(written[1])));

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
