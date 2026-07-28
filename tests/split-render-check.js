// The two lists, as the page draws them.
//
// Drives the shipped script through a fake DOM: what lands in each list, what
// carries a rank, what can be dragged, and how a due date reads. No database.
const fs = require('fs');
const vm = require('vm');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

class El {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {};
    this._class = new Set(); this.textContent = ''; this.value = ''; this.disabled = false;
    this._attrs = {};
    this.classList = {
      add: (c) => this._class.add(c), remove: (c) => this._class.delete(c),
      contains: (c) => this._class.has(c),
      toggle: (c, f) => { const on = f === undefined ? !this._class.has(c) : f; on ? this._class.add(c) : this._class.delete(c); return on; },
    };
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  append(...k) { for (const x of k) if (x) this.children.push(x); }
  replaceChildren(...k) { this.children = k.filter(Boolean); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this._attrs[k] = v; if (k === 'class') this.className = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  addEventListener() {} removeEventListener() {}
  getBoundingClientRect() { return { top: 0, height: 40 }; }
  closest() { return this; }
  querySelector(sel) {
    const want = String(sel).replace(/^\./, '');
    return this.find((n) => n !== this && n._class.has(want)) || null;
  }
  querySelectorAll(sel) {
    const want = String(sel).replace(/^\./, '');
    return this.findAll((n) => n !== this && n._class.has(want));
  }
  text() { return (this.textContent || '') + this.children.map((c) => c.text()).join(' '); }
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) { const hit = c.find(pred); if (hit) return hit; }
    return null;
  }
  findAll(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) c.findAll(pred, out);
    return out;
  }
}

const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const sent = [];

function boot(entries) {
  const ids = [...new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))];
  const byId = {};
  for (const id of ids) byId[id] = new El();
  byId['ends'].querySelector = () => new El();
  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button'); b.dataset.type = t; byId['type-seg'].append(b);
  }

  const ctx = vm.createContext({
    console, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0),
    Intl, Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map,
    alert: () => {}, confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST') sent.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return {
        ok: true,
        json: async () => {
          if (u.startsWith('/calendar')) return { events: [], all_day: [] };
          if (u.startsWith('/plan/')) return { plan: null, blocks: [] };
          if (u.startsWith('/review')) return { date: '2026-07-26', blocks: [] };
          if (opts && opts.method === 'POST') return { ok: true };
          return entries;
        },
      };
    },
    document: {
      getElementById: (id) => byId[id],
      createElement: (t) => new El(t),
      createElementNS: (ns, t) => new El(t),
    },
  });

  vm.runInContext(script, ctx);
  return { ctx, byId };
}

const TODAY = '2026-07-27';

const payload = (items, paused = []) => ({
  today: TODAY, timezone: 'America/New_York', wake_time: '08:00', items, paused,
});

// In sort_order, as the server returns them. Habits are interleaved on purpose:
// the split must not depend on the server having grouped them.
const ITEMS = [
  { id: 'p1', type: 'project', title: 'Thesis', days: 4, why: 'It is the year', due: '2026-07-30' },
  { id: 'h1', type: 'habit', title: 'Gym', frequency: 'daily', days: 2 },
  { id: 't1', type: 'task', title: 'Passport', days: 9, due: '2026-07-24' },
  { id: 'h2', type: 'habit', title: 'Reading', frequency: 'weekly', days: 11 },
  { id: 't2', type: 'task', title: 'Call bank', days: 1 },
  { id: 'h3', type: 'habit', title: 'Piano', frequency: 'daily', days: 5 },
];

let byTitleAll = () => null;
const rankOf = (row) => { const r = row.querySelector('.rank'); return r ? r.textContent : null; };
const titleOf = (row) => row.querySelector('.item-title').textContent;
const dueOf = (row) => { const d = row.querySelector('.due'); return d ? d.textContent : null; };

