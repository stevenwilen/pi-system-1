// The stale list, as the page draws it.
//
// Drives the shipped script through a fake DOM: what lands in the list, how it
// is ordered, and how a due date reads. No database.
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

// Deliberately not in age order: the panel sorts, and this proves it rather
// than inheriting whatever the server happened to send.
const ITEMS = [
  { id: 'p1', type: 'project', title: 'Thesis', days: 4, why: 'It is the year', due: '2026-07-30' },
  { id: 'h1', type: 'habit', title: 'Gym', frequency: 'daily', days: 2 },
  { id: 't1', type: 'task', title: 'Passport', days: 9, due: '2026-07-24' },
  { id: 'h2', type: 'habit', title: 'Reading', frequency: 'weekly', days: 11 },
  { id: 't2', type: 'task', title: 'Call bank', days: 1 },
  { id: 'h3', type: 'habit', title: 'Piano', frequency: 'daily', days: 5 },
];

let byTitleAll = () => null;
const markOf = (row) => { const m = row.querySelector('.mark'); return m ? m.textContent : null; };
const titleOf = (row) => row.querySelector('.item-title').textContent;
const dueOf = (row) => { const d = row.querySelector('.due'); return d ? d.textContent : null; };

(async () => {
  const { ctx, byId } = boot(payload(ITEMS));
  await ctx.load();

  console.log('one list, holding all three types');
  const rows = byId['stale'].children;

  const rowsByTitle = Object.fromEntries(rows.map((r) => [titleOf(r), r]));
  byTitleAll = (t) => rowsByTitle[t];

  check('every item is in it', rows.length === ITEMS.length, `${rows.length}`);
  check('habits among them', rows.some((r) => titleOf(r) === 'Gym'));
  check('and there is no second list', byId['habits'] === undefined || !byId['habits'].children.length);

  console.log('\nlongest left, first');
  {
    // Ages are 4, 2, 9, 11, 1, 5 in the order the server sent them.
    check('sorted by days, coldest first',
      rows.map(titleOf).join(',') === 'Reading,Passport,Piano,Thesis,Gym,Call bank',
      rows.map(titleOf).join(','));

    const days = rows.map((r) => Number(r.text().match(/(\d+) days?/)[1]));
    check('and the days descend', days.every((d, i) => i === 0 || days[i - 1] >= d), days.join(','));

    // The old panel put whatever the server sent first at the top. It does not
    // any more, and a row that has been left longest wins wherever it sat.
    check('the server order is not preserved', titleOf(rows[0]) !== 'Thesis', titleOf(rows[0]));
  }

  console.log('\nnothing is ranked and nothing is dragged');
  {
    check('no row carries a number', rows.every((r) => !r.querySelector('.rank')));
    check('no row carries a drag handle', rows.every((r) => !r.querySelector('.grip')));
    check('and the page has no reorder call left in it',
      !script.includes('/entries/reorder'), 'found /entries/reorder');
    check('nor any drag wiring for the list', !/startItemDrag/.test(script));
  }

  console.log('\na quiet mark says what each row is');
  {
    check('a habit is marked', markOf(byTitleAll('Gym')) === '↻', String(markOf(byTitleAll('Gym'))));
    check('a project is marked', markOf(byTitleAll('Thesis')) === '◆', String(markOf(byTitleAll('Thesis'))));
    check('a task is marked', markOf(byTitleAll('Passport')) === '·', String(markOf(byTitleAll('Passport'))));
    check('and it is one character, not a word',
      rows.every((r) => (markOf(r) || '').length === 1), rows.map(markOf).join(''));
    check('nothing spells the type out in full',
      !rows.some((r) => /TASK|PROJECT|HABIT/.test(r.text())), rows[0].text().slice(0, 50));
  }

  console.log('\nthe why is not on the row');
  {
    check('a project with a why does not print it',
      !byTitleAll('Thesis').text().includes('It is the year'),
      byTitleAll('Thesis').text().slice(0, 60));
    check('and the page no longer builds that element', !/el\('div', 'why'/.test(script));
  }

  console.log('\nthe temperature bar');
  {
    // Ages on screen run 1..11: Call bank 1, Gym 2, Thesis 4, Piano 5,
    // Passport 9, Reading 11. So the scale is min 1, max 11.
    const all = rows;
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

    check('every type is on the same scale',
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

  console.log('\nan empty list invites the first thing');
  {
    const { ctx: c2, byId: b2 } = boot(payload([]));
    await c2.load();
    check('the empty note names all three types',
      b2['stale'].text().includes('Add a habit, project or task'), b2['stale'].text());
  }

  console.log('\na list of only habits is still just the list');
  {
    const { ctx: c3, byId: b3 } = boot(payload([{ id: 'h9', type: 'habit', title: 'Gym', frequency: 'daily', days: 1 }]));
    await c3.load();
    check('the habit is in the one list', b3['stale'].children.length === 1);
    check('and no empty note is shown', !b3['stale'].text().includes('Nothing here yet'));
  }

  console.log('\npaused items stay in their own list below');
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
    check('no rank on a paused row', b4['paused'].children.every((r) => !r.querySelector('.rank')));
    check('neither paused row is in the main list',
      !b4['stale'].text().includes('Visa') && !b4['stale'].text().includes('Piano'));
    // The date is still a fact about the row, so it is still shown.
    check('a paused row still shows its date', dueOf(b4['paused'].children[1]) === '26 days overdue', String(dueOf(b4['paused'].children[1])));
  }

  console.log(bad === 0 ? '\nStale list renders clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
