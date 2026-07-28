// The planner's setup interview, end to end.
//
// The thing this has to get right is that state ages: a note about where
// something stands is true the day it is written and drifts from then on, and
// nothing is allowed to read the words without the date.
const H = require('./harness');
const U = H.TEST_USER_ID;
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const intent = require(ROOT + '/plan-intent.js');
const messages = require(ROOT + '/messages.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const PORT = 3977;
const BASE = `http://127.0.0.1:${PORT}`;
let server;

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
};

const clear = async () => {
  await H.db.from('blocks').delete().eq('user_id', U);
  await H.db.from('plans').delete().eq('user_id', U);
  await H.db.from('entries').delete().eq('user_id', U);
};

const INTERVIEW = {
  items: [
    {
      type: 'project', title: 'Thesis', why: 'It is the whole year',
      state: 'Chapter two drafted, chapter three next', size: 'months',
    },
    {
      type: 'project', title: 'Website', why: 'Clients cannot find me',
      state: 'Landing page done, pricing next', size: 'weeks',
    },
    { type: 'habit', title: 'Gym', frequency: 'few-times-weekly', why: 'Back pain' },
    { type: 'task', title: 'Renew passport', state: 'Need photos first, about an hour', due: '2031-05-01' },
    { type: 'habit', title: 'Reading', frequency: 'daily', why: null },
  ],
};

