// Runs the real <script> from index.html in a VM against a stub DOM, so the
// builder's arithmetic is tested as shipped rather than as a copy.
//
// A fresh context per scenario: `blocks` and `planDate` are let-bound inside
// the script and cannot be reset from outside, so state would otherwise leak
// between cases and quietly invalidate them.
//
// The builder is much smaller than it was. Nothing is pinned and nothing is
// placed automatically, so there are no gaps to fill and no collisions to
// report: a block starts when the one above it ends, and that is the whole
// rule. What is left to get right is the sequence, the steppers, and the
// running end time.
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
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._class = new Set();
    this._attrs = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.classList = {
      add: (c) => this._class.add(c),
      remove: (c) => this._class.delete(c),
      contains: (c) => this._class.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._class.has(c) : force;
        on ? this._class.add(c) : this._class.delete(c);
        return on;
      },
    };
  }
  get className() { return [...this._class].join(' '); }
  set className(v) { this._class = new Set(String(v).split(/\s+/).filter(Boolean)); }
  append(...k) { for (const x of k) if (x) this.children.push(x); }
  replaceChildren(...k) { this.children = k.filter(Boolean); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this._attrs[k] = v; this[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  addEventListener() {} removeEventListener() {}
  getBoundingClientRect() { return { top: 0, height: 40 }; }
  querySelector(s) { return this._find(s)[0] || new El(); }
  querySelectorAll(s) { return this._find(s); }
  _find(s) {
    const want = s.replace('.', '');
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c._class.has(want)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  text() { return (this.textContent || '') + this.children.map((c) => c.text()).join(' '); }
}

const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
// Strip the boot calls so the harness controls when loading happens.
const SCRIPT = html
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*load\(\);\s*$/m, '')
  .replace(/^\s*loadReview\(\);\s*$/m, '');

const ENTRIES = {
  today: '2026-07-27',
  timezone: 'America/New_York',
  wake_time: '08:00',
  items: [],
};

/** Builds a fresh script instance with its own DOM and calendar fixture. */
function boot(calendarItems = [], plan = null) {
  // Every id the markup declares, read from the file rather than listed here.
  // A hand-kept list goes stale the moment the page grows an element, and the
  // failure is an unrelated crash rather than anything to do with the builder.
  const byId = {};
  for (const id of new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))) {
    byId[id] = new El();
  }

  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button');
    b.dataset.type = t;
    byId['type-seg'].append(b);
  }

  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Intl, Date, Math, JSON,
    String, Number, Boolean, Array, Object,
    alert: () => {}, confirm: () => true, prompt: () => 'Typed block',
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        if (url.startsWith('/calendar')) return { items: calendarItems, failed: [] };
        if (url.startsWith('/plan/')) return plan || { plan: null, blocks: [] };
        if (url === '/review') return { date: '2026-07-26', blocks: [] };
        return ENTRIES;
      },
    }),
    document: { getElementById: (id) => byId[id], createElement: (t) => new El(t) },
  });

  vm.runInContext(SCRIPT, ctx);
  const rows = () => byId.builder.children.filter((c) => c._class.has('block'));
  return { ctx, byId, rows };
}

/**
 * The same, with one calendar feed reporting itself unreachable.
 *
 * [] from a dead feed and [] from a quiet Tuesday are the same value, and the
 * screen must not let them look the same.
 */
function bootWithFailure() {
  const byId = {};
  for (const id of new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))) {
    byId[id] = new El();
  }
  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button');
    b.dataset.type = t;
    byId['type-seg'].append(b);
  }

  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Intl, Date, Math, JSON,
    String, Number, Boolean, Array, Object,
    alert: () => {}, confirm: () => true, prompt: () => null,
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        if (url.startsWith('/calendar')) {
          return { items: [], failed: [{ source: 'awareness', label: 'Dates' }] };
        }
        if (url.startsWith('/plan/')) return { plan: null, blocks: [] };
        if (url === '/review') return { date: '2026-07-26', blocks: [] };
        return ENTRIES;
      },
    }),
    document: { getElementById: (id) => byId[id], createElement: (t) => new El(t) },
  });

  vm.runInContext(SCRIPT, ctx);
  return { ctx, byId };
}

const stepperOf = (row) => row.children.find((c) => c._class.has('stepper'));