(async () => {
  const { ctx, byId } = boot(payload(ITEMS));
  await ctx.load();

  console.log('the split');
  const priorities = byId['stale'].children;
  const habits = byId['habits'].children;

  // Look a row up by its title, across both lists.
  const rowsByTitle = Object.fromEntries(
    [...priorities, ...habits].map((r) => [titleOf(r), r])
  );
  byTitleAll = (t) => rowsByTitle[t];

  check('priorities hold only projects and tasks', priorities.map(titleOf).join(',') === 'Thesis,Passport,Call bank', priorities.map(titleOf).join(','));
  check('habits hold only habits', habits.map(titleOf).join(',') === 'Reading,Piano,Gym', habits.map(titleOf).join(','));
  check('nothing is lost between them', priorities.length + habits.length === ITEMS.length);
  check('the habits section is shown', !byId['habits-group']._class.has('hidden'));

  console.log('\npriorities keep the order the server sent');
  check('server order preserved, not re-sorted by age or due', priorities.map(titleOf).join(',') === 'Thesis,Passport,Call bank');
  // Passport is overdue and Call bank is barely touched; neither moves.
  check('an overdue item does not jump the queue', titleOf(priorities[1]) === 'Passport');

  console.log('\nrank is a readout of position');
  check('numbered from one, in order', priorities.map(rankOf).join(',') === '1,2,3', priorities.map(rankOf).join(','));
  check('habits carry no rank', habits.every((r) => rankOf(r) === null));
  check('habits cannot be dragged', habits.every((r) => !r.querySelector('.grip')));
  check('priorities can be', priorities.every((r) => Boolean(r.querySelector('.grip'))));

  console.log('\nhabits are ordered by neglect, longest first');
  check('coldest first', habits.map(titleOf).join(',') === 'Reading,Piano,Gym', habits.map(titleOf).join(','));
  const days = habits.map((r) => Number(r.text().match(/(\d+) days?/)[1]));
  check('and the days descend', days.every((d, i) => i === 0 || days[i - 1] >= d), days.join(','));

  console.log('\ndue dates read as they should');
  check('overdue says so', dueOf(priorities[1]) === '3 days overdue', dueOf(priorities[1]));
  check('overdue is marked', priorities[1].querySelector('.due')._class.has('overdue'));
  check('near dates count down', dueOf(priorities[0]) === 'in 3 days', dueOf(priorities[0]));
  check('no date, no pill', dueOf(priorities[2]) === null, String(dueOf(priorities[2])));

  {
    const cases = [
      ['2026-07-27', 'today', false],
      ['2026-07-28', 'tomorrow', false],
      ['2026-07-29', 'in 2 days', false],
      ['2026-08-03', 'in 7 days', false],
      ['2026-08-04', '4 Aug', false],
      ['2027-01-09', '9 Jan 2027', false],
      ['2026-07-26', '1 day overdue', true],
      ['2026-06-27', '30 days overdue', true],
    ];
    for (const [due, want, overdue] of cases) {
      const got = ctx.dueLabel(due, TODAY);
      check(`${due} reads "${want}"`, got.text === want && got.overdue === overdue, `${got.text} overdue=${got.overdue}`);
    }
  }

  console.log('\nthe temperature bar');
  {
    // Ages on screen run 1..11, across both lists: Call bank 1, Gym 2, Thesis
    // 4, Passport 9, Reading 11. So the scale is min 1, max 11 and the midpoint
    // is 6.
    const all = [...priorities, ...habits];
    check('every row is coloured', all.every((r) => Boolean(r.style.borderLeftColor)),
      all.map((r) => r.style.borderLeftColor).join(' '));

    const colour = (title) => byTitleAll(title).style.borderLeftColor;
    check('the freshest is the warm end', colour('Call bank') === '#7d8b6a', colour('Call bank'));
    check('the coldest is the cold end', colour('Reading') === '#6b93b8', colour('Reading'));

    // Anything between the ends must sit between them on every channel.
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const mid = rgb(colour('Thesis'));
    const [warm, cold] = [rgb('#7d8b6a'), rgb('#6b93b8')];
    check('a middling row is interpolated, not snapped to an end',
      colour('Thesis') !== '#7d8b6a' && colour('Thesis') !== '#6b93b8', colour('Thesis'));
    check('and its blue sits between the two ends',
      mid[2] > warm[2] && mid[2] < cold[2], `${mid[2]} between ${warm[2]} and ${cold[2]}`);

    check('both lists share one scale',
      colour('Gym') !== colour('Reading') && colour('Gym') !== colour('Call bank'),
      `Gym ${colour('Gym')}`);

    check('rows are square, so the edge meets the corner', /\.item \{[^}]*border-radius: 0/.test(html));
    check('the edge is 3px', /\.item \{[^}]*border-left: 3px solid/.test(html));
    check('no moon is drawn anywhere', !/moon/i.test(script) && all.every((r) => !r.find((n) => n.tagName === 'svg')));
  }

  console.log('\na paused row has no temperature');
  {
    const { ctx: cp, byId: bp } = boot(
      payload([{ id: 'a', type: 'task', title: 'Live', days: 1 }],
              [{ id: 'p', type: 'task', title: 'Set down', days: 90, paused: true }])
    );
    await cp.load();
    const row = bp['paused'].children[0];
    check('the edge is left neutral', !row.style.borderLeftColor, String(row.style.borderLeftColor));
    check('a pause is not a temperature', row._class.has('paused'));
  }

  console.log('\nrank never leaves the browser');
  {
    sent.length = 0;
    // Reordering sends ids and nothing else. There is no rank field to send.
    const list = byId['stale'];
    const order = list.children.map((r) => r.dataset.id);
    await ctx.api('/entries/reorder', {
      method: 'POST', headers: {}, body: JSON.stringify({ ids: order }),
    });
    check('the reorder body is ids only', JSON.stringify(Object.keys(sent[0].body)) === '["ids"]', JSON.stringify(sent[0].body));
    check('and carries the priorities only', sent[0].body.ids.join(',') === 'p1,t1,t2', sent[0].body.ids.join(','));
    check('no habit id is in it', !sent[0].body.ids.some((id) => id.startsWith('h')));
  }

  console.log('\nthe form offers each type only what means something for it');
  {
    const shown = (id) => !byId[id]._class.has('hidden');

    // A task has a deadline. A project has a size, which says how much work is
    // in it rather than guessing when it ends. A habit has a cadence.
    ctx.setType('task');
    check('task: due, no size', shown('f-due-wrap') && !shown('f-size-wrap'));
    check('task: no why asked', !shown('f-why-wrap'));

    ctx.setType('project');
    check('project: size, no due', shown('f-size-wrap') && !shown('f-due-wrap'));
    check('project: why is asked for', shown('f-why-wrap'));
    check('and not marked optional', byId['f-why-optional']._class.has('hidden'));

    ctx.setType('habit');
    check('habit: neither due nor size', !shown('f-due-wrap') && !shown('f-size-wrap'));
    check('habit: why is offered', shown('f-why-wrap'));
    check('and marked optional', !byId['f-why-optional']._class.has('hidden'));

    // Anything typed into a field the new type does not carry is cleared, so
    // it cannot be sent for a type that must not have it.
    ctx.setType('task');
    byId['f-due'].value = '2026-08-09';
    ctx.setType('project');
    check('switching to project clears any date typed', byId['f-due'].value === '');

    byId['f-why'].value = 'a reason';
    ctx.setType('task');
    check('switching to task clears the why', byId['f-why'].value === '');
  }

  console.log('\nediting loads the date back, and can clear it');
  {
    ctx.openEntry({ id: 't1', type: 'task', title: 'Passport', due: '2026-07-24' });
    check('the picker is filled from the row', byId['f-due'].value === '2026-07-24', byId['f-due'].value);
    // $ is a const inside the page and never reaches the context, so the
    // handler is called on the element it was assigned to.
    byId['f-due-clear'].onclick();
    check('Clear empties it', byId['f-due'].value === '');
  }

  console.log('\nan empty priorities list still invites one');
  {
    const { ctx: c2, byId: b2 } = boot(payload([{ id: 'h9', type: 'habit', title: 'Gym', frequency: 'daily', days: 1 }]));
    await c2.load();
    check('the empty note is shown', b2['stale'].text().includes('Add a project or task'), b2['stale'].text());
    check('and the habits list still renders', b2['habits'].children.length === 1);
  }

  console.log('\nno habits, no habits section');
  {
    const { ctx: c3, byId: b3 } = boot(payload([{ id: 'p9', type: 'task', title: 'Renew', days: 1 }]));
    await c3.load();
    check('section hidden', b3['habits-group']._class.has('hidden'));
  }

  console.log('\npaused items stay apart from both lists');
  {
    const { ctx: c4, byId: b4 } = boot(
      payload(
        [{ id: 'p1', type: 'task', title: 'Live', days: 1 }],
        [
          { id: 'x1', type: 'habit', title: 'Piano', frequency: 'daily', days: 40, paused: true },
          { id: 'x2', type: 'task', title: 'Visa', days: 60, due: '2026-07-01', paused: true },
        ]
      )
    );
    await c4.load();
    check('both paused rows listed', b4['paused'].children.length === 2);
    check('paused section shown', !b4['paused-group']._class.has('hidden'));
    check('no rank on a paused row', b4['paused'].children.every((r) => rankOf(r) === null));
    check('no grip on a paused row', b4['paused'].children.every((r) => !r.querySelector('.grip')));
    check('a paused row is not in the priorities list', !b4['stale'].text().includes('Visa'));
    check('nor in the habits list', !b4['habits'].text().includes('Piano'));
    // The date is still a fact about the row, so it is still shown.
    check('a paused row still shows its date', dueOf(b4['paused'].children[1]) === '26 days overdue', String(dueOf(b4['paused'].children[1])));
  }

  console.log(bad === 0 ? '\nSplit renders clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
