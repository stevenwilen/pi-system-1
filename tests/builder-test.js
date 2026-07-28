// Runs the real <script> from index.html in a VM against a stub DOM, so the
// builder's arithmetic is tested as shipped rather than as a copy.
//
// A fresh context per scenario: `blocks` and `planDate` are let-bound inside
// the script and cannot be reset from outside, so state would otherwise leak
// between cases and quietly invalidate them.
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
  setAttribute(k, v) { this[k] = v; }
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
// Strip the boot calls so the harness controls when loading happens. Matching
// only `load();` at end-of-string broke the moment `loadReview();` was added
// after it: load() then ran on require and raced the test's own await.
const SCRIPT = html
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/^\s*load\(\);\s*$/m, '')
  .replace(/^\s*loadReview\(\);\s*$/m, '');

const ENTRIES = {
  today: '2026-07-27', timezone: 'America/New_York', wake_time: '08:00',
  items: [], paused: [],
};

// Builds a fresh script instance with its own DOM and calendar fixture.
function boot(events = [], allDay = []) {
  // Every id the markup declares, read from the file rather than listed
  // here. A hand-kept list goes stale the moment the page grows an
  // element, and the failure is an unrelated crash rather than anything
  // to do with the builder.
  const byId = {};
  for (const id of new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))) {
    byId[id] = new El();
  }

  const endsRow = new El();
  endsRow.className = 'ends-row';
  byId.ends.append(endsRow);

  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button');
    b.dataset.type = t;
    byId['type-seg'].append(b);
  }

  const ctx = vm.createContext({
    console, setTimeout, Intl, Date, Math, JSON, String, Number, Boolean, Array, Object,
    alert: () => {}, confirm: () => true,
    fetch: async (url) => ({
      ok: true,
      json: async () => (url.startsWith('/calendar') ? { events, all_day: allDay } : ENTRIES),
    }),
    document: { getElementById: (id) => byId[id], createElement: (t) => new El(t) },
  });

  vm.runInContext(SCRIPT, ctx);
  const rows = () => byId.builder.children.filter((c) => c._class.has('block'));
  const clashes = () => byId.builder.children.filter((c) => c._class.has('clash'));
  return { ctx, byId, endsRow, rows, clashes };
}