(async () => {
  console.log('blocks flow in sequence from the start time');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    ctx.addBlock({ title: 'B', duration: 30 });
    check('two blocks rendered', rows().length === 2, `${rows().length}`);
    check('first starts at the start time', rows()[0].text().includes('08:00 – 09:00'), rows()[0].text().trim());
    check('second follows the first', rows()[1].text().includes('09:00 – 09:30'), rows()[1].text().trim());
    check('day ends is the sum', byId['end-time'].textContent === '09:30', byId['end-time'].textContent);
  }

  console.log('\nnothing arrives from the calendar');
  {
    // The feed has a timed appointment and an all-day entry on it. Neither
    // becomes a block: the calendar is read, shown, and forgotten.
    const { ctx, byId, rows } = boot([
      { title: 'Dentist', start_minutes: 780 },
      { title: 'Cancel Paramount', start_minutes: null },
    ]);
    await ctx.load();

    check('no blocks were created', rows().length === 0, `${rows().length}`);
    check('the appointment is shown as reference', /Dentist/.test(byId['cal-list'].text()),
      byId['cal-list'].text().trim());
    check('with its time', /Dentist, 13:00/.test(byId['cal-list'].text()), byId['cal-list'].text().trim());
    check('an all-day entry is shown with no time',
      /Cancel Paramount/.test(byId['cal-list'].text()) &&
        !/Cancel Paramount,/.test(byId['cal-list'].text()),
      byId['cal-list'].text().trim());

    ctx.addBlock({ title: 'Gym', duration: 60 });
    check('the day still starts at the start time', rows()[0].text().includes('08:00 – 09:00'),
      rows()[0].text().trim());
    check('and the appointment did not move it', byId['end-time'].textContent === '09:00',
      byId['end-time'].textContent);
  }

  console.log('\nan empty day and a broken feed do not look the same');
  {
    const { ctx, byId } = boot();
    await ctx.load();
    check('an empty calendar says it is empty', /Nothing on it/.test(byId['cal-list'].text()),
      byId['cal-list'].text().trim());
  }

  console.log('\na feed that could not be read is named');
  {
    const { ctx, byId } = bootWithFailure();
    await ctx.load();
    check('the failure is said out loud', /could not be read/.test(byId['cal-list'].text()),
      byId['cal-list'].text().trim());
    check('and the feed is named', /Dates/.test(byId['cal-list'].text()), byId['cal-list'].text().trim());
  }

  console.log('\n30 minute steps only');
  {
    const { ctx, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    const step = () => stepperOf(rows()[0]);

    step().children[2].onclick();
    check('plus adds exactly 30', rows()[0].text().includes('08:00 – 09:30'), rows()[0].text().trim());
    step().children[0].onclick();
    check('minus removes exactly 30', rows()[0].text().includes('08:00 – 09:00'), rows()[0].text().trim());
    step().children[0].onclick();
    check('floor is 30', rows()[0].text().includes('08:00 – 08:30'), rows()[0].text().trim());
    check('minus disabled at the floor', step().children[0].disabled === true);
    step().children[0].onclick();
    check('and pressing it there changes nothing', rows()[0].text().includes('08:00 – 08:30'),
      rows()[0].text().trim());
  }

  console.log('\nchanging one duration shifts everything below it');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    ctx.addBlock({ title: 'B', duration: 60 });
    ctx.addBlock({ title: 'C', duration: 60 });
    check('laid out in sequence',
      rows()[2].text().includes('10:00 – 11:00'), rows()[2].text().trim());

    stepperOf(rows()[0]).children[2].onclick(); // A: 60 -> 90
    check('the one below moved', rows()[1].text().includes('09:30 – 10:30'), rows()[1].text().trim());
    check('and the one below that', rows()[2].text().includes('10:30 – 11:30'), rows()[2].text().trim());
    check('the one above did not', rows()[0].text().includes('08:00 – 09:30'), rows()[0].text().trim());
    check('the end time followed', byId['end-time'].textContent === '11:30', byId['end-time'].textContent);
  }

  console.log('\nremoving a block reflows the rest');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    ctx.addBlock({ title: 'B', duration: 60 });

    // Removal is the long press on the card.
    rows()[0].onpointerdown();
    await new Promise((r) => setTimeout(r, 700));

    check('one block left', rows().length === 1, `${rows().length}`);
    check('it moved up to the start time', rows()[0].text().includes('08:00 – 09:00'),
      rows()[0].text().trim());
    check('end time followed', byId['end-time'].textContent === '09:00', byId['end-time'].textContent);
  }

  console.log('\nrunning end time past midnight');
  {
    const { ctx, byId } = boot();
    await ctx.load();
    for (let i = 0; i < 16; i++) ctx.addBlock({ title: `x${i}`, duration: 60 });
    check('spelled out, not just a smaller clock', /next day/.test(byId['end-time'].textContent),
      byId['end-time'].textContent);
    check('flagged late', byId.ends._class.has('late'));
  }

  console.log('\nthe day can start at a different hour every day');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    check('starts at the profile default', rows()[0].text().includes('08:00 – 09:00'), rows()[0].text());
    check('and the control shows it', byId['wake-time'].textContent === '08:00', byId['wake-time'].textContent);

    byId['wake-plus'].onclick();
    check('one step is half an hour', byId['wake-time'].textContent === '08:30', byId['wake-time'].textContent);
    check('and the day moved with it', rows()[0].text().includes('08:30 – 09:30'), rows()[0].text());
    check('the end time followed', byId['end-time'].textContent === '09:30', byId['end-time'].textContent);

    byId['wake-minus'].onclick();
    byId['wake-minus'].onclick();
    check('it goes back down', byId['wake-time'].textContent === '07:30', byId['wake-time'].textContent);
    check('the day came back with it', rows()[0].text().includes('07:30 – 08:30'), rows()[0].text());

    // Moving the start is an edit like any other: the day stops being saved.
    ctx.setSaved(true);
    byId['wake-plus'].onclick();
    check('moving it un-saves the day', byId['confirm'].textContent !== 'Confirmed',
      byId['confirm'].textContent);
  }

  console.log('\na day saved off the half hour is corrected by one press');
  {
    const { ctx, byId } = boot();
    await ctx.load();
    ctx.setWake(8 * 60 + 15);
    check('it opens on the odd time it was saved with', byId['wake-time'].textContent === '08:15',
      byId['wake-time'].textContent);

    byId['wake-plus'].onclick();
    check('forward lands on the half hour', byId['wake-time'].textContent === '08:30',
      byId['wake-time'].textContent);

    ctx.setWake(8 * 60 + 15);
    byId['wake-minus'].onclick();
    check('and back lands on it too', byId['wake-time'].textContent === '08:00',
      byId['wake-time'].textContent);

    byId['wake-minus'].onclick();
    check('then it steps a full half hour', byId['wake-time'].textContent === '07:30',
      byId['wake-time'].textContent);
  }

  console.log('\nthe start is clamped to hours a person actually wakes');
  {
    const { ctx, byId } = boot();
    await ctx.load();

    for (let i = 0; i < 40; i++) byId['wake-minus'].onclick();
    check('cannot go before 04:00', byId['wake-time'].textContent === '04:00', byId['wake-time'].textContent);
    check('and the button says so', byId['wake-minus'].disabled === true);

    for (let i = 0; i < 80; i++) byId['wake-plus'].onclick();
    check('cannot go past 12:00', byId['wake-time'].textContent === '12:00', byId['wake-time'].textContent);
    check('and that button says so too', byId['wake-plus'].disabled === true);
  }

  console.log('\nconfirm');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    check('nothing to confirm on an empty day', byId['confirm'].disabled === true);
    check('and the end time says nothing', byId['end-time'].textContent === '—', byId['end-time'].textContent);

    ctx.addBlock({ title: 'A', duration: 60 });
    check('a block enables it', byId['confirm'].disabled === false);
    check('and it reads Confirm', byId['confirm'].textContent === 'Confirm', byId['confirm'].textContent);

    ctx.setSaved(true);
    check('once saved it reads Confirmed', byId['confirm'].textContent === 'Confirmed');
    check('and cannot be pressed again', byId['confirm'].disabled === true);

    ctx.addBlock({ title: 'B', duration: 30 });
    check('adding a block un-saves it', byId['confirm'].textContent === 'Confirm');
    check('and both blocks are there', rows().length === 2);
  }

  console.log('\na confirmed day comes back on reload');
  {
    const { ctx, byId, rows } = boot([], {
      plan: { date: '2026-07-28', status: 'confirmed', wake_minutes: 9 * 60 },
      blocks: [
        { title: 'Reading', entryId: 'e1', start_minutes: 540, duration_minutes: 60 },
        { title: 'UF application', entryId: 'e2', start_minutes: 600, duration_minutes: 120 },
      ],
    });
    await ctx.load();

    check('the blocks came back', rows().length === 2, `${rows().length}`);
    check('the start hour came back too', byId['wake-time'].textContent === '09:00',
      byId['wake-time'].textContent);
    check('laid out from it', rows()[0].text().includes('09:00 – 10:00'), rows()[0].text().trim());
    check('and the second follows', rows()[1].text().includes('10:00 – 12:00'), rows()[1].text().trim());
    check('it opens as already confirmed', byId['confirm'].textContent === 'Confirmed',
      byId['confirm'].textContent);
  }

  console.log('\n+ Block adds a manual one');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });

    // Driven through the real control. The stub prompt() answers 'Typed block'.
    byId['add-block'].onclick();

    check('it was added', rows().length === 2, `${rows().length}`);
    check('with the title that was typed', rows()[1].text().includes('Typed block'),
      rows()[1].text().trim());
    check('it lands after the last block', rows()[1].text().includes('09:00 – 09:30'),
      rows()[1].text().trim());
    check('and starts at one step', rows()[1].text().includes('30m'), rows()[1].text().trim());
  }

  console.log(bad === 0 ? '\nBuilder clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