(async () => {
  await H.assertGuarded();
  await H.ensureProfile();
  await clear();

  server = H.spawnServer(PORT);
  if (!(await H.waitFor(BASE))) throw new Error('server never came up');

  console.log('the prompt is engine text');
  {
    const r = await get('/plan-intent/setup-prompt');
    const p = r.body.prompt || '';
    check('served', r.status === 200 && p.length > 500, `${p.length} chars`);
    check('asks for the why and presses on it', /Press on this/i.test(p));
    check('asks where it stands', /what is already done, what is left/i.test(p));
    check('asks how big', /days, weeks, or months/i.test(p));
    check('and says not to ask a project for a deadline', /Do not ask me for a deadline on a project/i.test(p));
    check('asks a habit for its why rather than waiting', /Ask for the why rather than waiting/i.test(p));
    // Ranking is gone: the list orders itself, so the interview must not ask.
    check('does not ask what order things come in', !/what order they matter in|most important first/i.test(p));
    check('and covers three things, not four', /Cover these three things/i.test(p));
    check('covers habits with a cadence', /daily, a few times a week, weekly, or monthly/i.test(p));
    check('covers tasks with blockers', /anything that has to happen before/i.test(p));
    check('ends in a fenced json block', /```json/.test(p));
    check('and asks for no order at all', !/priority order|rank/i.test(p));

    // Rule 2.4: the engine is identical for everyone.
    check('names nobody', !/steve|steven/i.test(p));
    check('and carries no figure', !/\b\d{3,}\b/.test(p));
  }

  console.log('\nimport is all or nothing');
  {
    const bads = [
      ['a project with no why', { items: [{ type: 'project', title: 'X' }] }],
      ['a habit with no frequency', { items: [{ type: 'habit', title: 'X' }] }],
      ['a habit with a nonsense cadence', { items: [{ type: 'habit', title: 'X', frequency: 'often' }] }],
      ['a habit with a deadline', { items: [{ type: 'habit', title: 'X', frequency: 'daily', due: '2031-01-01' }] }],
      ['a project with a deadline', { items: [{ type: 'project', title: 'X', why: 'y', due: '2031-01-01' }] }],
      ['an unknown type', { items: [{ type: 'errand', title: 'X' }] }],
      ['a date that is not one', { items: [{ type: 'task', title: 'X', due: '2031-02-31' }] }],
      ['a size that is not one', { items: [{ type: 'task', title: 'X', size: 'ages' }] }],
      ['nothing at all', { items: [] }],
    ];

    for (const [label, payload] of bads) {
      const r = await post('/plan-intent/import', payload);
      check(`refuses ${label}`, r.status === 400, `${r.status} ${r.body.error || ''}`);
    }

    // The one that matters: a good list with one bad entry saves NOTHING.
    const mixed = {
      items: [
        { type: 'task', title: 'Fine one' },
        { type: 'project', title: 'Broken', state: 'no why given' },
        { type: 'task', title: 'Also fine' },
      ],
    };
    const r = await post('/plan-intent/import', mixed);
    check('refuses a list with one bad entry', r.status === 400, r.body.error);
    check('and names which one', /entry 2/.test(r.body.error || ''), r.body.error);

    const { count } = await H.db.from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
    check('nothing from that paste was written', count === 0, `${count}`);
  }

  console.log('\na whole interview, saved');
  const saved = await post('/plan-intent/import', INTERVIEW);
  check('accepted', saved.status === 200, JSON.stringify(saved.body).slice(0, 120));
  check('all five saved', saved.body.saved === 5, `${saved.body.saved}`);
  check('and nothing is reported as ranked', saved.body.ranked === undefined, String(saved.body.ranked));

  const list = (await get('/entries')).body;

  console.log('\nthe order it came in carries no meaning');
  {
    check('all five are in one list', list.items.length === 5, `${list.items.length}`);
    check('habits among them', list.items.filter((i) => i.type === 'habit').length === 2);

    // No position is written and none is returned. Every row here was created
    // in the same moment, so the list falls back to title order, which is what
    // "no ranking" looks like from outside.
    check('no row carries a position', list.items.every((i) => i.sort_order === undefined),
      list.items.map((i) => i.sort_order).join(','));

    const { data: rows } = await H.db
      .from('entries').select('title, sort_order').eq('user_id', U);
    check('and none was written to the column either',
      rows.every((r) => r.sort_order === null),
      rows.map((r) => `${r.title}=${r.sort_order}`).join(' '));
  }

  console.log('\nwhat each row carries');
  {
    const by = Object.fromEntries(list.items.map((i) => [i.title, i]));
    check('a project keeps its why', by['Thesis'].why === 'It is the whole year');
    check('and its state', by['Thesis'].state === 'Chapter two drafted, chapter three next', String(by['Thesis'].state));
    check('and its size', by['Thesis'].size === 'months', String(by['Thesis'].size));

    // A project has a size instead of a date: how much work is in it, rather
    // than a guess about when it ends that goes stale on its own.
    check('a project carries no deadline', by['Thesis'].due === null, String(by['Thesis'].due));
    check('nor does the other one', by['Website'].due === null, String(by['Website'].due));

    check('the hyphenated cadence is mapped', by['Gym'].frequency === 'few times a week', String(by['Gym'].frequency));
    check('a habit keeps its why', by['Gym'].why === 'Back pain');
    check('and survives without one', !by['Reading'].why, String(by['Reading'].why));
    check('a habit carries no state', !by['Gym'].state, String(by['Gym'].state));

    check('a task keeps its state', by['Renew passport'].state.includes('photos first'), String(by['Renew passport'].state));
    check('and its deadline, which only a task has', by['Renew passport'].due === '2031-05-01', String(by['Renew passport'].due));
    check('a task needs no why', !by['Renew passport'].why, String(by['Renew passport'].why));
  }

  console.log('\nstate is dated, and the date travels with it');
  {
    const by = Object.fromEntries(list.items.map((i) => [i.title, i]));
    check('captured today', by['Thesis'].state_captured === list.today, `${by['Thesis'].state_captured} against ${list.today}`);
    check('and zero days old', by['Thesis'].state_days_old === 0, String(by['Thesis'].state_days_old));

    // No new columns: all of it lives in body.
    const { data: row } = await H.db.from('entries').select('body').eq('user_id', U).eq('title', 'Thesis').single();
    const packed = JSON.parse(row.body);
    check('stored in the body column', Boolean(packed.state && packed.size && packed.captured), row.body);

    const cols = await H.db.from('entries').select('*').eq('user_id', U).limit(1);
    check('no new column was added',
      !Object.keys(cols.data[0]).some((k) => ['state', 'size', 'captured', 'state_captured'].includes(k)),
      Object.keys(cols.data[0]).join(','));
  }

  console.log('\nage is measured, not assumed');
  {
    // Backdate the claim by 40 days and read it back.
    const old = new Date(`${list.today}T12:00:00Z`);
    old.setUTCDate(old.getUTCDate() - 40);
    const when = old.toISOString().slice(0, 10);

    await H.db.from('entries')
      .update({ body: JSON.stringify({ state: 'Landing page done, pricing next', size: 'weeks', captured: when }) })
      .eq('user_id', U).eq('title', 'Website');

    const again = (await get('/entries')).body;
    const site = again.items.find((i) => i.title === 'Website');
    check('the age is counted from the capture date', site.state_days_old === 40, String(site.state_days_old));
    check('and the date itself comes back', site.state_captured === when, String(site.state_captured));
  }

  console.log('\nediting state re-dates it');
  {
    const site = (await get('/entries')).body.items.find((i) => i.title === 'Website');
    const r = await post(`/entries/${site.id}/update`, { state: 'Pricing done, launch next' });
    check('the update succeeds', r.status === 200, JSON.stringify(r.body).slice(0, 100));

    const after = (await get('/entries')).body.items.find((i) => i.title === 'Website');
    check('the words changed', after.state === 'Pricing done, launch next', String(after.state));
    check('and the clock restarted', after.state_days_old === 0, String(after.state_days_old));
    check('the size it was not asked about survived', after.size === 'weeks', String(after.size));

    const cleared = await post(`/entries/${site.id}/update`, { state: '' });
    check('clearing it is allowed', cleared.status === 200);
    const gone = (await get('/entries')).body.items.find((i) => i.title === 'Website');
    check('and the note is gone', !gone.state, String(gone.state));
  }

  console.log('\nadded by hand, not thinner than the interview');
  {
    const dated = await post('/entries', {
      type: 'project', title: 'Nope', why: 'Because', due: '2031-09-09',
    });
    check('the form cannot put a deadline on a project either', dated.status === 400, dated.body.error);
    check('and says what a project has instead', /size/i.test(dated.body.error || ''), dated.body.error);

    const habit = await post('/entries', {
      type: 'habit', title: 'Walk', frequency: 'daily', why: 'Head clears',
    });
    check('a habit added by hand keeps its why', habit.status === 200 && habit.body.entry.why === 'Head clears',
      JSON.stringify(habit.body).slice(0, 120));

    const bare = await post('/entries', { type: 'habit', title: 'Bare', frequency: 'weekly' });
    check('and one without is still allowed', bare.status === 200, JSON.stringify(bare.body).slice(0, 90));

    const made = await post('/entries', {
      type: 'project', title: 'Manual', why: 'Because',
      state: 'Started yesterday', size: 'days',
    });
    check('a project takes state and size', made.status === 200, JSON.stringify(made.body).slice(0, 120));

    const row = (await get('/entries')).body.items.find((i) => i.title === 'Manual');
    check('state stored', row.state === 'Started yesterday', String(row.state));
    check('size stored', row.size === 'days', String(row.size));
    check('dated on the way in', row.state_days_old === 0, String(row.state_days_old));
    // Being newly added is not a position. It is simply in the list, where its
    // age puts it.
    check('and it carries no position', row.sort_order === undefined, String(row.sort_order));
  }

  console.log('\nthe brain is told the age, never the claim alone');
  {
    // A plan tomorrow with a block tagged to the 40-day-old project.
    const thesis = (await get('/entries')).body.items.find((i) => i.title === 'Thesis');
    const old = new Date(`${(await get('/entries')).body.today}T12:00:00Z`);
    old.setUTCDate(old.getUTCDate() - 40);
    await H.db.from('entries')
      .update({ body: JSON.stringify({ state: 'Chapter two drafted, chapter three next', size: 'months', captured: old.toISOString().slice(0, 10) }) })
      .eq('user_id', U)
      .eq('id', thesis.id);

    const { data: plan } = await H.db.from('plans')
      .insert({ user_id: U, date: '2031-04-04', wake_time: '08:00:00', status: 'confirmed' })
      .select('id').single();
    await H.db.from('blocks').insert({
      user_id: U, plan_id: plan.id, title: 'Thesis', entry_id: thesis.id,
      start_time: '09:00:00', duration_minutes: 60, sort_order: 0,
    });

    const briefing = await messages.buildBriefing(U, plan.id);
    const text = messages.renderBriefing(briefing);

    check('the state reaches the briefing', /chapter three next/i.test(text), text.split('\n').pop());
    check('and never without its age', /as of \d+ days ago they said/.test(text), text.split('\n').pop());
    check('the size is offered too', /months of work/.test(text));

    // The line that must never appear: the claim stated as current fact.
    const blockLine = text.split('\n').find((l) => /Thesis/.test(l)) || '';
    check('it is not asserted as where things stand now',
      !/currently|right now|is now at/i.test(blockLine), blockLine);

    const task = require('fs').readFileSync(ROOT + '/messages.js', 'utf8');
    check('the prompt says it is not the current position', /not what is true now/i.test(task));
    check('and gives the wording to use', /last you wrote/i.test(task));
    check('and forbids assuming progress either way', /never assume none has been made/i.test(task));
  }

  console.log('\ncleanup');
  server.kill();
  await clear();
  await H.cleanup();
  const { count } = await H.raw.from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('test rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nPlan interview clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  if (server) server.kill();
  await H.cleanup();
  process.exit(1);
});