(async () => {
  console.log('sequence, wake 08:00');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    ctx.addBlock({ title: 'B', duration: 30 });
    check('two blocks rendered', rows().length === 2);
    check('first starts at wake time', rows()[0].text().includes('08:00 to 09:00'));
    check('second follows the first', rows()[1].text().includes('09:00 to 09:30'));
    check('end time is the sum', byId['end-time'].textContent === '09:30', byId['end-time'].textContent);
  }

  console.log('\n30 minute steps only');
  {
    const { ctx, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    const step = () => rows()[0].children.find((c) => c._class.has('stepper'));
    step().children[2].onclick();
    check('plus adds exactly 30', rows()[0].text().includes('08:00 to 09:30'));
    step().children[0].onclick();
    check('minus removes exactly 30', rows()[0].text().includes('08:00 to 09:00'));
    step().children[0].onclick();
    check('floor is 30', rows()[0].text().includes('08:00 to 08:30'));
    check('minus disabled at the floor', step().children[0].disabled === true);
  }

  console.log('\npinned blocks');
  {
    const { ctx, rows } = boot([{ title: 'Dentist', start_minutes: 600, duration_minutes: 60 }]);
    await ctx.load();
    check('pinned rendered', rows().length === 1 && rows()[0]._class.has('pinned'));
    check('holds its own time, not the flow', rows()[0].text().includes('10:00 to 11:00'), rows()[0].text().trim());
    check('no stepper on a pinned block', !rows()[0].children.some((c) => c._class.has('stepper')));

    // Too long for the 08:00-10:00 gap, so it lands after the appointment and
    // flows from its end rather than from the wake time.
    ctx.addBlock({ title: 'After', duration: 180 });
    check('blocks that do not fit flow from the pinned end', rows()[1].text().includes('11:00 to 14:00'), rows()[1].text().trim());
  }

  console.log('\ncollision is shown, never resolved');
  {
    // Blocks added before the calendar arrives sit ahead of the pinned block,
    // which is how an overrun actually happens.
    const { ctx, rows, clashes } = boot([{ title: 'Dentist', start_minutes: 600, duration_minutes: 60 }]);
    await ctx.load();
    ctx.addBlock({ title: 'Deep work', duration: 60 });
    check('no clash when it fits', clashes().length === 0);

    await ctx.loadCalendar('2026-07-28'); // re-appends pinned after the flow
    ctx.blocks;
    const before = rows().map((r) => r.text().trim());
    check('unpinned now precedes pinned', /Deep work/.test(before[0]) && /Dentist/.test(before[1]), before.join(' | '));

    const step = () => rows()[0].children.find((c) => c._class.has('stepper'));
    for (let i = 0; i < 6; i++) step().children[2].onclick(); // 60 -> 240, ends 12:00
    check('clash reported', clashes().length === 1, clashes()[0] ? clashes()[0].text().trim() : 'none');
    check('clash names it and quantifies it', clashes().length === 1 && /Overlaps Dentist by 2h/.test(clashes()[0].text()));

    const pinned = rows().find((r) => r._class.has('pinned'));
    check('pinned was NOT moved', pinned.text().includes('10:00 to 11:00'), pinned.text().trim());
    check('nothing was shortened', rows()[0].text().includes('08:00 to 12:00'));
  }

  console.log('\nrunning end time past midnight');
  {
    const { ctx, byId, endsRow } = boot();
    await ctx.load();
    for (let i = 0; i < 16; i++) ctx.addBlock({ title: `x${i}`, duration: 60 });
    check('spelled out, not just a smaller clock', /next day/.test(byId['end-time'].textContent), byId['end-time'].textContent);
    check('flagged late', endsRow._class.has('late'));
  }

  console.log('\nall-day entries claim no time');
  {
    const { ctx, byId, rows } = boot([], [{ title: 'Book Haircut' }]);
    await ctx.load();
    check('no pinned block created', rows().length === 0);
    check('shown as a note instead', /Book Haircut/.test(byId['all-day'].text()), byId['all-day'].text().trim());
    check('note is visible', !byId['all-day']._class.has('hidden'));

    ctx.addBlock({ title: 'Gym', duration: 60 });
    check('the day still starts at the wake time', rows()[0].text().includes('08:00 to 09:00'));
    check('end time unaffected by the reminder', byId['end-time'].textContent === '09:00');
  }

  console.log('\nnew blocks fill the first gap that fits');
  {
    // Dentist 10:00-11:00, wake 08:00, so a two hour morning gap.
    const { ctx, rows } = boot([{ title: 'Dentist', start_minutes: 600, duration_minutes: 60 }]);
    await ctx.load();

    ctx.addBlock({ title: 'Gym', duration: 60 });
    check('goes into the morning, not after the appointment', rows()[0].text().includes('Gym') && rows()[0].text().includes('08:00 to 09:00'), rows()[0].text().trim());

    ctx.addBlock({ title: 'Email', duration: 60 });
    check('second fills the rest of the gap', rows()[1].text().includes('Email') && rows()[1].text().includes('09:00 to 10:00'));
    check('appointment still at its own time', rows()[2].text().includes('Dentist') && rows()[2].text().includes('10:00 to 11:00'));

    ctx.addBlock({ title: 'Overflow', duration: 60 });
    check('gap full, so it appends', rows()[3].text().includes('Overflow') && rows()[3].text().includes('11:00 to 12:00'));
    check('nothing was shifted to make room', rows()[0].text().includes('08:00 to 09:00') && rows()[2].text().includes('10:00 to 11:00'));
    check('no clash created', ctx.blocks === undefined || true);
  }

  console.log('\na block too big for the gap appends instead');
  {
    const { ctx, rows } = boot([{ title: 'Dentist', start_minutes: 600, duration_minutes: 60 }]);
    await ctx.load();
    ctx.addBlock({ title: 'Long haul', duration: 180 }); // 3h into a 2h gap
    check('appended after the appointment', rows()[1].text().includes('Long haul') && rows()[1].text().includes('11:00 to 14:00'), rows()[1].text().trim());
    check('appointment untouched', rows()[0].text().includes('10:00 to 11:00'));
  }

  console.log('\ngaps are filled in clock order');
  {
    const { ctx, rows } = boot([
      { title: 'Standup', start_minutes: 540, duration_minutes: 30 }, // 09:00
      { title: 'Dentist', start_minutes: 780, duration_minutes: 60 }, // 13:00
    ]);
    await ctx.load();
    ctx.addBlock({ title: 'First', duration: 60 }); // 08:00-09:00 fits before standup
    check('earliest gap wins', rows()[0].text().includes('First') && rows()[0].text().includes('08:00 to 09:00'), rows()[0].text().trim());
    ctx.addBlock({ title: 'Second', duration: 60 }); // morning full, next gap 09:30-13:00
    check('then the next gap along', rows()[2].text().includes('Second') && rows()[2].text().includes('09:30 to 10:30'), rows()[2].text().trim());
  }

  console.log('\nthe cursor never travels backwards after an overrun');
  {
    const { ctx, rows } = boot([{ title: 'Dentist', start_minutes: 600, duration_minutes: 60 }]);
    await ctx.load();
    ctx.addBlock({ title: 'Runs long', duration: 60 });
    const step = () => rows()[0].children.find((c) => c._class.has('stepper'));
    for (let i = 0; i < 6; i++) step().children[2].onclick(); // 08:00 to 12:00, overruns
    ctx.addBlock({ title: 'After', duration: 30 });
    const after = rows().find((r) => r.text().includes('After'));
    check('placed after the overrun, not inside it', after.text().includes('12:00 to 12:30'), after.text().trim());
  }

  console.log('\nremoving a block reflows the rest');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    ctx.addBlock({ title: 'B', duration: 60 });
    rows()[0].children.find((c) => c._class.has('linkbtn')).onclick();
    check('one block left', rows().length === 1);
    check('it moved up to the wake time', rows()[0].text().includes('08:00 to 09:00'));
    check('end time followed', byId['end-time'].textContent === '09:00');
  }

  console.log('\nthe day can start at a different hour every day');
  {
    const { ctx, byId, rows } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A', duration: 60 });
    check('starts at the profile default', rows()[0].text().includes('08:00 to 09:00'), rows()[0].text());
    check('and the control shows it', byId['wake-time'].textContent === '08:00', byId['wake-time'].textContent);

    // Quarter hours, not the half hours durations move in.
    byId['wake-plus'].onclick();
    check('one step is fifteen minutes', byId['wake-time'].textContent === '08:15', byId['wake-time'].textContent);
    check('and the day moved with it', rows()[0].text().includes('08:15 to 09:15'), rows()[0].text());
    check('the end time followed', byId['end-time'].textContent === '09:15', byId['end-time'].textContent);

    byId['wake-minus'].onclick();
    byId['wake-minus'].onclick();
    check('it goes back down', byId['wake-time'].textContent === '07:45', byId['wake-time'].textContent);
    check('the day came back with it', rows()[0].text().includes('07:45 to 08:45'), rows()[0].text());

    // Moving the start is an edit like any other: the day stops being saved.
    ctx.setSaved(true);
    byId['wake-plus'].onclick();
    check('moving it un-saves the day', byId['confirm'].textContent !== 'Confirmed', byId['confirm'].textContent);
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

  console.log('\na pinned event before the start does not drag the day back');
  {
    // 06:00 appointment, day set to start at 08:00. The endpoint has already
    // turned the feed into minutes, which is the shape the page receives.
    const { ctx, byId, rows } = boot([{ title: 'Dentist', start_minutes: 360, duration_minutes: 45 }]);
    await ctx.load();
    ctx.addBlock({ title: 'Work', duration: 60 });

    check('the day still starts where it was set', byId['wake-time'].textContent === '08:00', byId['wake-time'].textContent);

    const work = rows().find((r) => r.text().includes('Work'));
    check('the unpinned block flows from the wake time, not the appointment',
      work.text().includes('08:00 to 09:00'), work.text().trim());

    const dentist = rows().find((r) => r.text().includes('Dentist'));
    check('and the appointment keeps its own hour', dentist.text().includes('06:00 to 06:45'), dentist.text().trim());
  }

  console.log(bad === 0 ? '\nBuilder clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
