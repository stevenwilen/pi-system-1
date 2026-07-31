// Runs the real <script> from index.html in a VM against a stub DOM, so the
// builder's arithmetic and its gesture arbitration are tested as shipped
// rather than as a copy.
//
// A fresh context per scenario: `blocks` and `planDate` are let-bound inside
// the script and cannot be reset from outside, so state would otherwise leak
// between cases and quietly invalidate them.
//
// WHAT THIS CANNOT TELL YOU. These are synthetic pointer events dispatched at
// handlers. They cover the state machine — which gesture wins, what commits at
// what distance, what the array looks like afterwards — and they cover nothing
// about touch itself: not `touch-action`, not whether the browser has already
// claimed a scroll before preventDefault lands, not what a thumb actually
// does. That needs a real device and it is not verified here.
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
  // Children know their parent, so an element can say where it sits. Without
  // that every rect reported top: 0 and anything measuring the distance
  // between two rows measured nothing.
  append(...k) { for (const x of k) if (x) { x._parent = this; this.children.push(x); } }
  replaceChildren(...k) {
    this.children = k.filter(Boolean);
    for (const x of this.children) x._parent = this;
  }
  appendChild(k) { k._parent = this; this.children.push(k); return k; }
  setAttribute(k, v) { this._attrs[k] = v; this[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  addEventListener() {} removeEventListener() {}
  // A real height AND a real position, because the reorder maths divides by
  // the first and now measures the second. 40 high with the stylesheet's 12px
  // gap puts one row every 52px, so a drag of 52 is exactly one place.
  getBoundingClientRect() {
    const at = this._parent ? this._parent.children.indexOf(this) : 0;
    return { top: at * 52, height: 40 };
  }
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

// Strip the boot call so the harness controls when loading happens.
//
// AND CHECK THAT IT WORKED. The pattern used to be an exact `load();`, and the
// day the page started saying `load().finally(uncover)` it quietly stopped
// matching — so every boot ran the page's own load AND the one the case asked
// for. Two loads race, `if (!today)` decides which of them fills the builder,
// and cases began passing or failing on microtask ordering. It cost an
// afternoon to find, because the symptom was an empty builder three suites
// away from the change.
//
// Anything from `load(` to the end of that line, and a throw if there was
// nothing there to remove.
const rawScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const SCRIPT = rawScript
  .replace(/^\s*load\(\)[^\n]*$/m, '')
  .replace(/^\s*loadReview\(\);\s*$/m, '');

if (SCRIPT === rawScript) {
  throw new Error(
    'the harness could not find the page\'s boot call to strip. Every boot would ' +
    'run a second, racing load. Update the pattern above to match how index.html ' +
    'now starts itself.'
  );
}

const ENTRIES = {
  today: '2026-07-27',
  timezone: 'America/New_York',
  wake_time: '08:00', // as the server sends it: 24 hour, display is the page's job
  items: [],
};

const SLOT = 52; // one block's height plus the stylesheet's gap

// The clock the page reads. It asks Intl for the hour in the profile's own
// timezone, so a case that needs "it is 11am" fixes the whole environment to a
// zone with no offset and freezes Date there.
//
// Frozen, but movable. `boot` returns a `setClock` that winds this forward, so
// a case can hold a rendered page still and let the time pass underneath it —
// which is the one thing a page open on a phone does that a test otherwise
// never reproduces.
function atClock(hhmm) {
  const at = { h: 0, m: 0 };
  const set = (s) => {
    const [h, m] = s.split(':').map(Number);
    at.h = h;
    at.m = m;
  };
  set(hhmm);

  const Frozen = class extends Date {
    constructor(...a) {
      if (a.length) return super(...a);
      return super(Date.UTC(2026, 6, 27, at.h, at.m, 0));
    }
    static now() {
      return Date.UTC(2026, 6, 27, at.h, at.m, 0);
    }
  };
  Frozen.moveTo = set;
  return Frozen;
}

/** Builds a fresh script instance with its own DOM. */
function boot({
  calendar = [], plan = null, failed = [], reduced = false,
  entries = null, now = null, failEntries = false,
} = {}) {
  // Frozen by default, not just when a case asks.
  //
  // The stub says today is 2026-07-27 and atClock freezes to that same date, so
  // a boot on the real clock was running the stub's date against the machine's
  // time. That was invisible while the page opened on TOMORROW — nothing looked
  // at the hour. It opens on today now, where the hour decides which blocks have
  // begun, what has a chip, and where the day starts reflowing from, so an
  // unfrozen boot would pass or fail by what time the suite ran at.
  //
  // 07:00 UTC is 03:00 in the stub's New York, comfortably before the 08:00
  // wake, so a day boots clean with nothing begun.
  const clock = atClock(now || '07:00');
  // Every id the markup declares, read from the file rather than listed here.
  const byId = {};
  for (const id of new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))) {
    byId[id] = new El();
  }
  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button');
    b.dataset.type = t;
    byId['type-seg'].append(b);
  }

  // Every document-level listener, recorded with the options it was given.
  // The reorder bug was a missing one of these, and "it is registered, and it
  // is registered non-passive" is the whole of the fix — so it is worth being
  // able to assert rather than read.
  const listeners = [];

  // A page that can be scrolled out from under a drag.
  // Page-level listeners, kept so a case can fire one. `pagehide` is the hook
  // that makes a deferred write survive a closed tab, and a stub without
  // addEventListener would have the page throw on load rather than fail the
  // case that cares.
  const winListeners = [];
  const win = {
    scrollY: 0,
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    fire: (type) => winListeners.filter((l) => l.type === type).forEach((l) => l.fn()),
  };

  // Every request that carried a body, so a case can read what the page sent
  // rather than infer it from what the page shows.
  const posted = [];

  // Every confirm() the page raised. Delete used to ask before removing a
  // thing; the undo replaced that, and this is how a case proves it.
  const confirmed = [];

  // A plan per date, so a case can hand back different days and the switch
  // has something to switch between.
  const plans = plan && plan.plan === undefined ? plan : null;
  const planFor = (url) => {
    const date = url.split('/').pop();
    if (plans) return plans[date] || { plan: null, blocks: [] };
    return plan || { plan: null, blocks: [] };
  };

  const sandbox = {
    console, setTimeout, clearTimeout, Intl, Math, JSON,
    Date: clock,
    String, Number, Boolean, Array, Object,
    alert: () => {},
    // Recorded rather than merely answered, so a case can assert that Delete
    // stopped asking.
    confirm: (q) => {
      confirmed.push(q);
      return true;
    },
    prompt: () => 'Typed block',
    window: win,
    fetch: async (url, opts) => {
      // Every POST, with or without a body: Done and Delete carry none, and a
      // case has to be able to see that they went out at all. `keepalive`
      // travels with it, because a write that has to survive the page closing
      // is only doing its job if it is set.
      if (opts && opts.method === 'POST') {
        posted.push({
          url,
          body: opts.body ? JSON.parse(opts.body) : null,
          keepalive: Boolean(opts.keepalive),
        });
      }
      return {
        ok: true,
        json: async () => {
          if (url === '/entries' && failEntries) throw new Error('offline');
          if (url.startsWith('/calendar')) return { items: calendar, failed };
          if (url.startsWith('/plan/')) return planFor(url);
          if (url === '/plan') return { date: 'x', blocks: 0, status: 'confirmed', ids: [] };
          return entries || ENTRIES;
        },
      };
    },
    document: {
      getElementById: (id) => byId[id],
      createElement: (t) => new El(t),
      addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
      removeEventListener: (type, fn) => {
        const at = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (at !== -1) listeners.splice(at, 1);
      },
    },
  };
  // Only defined when the case is about reduced motion, so every other case
  // exercises the animated path the way a default device would.
  if (reduced) sandbox.matchMedia = () => ({ matches: true });

  const ctx = vm.createContext(sandbox);
  vm.runInContext(SCRIPT, ctx);

  const slots = () => byId.builder.children.filter((c) => c._class.has('slot'));
  const cardOf = (s) => s.children.find((c) => c._class.has('block'));
  const backingOf = (s) => s.children.find((c) => c._class.has('backing'));
  const rowOf = (s) => cardOf(s).children.find((c) => c._class.has('brow'));
  const chipOf = (s) => rowOf(s).children.find((c) => c._class.has('dur'));
  const noteOf = (s) => cardOf(s).children.find((c) => c._class.has('note'));
  const editorOf = (s) => cardOf(s).children.find((c) => c._class.has('noteedit'));

  // The title alone. Reading it out of the whole card's text stopped working
  // when times became twelve hour: "8:00 AM" contains an A, so a block called
  // "A" appeared to be present in every row on the screen.
  const titleOf = (s) => {
    const left = rowOf(s).children.find((c) => c.children.some((k) => k._class.has('t')));
    return (left.children.find((k) => k._class.has('t')) || {}).textContent || '';
  };
  const titles = () => slots().map(titleOf);

  const touchmoves = () => listeners.filter((l) => l.type === 'touchmove');

  return {
    ctx, byId, slots, cardOf, backingOf, rowOf, chipOf, noteOf, editorOf,
    titleOf, titles, listeners, touchmoves, win, posted, confirmed,
    // Wind the frozen clock on without re-rendering, the way a page left
    // open on a phone experiences time passing.
    setClock: (hhmm) => clock.moveTo && clock.moveTo(hhmm),
  };
}

const cancel = (card) => card.onpointercancel({ pointerId: 1 });

// Synthetic pointer sequence. One finger, id 1.
const down = (card, x = 0, y = 0) =>
  card.onpointerdown({ pointerId: 1, button: 0, clientX: x, clientY: y });
const move = (card, x, y) =>
  card.onpointermove({ pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
const up = (card, x = 0, y = 0) =>
  card.onpointerup({ pointerId: 1, clientX: x, clientY: y });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HELD = 460; // past HOLD_MS
const SETTLED = 220; // past SETTLE_MS
const UNDO_LAPSED = 6200; // past UNDO_MS, so the offer has been let go
const CLOSED = 220; // past CLOSE_MS, so the day has closed over a removed block

(async () => {
  console.log('duration: tap the chip to cycle');
  {
    const { ctx, byId, slots, chipOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });

    check('a new block is 30m', chipOf(slots()[0]).textContent === '30m',
      chipOf(slots()[0]).textContent);

    const seen = [];
    for (let i = 0; i < 9; i++) {
      chipOf(slots()[0]).onclick();
      seen.push(chipOf(slots()[0]).textContent);
    }
    // Half hours read as a fraction rather than as two numbers: 1.5h, not
    // 1h 30m. One number is quicker on a chip.
    check('it climbs by half hours to four, then wraps',
      seen.join(' ') === '1h 1.5h 2h 2.5h 3h 3.5h 4h 30m 1h', seen.join(' '));

    check('the end time follows', byId['end-time'].textContent === '9:00 AM',
      byId['end-time'].textContent);
  }

  console.log('\nreduced motion removes without the close');
  {
    // Stillness is the setting, not a slower version of the same thing: the
    // block goes on release, with no gap to watch shut.
    const { ctx, slots, cardOf, titles } = boot({ reduced: true });
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    down(card, 200, 100);
    move(card, 100, 100);
    up(card, 100, 100);

    check('it is gone at once, with nothing to wait for',
      titles().join() === 'B', titles().join());
    check('and nothing was left collapsing', slots().length === 1, String(slots().length));
  }

  console.log('\nan empty day still takes a day\'s worth of room');
  {
    // With nothing scheduled the builder collapsed to nothing and Starts sat
    // against + Block, which read as a broken control rather than a day with
    // space in it.
    const { ctx, byId, slots } = boot();
    await ctx.load();

    const ghosts = () => byId.builder.children.filter((c) => c._class.has('ghost'));
    check('an empty day holds a space open', ghosts().length === 1,
      String(ghosts().length));
    check('and it is built as a block, so it cannot drift from one',
      ghosts()[0]._class.has('block'));
    check('hidden from anything reading the page aloud',
      ghosts()[0]._attrs['aria-hidden'] === 'true',
      JSON.stringify(ghosts()[0]._attrs));

    // The line boxes are what give it height. Empty divs have none, so the
    // card would collapse to its padding.
    const row = ghosts()[0].children.find((c) => c._class.has('brow'));
    const left = row.children[0];
    check('with both lines carrying a non-breaking space',
      left.children.every((c) => c.textContent === ' '),
      JSON.stringify(left.children.map((c) => c.textContent)));

    // The one that would bite: it must not read as a block anywhere.
    check('it is not a slot, so nothing counts it as a block',
      slots().length === 0, String(slots().length));
    check('and the day still ends nowhere', byId['end-time'].textContent === '—',
      byId['end-time'].textContent);

    ctx.addBlock({ title: 'Real' });
    check('a real block replaces it', ghosts().length === 0, String(ghosts().length));
    check('and the day is one block long', slots().length === 1, String(slots().length));
  }

  console.log('\nthe cover comes off once the day is on screen');
  {
    const { ctx, byId } = boot();
    check('it is over the page before anything loads', !byId.booting._class.has('done'));

    await ctx.load();
    ctx.uncover();
    check('and lifts once the day is there', byId.booting._class.has('done'));

    // Faded, then taken out of the layout. Opacity alone leaves a fixed
    // full-screen element sitting over the app.
    await wait(260);
    check('then it stops occupying the page', byId.booting.style.display === 'none',
      JSON.stringify(byId.booting.style));
  }

  console.log('\nand comes off even when the load fails');
  {
    // A cover that never lifts claims something is still coming. The empty
    // screen at least says what it knows.
    const { ctx, byId } = boot({ failEntries: true });
    await ctx.load();
    ctx.uncover();
    check('the load gave up', true);
    check('and the cover still lifted', byId.booting._class.has('done'));
  }

  console.log('\nan odd length from an older grid is pulled back onto it');
  {
    const { ctx, slots, chipOf } = boot({
      plan: {
        plan: { date: '2026-07-28', status: 'confirmed', wake_minutes: 480 },
        blocks: [{ title: 'Legacy', entryId: null, start_minutes: 480, duration_minutes: 45 }],
      },
    });
    await ctx.load();
    check('it opens on the odd length it was saved with',
      chipOf(slots()[0]).textContent === '45m', chipOf(slots()[0]).textContent);
    chipOf(slots()[0]).onclick();
    check('and one tap lands on the grid', chipOf(slots()[0]).textContent === '1h',
      chipOf(slots()[0]).textContent);

    // An odd length with an hour in it has no half to write, so it is said
    // plainly rather than rounded into something it is not.
    check('1h 15m is not dressed up as 1.25h or 1.5h',
      ctx.span(75) === '1h 15m', ctx.span(75));
    check('and 2h 45m likewise', ctx.span(165) === '2h 45m', ctx.span(165));
    check('but every length the chip makes is a fraction or a whole',
      [30, 60, 90, 120, 150, 180, 210, 240].map((m) => ctx.span(m)).join(' ') ===
        '30m 1h 1.5h 2h 2.5h 3h 3.5h 4h',
      [30, 60, 90, 120, 150, 180, 210, 240].map((m) => ctx.span(m)).join(' '));
  }

  console.log('\nthe steppers and the keep/remove confirm are gone');
  {
    const { ctx, slots, cardOf, rowOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    const card = cardOf(slots()[0]);
    check('no stepper on a block', !rowOf(slots()[0]).children.some((c) => c._class.has('stepper')));
    check('no keep/remove', !card.children.some((c) => c._class.has('confirming')));
    check('one chip, and that is the whole control',
      rowOf(slots()[0]).children.filter((c) => c._class.has('dur')).length === 1);
  }

  console.log('\nchanging one duration shifts every block below it');
  {
    const { ctx, byId, slots, chipOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });
    check('laid out in sequence', slots()[2].text().includes('9:00 AM – 9:30 AM'),
      slots()[2].text().trim());

    chipOf(slots()[0]).onclick(); // A: 30 -> 60
    check('the one below moved', slots()[1].text().includes('9:00 AM – 9:30 AM'),
      slots()[1].text().trim());
    check('and the one below that', slots()[2].text().includes('9:30 AM – 10:00 AM'),
      slots()[2].text().trim());
    check('the one above did not', slots()[0].text().includes('8:00 AM – 9:00 AM'),
      slots()[0].text().trim());
    check('the end time followed live', byId['end-time'].textContent === '10:00 AM',
      byId['end-time'].textContent);
  }

  console.log('\nswipe left removes, with an undo rather than a confirm');
  {
    const { ctx, byId, slots, cardOf, backingOf, titleOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    down(card, 200, 100);
    move(card, 180, 100);
    check('the card follows the finger', card.style.transform === 'translateX(-20px)',
      card.style.transform);
    check('and reveals the miss colour behind it', backingOf(slots()[0])._class.has('left'));
    check('saying what it will do', backingOf(slots()[0]).textContent === 'Remove',
      backingOf(slots()[0]).textContent);
    check('fading in with the travel',
      Number(backingOf(slots()[0]).style.opacity) > 0 &&
        Number(backingOf(slots()[0]).style.opacity) < 1,
      backingOf(slots()[0]).style.opacity);

    move(card, 110, 100); // -90, past the 72 threshold
    up(card, 110, 100);

    // The block goes at once; the day takes a moment to close over it, and the
    // splice waits for that. So the removal is asynchronous now and a case has
    // to let it finish.
    check('the card is hidden the instant it is released',
      cardOf(slots()[0]).style.visibility === 'hidden', cardOf(slots()[0]).style.visibility);
    check('and its slot is collapsing', slots()[0].style.height === '0px',
      slots()[0].style.height);

    await wait(CLOSED);

    check('it is gone', slots().length === 1, `${slots().length}`);
    check('and the one below moved up', titleOf(slots()[0]) === 'B', titleOf(slots()[0]));
    check('no confirm was asked for', true);

    const bar = byId['undo-host'].children[0];
    check('an undo is offered', Boolean(bar) && bar._class.has('undo'));
    check('and it says what happened', bar.text().includes('Removed'), bar.text().trim());

    bar.children.find((c) => c.tagName === 'button').onclick();
    check('undo puts it back', slots().length === 2, `${slots().length}`);
    check('in the place it came from', slots()[0].text().includes('A'), slots()[0].text().trim());
    check('and the bar goes', byId['undo-host'].children.length === 0);
  }

  console.log('\nswipe right opens a note on that block');
  {
    const { ctx, slots, cardOf, backingOf, noteOf, editorOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    move(card, 130, 100);
    check('the backing is neutral, not the miss colour',
      backingOf(slots()[0])._class.has('right') && !backingOf(slots()[0])._class.has('left'));
    check('and says what it will do', backingOf(slots()[0]).textContent === 'Note',
      backingOf(slots()[0]).textContent);

    move(card, 180, 100); // +80
    up(card, 180, 100);

    check('no block was added', slots().length === 2, `${slots().length}`);
    check('and none was called Buffer', !slots().some((s) => s.text().includes('Buffer')));

    const area = editorOf(slots()[0]);
    check('a field opened on that block', Boolean(area));
    check('it is a textarea, so two lines are visible', area.tagName === 'textarea');
    check('with the placeholder asked for',
      area.placeholder === 'What are you doing in this block?', area.placeholder);
    check('capitalised by sentence, for dictation',
      area.getAttribute('autocapitalize') === 'sentences');
    check('spellchecked', area.getAttribute('spellcheck') === 'true');
    check('and not autocompleted at', area.getAttribute('autocomplete') === 'off');
    check('the other block has none', !editorOf(slots()[1]));

    area.value = 'Finish the pricing page';
    area.onblur();

    check('leaving the field saves it', Boolean(noteOf(slots()[0])));
    check('under the title', noteOf(slots()[0]).textContent === 'Finish the pricing page',
      noteOf(slots()[0]).textContent);
    check('and the editor closed', !editorOf(slots()[0]));
    check('the block is otherwise unchanged',
      slots()[0].text().includes('8:00 AM – 8:30 AM'), slots()[0].text().trim());
  }

  console.log('\nswiping a block that has a note reopens it');
  {
    const { ctx, slots, cardOf, noteOf, editorOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });

    const swipeRight = () => {
      const card = cardOf(slots()[0]);
      down(card, 100, 100);
      move(card, 190, 100);
      up(card, 190, 100);
    };

    swipeRight();
    editorOf(slots()[0]).value = 'first';
    editorOf(slots()[0]).onblur();
    check('a note is there', noteOf(slots()[0]).textContent === 'first');

    swipeRight();
    check('swiping again reopens it', Boolean(editorOf(slots()[0])));
    check('with the text already in it', editorOf(slots()[0]).value === 'first',
      editorOf(slots()[0]).value);

    editorOf(slots()[0]).value = 'second';
    editorOf(slots()[0]).onblur();
    check('and it can be rewritten', noteOf(slots()[0]).textContent === 'second',
      noteOf(slots()[0]).textContent);

    swipeRight();
    editorOf(slots()[0]).value = '   ';
    editorOf(slots()[0]).onblur();
    check('clearing it removes the note', !noteOf(slots()[0]));
    check('the block itself survives', slots().length === 1, `${slots().length}`);

    // Whitespace was not stored as a note that happens to look empty.
    swipeRight();
    check('and it really is gone, not stored as blank',
      editorOf(slots()[0]).value === '', JSON.stringify(editorOf(slots()[0]).value));
  }

  console.log('\na block being written in takes no gestures');
  {
    const { ctx, slots, cardOf, editorOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    move(card, 190, 100);
    up(card, 190, 100);
    check('the note is open', Boolean(editorOf(slots()[0])));

    // A press to place the cursor must not start a hold that lifts the card
    // out from under the keyboard.
    const open = cardOf(slots()[0]);
    down(open, 100, 100);
    await wait(HELD);
    check('holding it does not pick it up', !open._class.has('lifted'));
    up(open, 100, 100);

    down(open, 200, 100);
    move(open, 100, 100);
    up(open, 100, 100);
    check('and it cannot be swiped away', slots().length === 2, `${slots().length}`);
    check('the note is still open', Boolean(editorOf(slots()[0])));
  }

  console.log('\na note is a change to the day');
  {
    const { ctx, byId, slots, editorOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.setSaved(true);
    check('the day starts saved', byId['confirm'].textContent === 'Confirmed');

    ctx.openNote(0);
    editorOf(slots()[0]).value = 'a note';
    editorOf(slots()[0]).onblur();
    check('writing one un-saves it', byId['confirm'].textContent === 'Confirm',
      byId['confirm'].textContent);

    ctx.setSaved(true);
    ctx.openNote(0);
    editorOf(slots()[0]).onblur(); // closed without changing anything
    check('but opening and closing without a change does not',
      byId['confirm'].textContent === 'Confirmed', byId['confirm'].textContent);
  }

  console.log('\na note survives a reload of a confirmed day');
  {
    const { ctx, slots, noteOf } = boot({
      plan: {
        plan: { date: '2026-07-28', status: 'confirmed', wake_minutes: 480 },
        blocks: [
          { title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 30, note: 'ch. 4' },
          { title: 'Email', entryId: null, start_minutes: 510, duration_minutes: 30, note: null },
        ],
      },
    });
    await ctx.load();
    check('it comes back with the block', noteOf(slots()[0]).textContent === 'ch. 4',
      noteOf(slots()[0]).textContent);
    check('and a block without one shows none', !noteOf(slots()[1]));
  }


  console.log('\na swipe short of the threshold does nothing');
  {
    const { ctx, slots, cardOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });

    const card = cardOf(slots()[0]);
    down(card, 200, 100);
    move(card, 150, 100); // -50, short of 72
    up(card, 150, 100);
    check('the block survives', slots().length === 1, `${slots().length}`);
    check('and settles back', card.style.transform === '', card.style.transform);

    down(card, 200, 100);
    move(card, 250, 100); // +50
    up(card, 250, 100);
    check('no buffer either', slots().length === 1, `${slots().length}`);
  }

  console.log('\nvertical movement is the page scrolling, never a gesture');
  {
    const { ctx, slots, cardOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    down(card, 200, 100);
    move(card, 205, 190); // mostly vertical, and far
    check('the card did not move with it', !card.style.transform, card.style.transform);
    check('nothing was picked up', !card._class.has('lifted'));

    move(card, 120, 190); // now drag hard sideways in the same pointer
    check('and it cannot become a swipe afterwards', !card.style.transform, card.style.transform);
    up(card, 120, 190);
    check('nothing was removed', slots().length === 2, `${slots().length}`);
  }

  console.log('\npress and hold picks a block up');
  {
    const { ctx, slots, cardOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    check('not yet', !card._class.has('lifted'));

    await wait(HELD);
    check('it lifts', card._class.has('lifted'));
    check('the slot lifts with it', slots()[0]._class.has('lifted'));
    check('and it grows', /scale\(1\.03\)/.test(card.style.transform), card.style.transform);
    check('the others step back', slots()[1]._class.has('dimmed') && slots()[2]._class.has('dimmed'));
    check('but the held one does not', !slots()[0]._class.has('dimmed'));

    up(card, 100, 100);
    await wait(SETTLED);
    check('dropping it where it was changes nothing', slots()[0].text().includes('A'),
      slots()[0].text().trim());
    check('and puts everything back', !slots()[1]._class.has('dimmed'));
  }

  console.log('\na carried block stops the page scrolling under it');
  {
    // The bug this pins: the drag activated and animated, then the browser
    // claimed the gesture as a scroll and fired pointercancel, which tore the
    // drag down. preventDefault on a pointermove cannot stop that and
    // setPointerCapture does not try to. A non-passive touchmove listener is
    // the only thing that does.
    const { ctx, slots, cardOf, touchmoves } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    check('nothing is held before the press', touchmoves().length === 0);

    down(card, 100, 100);
    check('nor while it is only pending', touchmoves().length === 0);

    await wait(HELD);
    check('the hold installs one', touchmoves().length === 1, `${touchmoves().length}`);
    check('and it is NON-PASSIVE, or preventDefault is ignored',
      touchmoves()[0].opts && touchmoves()[0].opts.passive === false,
      JSON.stringify(touchmoves()[0].opts));
    check('it actually calls preventDefault', (() => {
      let called = false;
      touchmoves()[0].fn({ cancelable: true, preventDefault: () => (called = true) });
      return called;
    })());
    check('and does not on an event that cannot be cancelled', (() => {
      let called = false;
      touchmoves()[0].fn({ cancelable: false, preventDefault: () => (called = true) });
      return !called;
    })());

    check('the card is also taken off pan-y', card.style.touchAction === 'none',
      String(card.style.touchAction));

    move(card, 100, 140);
    check('and the drag survives a move', card._class.has('lifted'));

    up(card, 100, 140);
    check('release lets the page go immediately', touchmoves().length === 0,
      `${touchmoves().length} still installed`);
    check('and restores pan-y', !card.style.touchAction, String(card.style.touchAction));
  }

  console.log('\nand it lets go even if the browser takes the gesture anyway');
  {
    const { ctx, slots, cardOf, touchmoves } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);
    check('held', touchmoves().length === 1);

    cancel(card);
    check('a cancelled gesture releases the page', touchmoves().length === 0,
      `${touchmoves().length} left installed`);
    check('restores pan-y', !card.style.touchAction, String(card.style.touchAction));
    check('and drops the lift', !card._class.has('lifted'));
  }

  console.log('\na drag is measured against where the page is now');
  {
    // Nothing should scroll while a block is carried. If something does
    // anyway, the block has to stay under the finger rather than drift by
    // however far the page moved.
    const { ctx, slots, cardOf, win } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);

    // The finger has not moved, but the page has by one whole slot.
    win.scrollY = SLOT;
    move(card, 100, 100);
    check('the block follows the content, not the viewport',
      card.style.transform.startsWith(`translateY(${SLOT}px)`), card.style.transform);
    check('and the target moved with it',
      slots()[1].style.transform === `translateY(-${SLOT}px)`,
      slots()[1].style.transform);

    up(card, 100, 100);
    await wait(SETTLED);
    check('so it lands where it looked like it would',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' ') === 'B A C',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' '));
  }

  console.log('\nstarting a drag on an already-scrolled page');
  {
    const { ctx, slots, cardOf, win } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });

    win.scrollY = 640; // the person scrolled down before touching anything

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);
    move(card, 100, 100 + SLOT);
    check('the drag reads from the delta, not the absolute offset',
      card.style.transform.startsWith(`translateY(${SLOT}px)`), card.style.transform);
    up(card, 100, 100 + SLOT);
    await wait(SETTLED);
    check('and it still reorders correctly',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' ') === 'B A C',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' '));
  }

  console.log('\na swipe and a tap never hold the page');
  {
    const { ctx, slots, cardOf, chipOf, touchmoves } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });

    chipOf(slots()[0]).onclick();
    check('a tap does not', touchmoves().length === 0);

    const card = cardOf(slots()[0]);
    down(card, 200, 100);
    move(card, 120, 100);
    check('nor a swipe in flight', touchmoves().length === 0, `${touchmoves().length}`);
    up(card, 120, 100);
    check('nor after it commits', touchmoves().length === 0, `${touchmoves().length}`);
  }

  console.log('\nheld, then dragged to a new place');
  {
    const { ctx, slots, cardOf, titles } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);

    move(card, 100, 100 + SLOT * 2); // down two places
    check('the blocks it passes part to show the gap',
      slots()[1].style.transform === `translateY(-${SLOT}px)` &&
        slots()[2].style.transform === `translateY(-${SLOT}px)`,
      `${slots()[1].style.transform} / ${slots()[2].style.transform}`);

    up(card, 100, 100 + SLOT * 2);
    await wait(SETTLED);

    check('it landed last', titles().indexOf('A') > titles().indexOf('C'), titles().join(' '));
    check('the order is B C A',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' ') === 'B C A',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' '));
    check('and the times were recomputed from the top',
      slots()[0].text().includes('8:00 AM – 8:30 AM'), slots()[0].text().trim());
    check('every transform was cleared', slots().every((s) => !s.style.transform));
  }

  console.log('\ndragging up, and off the ends');
  {
    const { ctx, slots, cardOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });

    const card = cardOf(slots()[2]);
    down(card, 100, 300);
    await wait(HELD);
    move(card, 100, 300 - SLOT * 9); // far past the top
    up(card, 100, 300 - SLOT * 9);
    await wait(SETTLED);

    check('it clamps to first rather than falling off',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' ') === 'C A B',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' '));
  }

  console.log('\ngesture arbitration');
  {
    const { ctx, slots, cardOf, chipOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    // A hold that began on the chip is a pick-up, not a tap.
    const card = cardOf(slots()[0]);
    const chip = chipOf(slots()[0]);
    const before = chip.textContent;

    down(card, 100, 100);
    await wait(HELD);
    check('a hold on the chip still lifts the block', card._class.has('lifted'));
    up(card, 100, 100);
    chip.onclick(); // the click a real tap would fire on the way out
    await wait(SETTLED);
    check('and the duration was not cycled by it',
      chipOf(slots()[0]).textContent === before,
      `${before} -> ${chipOf(slots()[0]).textContent}`);

    // A committed swipe must not also cycle the duration.
    const c2 = cardOf(slots()[0]);
    const chip2 = chipOf(slots()[0]);
    down(c2, 200, 100);
    move(c2, 100, 100);
    up(c2, 100, 100);
    await wait(CLOSED);
    chip2.onclick();
    check('a swipe does not also cycle a duration', slots().length === 1, `${slots().length}`);
  }

  console.log('\nreduced motion keeps the reorder and drops the movement');
  {
    const { ctx, slots, cardOf } = boot({ reduced: true });
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);

    check('it is still visibly held', card._class.has('lifted'));
    check('the others still step back', slots()[1]._class.has('dimmed'));
    check('but it does not grow', !/scale/.test(card.style.transform || ''),
      card.style.transform);
    check('and nothing is given a transition',
      slots().every((s) => !s.style.transition), 'a transition was set');

    move(card, 100, 100 + SLOT);
    up(card, 100, 100 + SLOT);
    // No settle to wait for: reduced motion commits immediately.
    check('the reorder still happened',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' ') === 'B A',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' '));
  }

  console.log('\nthe rest of the builder still holds');
  {
    const { ctx, byId, slots } = boot();
    await ctx.load();
    check('nothing to confirm on an empty day', byId['confirm'].disabled === true);
    check('and the end time says nothing', byId['end-time'].textContent === '—');

    ctx.addBlock({ title: 'A' });
    check('a block enables it', byId['confirm'].disabled === false);
    ctx.setSaved(true);
    check('once saved it reads Confirmed', byId['confirm'].textContent === 'Confirmed');
    ctx.addBlock({ title: 'B' });
    check('adding a block un-saves it', byId['confirm'].textContent === 'Confirm');

    for (let i = 0; i < 16; i++) ctx.addBlock({ title: `x${i}`, duration: 60 });
    check('past midnight is spelled out', /next day/.test(byId['end-time'].textContent),
      byId['end-time'].textContent);
    check('and flagged late', byId.ends._class.has('late'));
    check('the blocks are all there', slots().length === 18, `${slots().length}`);
  }

  console.log('\nthe start control is untouched');
  {
    const { ctx, byId, slots } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    check('still a stepper', byId['wake-time'].textContent === '8:00 AM');
    byId['wake-plus'].onclick();
    check('one step is half an hour', byId['wake-time'].textContent === '8:30 AM');
    check('and the day moved with it', slots()[0].text().includes('8:30 AM – 9:00 AM'),
      slots()[0].text().trim());
    for (let i = 0; i < 40; i++) byId['wake-minus'].onclick();
    check('still clamped at 4:00 AM', byId['wake-time'].textContent === '4:00 AM');
  }

  // --- today and tomorrow --------------------------------------------------

  const TODAY = '2026-07-27';
  const TOMORROW = '2026-07-28';

  // 08:00–09:00 done, 09:00–10:00 done, 11:00–13:00 still to come, with the
  // clock fixed at 11:00 in a zone with no offset.
  const twoDays = () => ({
    [TODAY]: {
      plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
      blocks: [
        { id: 't1', title: 'Reading', entryId: 'e-read', start_minutes: 480, duration_minutes: 60, sent: true },
        { id: 't2', title: 'Gym', entryId: null, start_minutes: 540, duration_minutes: 60, sent: true, missed: true },
        { id: 't3', title: 'UF application', entryId: 'e-uf', start_minutes: 660, duration_minutes: 120 },
      ],
    },
    [TOMORROW]: {
      plan: { date: TOMORROW, status: 'confirmed', wake_minutes: 480 },
      blocks: [
        { id: 'm1', title: 'Spanish', entryId: 'e-spanish', start_minutes: 480, duration_minutes: 60 },
      ],
    },
  });

  const utcEntries = (extra = {}) => ({
    today: TODAY, timezone: 'UTC', wake_time: '08:00', items: [], ...extra,
  });

  console.log('\nthe switch is the label');
  {
    const { ctx, byId, titles } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.load();

    // IT OPENS ON TODAY, whatever plans_in says. The screen is opened to look
    // at the day you are in; planning tomorrow is one deliberate visit and the
    // switch is one tap away.
    check('it opens on today', byId['pick-today']._class.has('on'));
    check('and tomorrow is the quiet one', !byId['pick-tomorrow']._class.has('on'));
    check('the date says which', byId['plan-date'].textContent === 'Mon 27 Jul',
      byId['plan-date'].textContent);
    check("today's plan is the one loaded",
      titles().join() === 'Reading,Gym,UF application', titles().join());
    check('and Starts is hidden, because the day already started',
      byId.starts._class.has('hidden'));

    await byId['pick-tomorrow'].onclick();
    check('tapping Tomorrow switches', byId['pick-tomorrow']._class.has('on'));
    check('and today goes quiet', !byId['pick-today']._class.has('on'));
    check('the date follows', byId['plan-date'].textContent === 'Tue 28 Jul',
      byId['plan-date'].textContent);
    check("tomorrow's plan is loaded", titles().join() === 'Spanish', titles().join());
    check('and the Starts control is there', !byId.starts._class.has('hidden'));

    await byId['pick-today'].onclick();
    check('and back again', titles().join() === 'Reading,Gym,UF application',
      titles().join());
    check('with Starts hidden again', byId.starts._class.has('hidden'));
  }

  console.log('\nthe switch shows a wait rather than the day you are leaving');
  {
    // Tapping Tomorrow used to leave today's blocks on screen, under the word
    // Tomorrow, until two fetches came back. Long enough on a phone to read the
    // wrong day and believe it.
    const { ctx, byId, titles } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.load();
    check('today is on screen', titles().join() === 'Reading,Gym,UF application',
      titles().join());

    // Started, not awaited: the point is what is on screen DURING the fetch.
    const switching = byId['pick-tomorrow'].onclick();

    const waiting = byId.builder.children.filter((c) => c._class.has('waiting'));
    check('the old day is gone at once', titles().length === 0, titles().join());
    check('and a dot is there instead', waiting.length === 1, String(waiting.length));
    check('one dot, nothing else in the builder',
      byId.builder.children.length === 1, String(byId.builder.children.length));
    check('the end time stops claiming the old hour',
      byId['end-time'].textContent === '—', byId['end-time'].textContent);

    await switching;
    check('then tomorrow arrives', titles().join() === 'Spanish', titles().join());
    check('and the dot is gone',
      byId.builder.children.filter((c) => c._class.has('waiting')).length === 0);
    check('with its real end time back', byId['end-time'].textContent === '9:00 AM',
      byId['end-time'].textContent);
  }

  console.log('\ntoday through the day, tomorrow once the evening turns');
  {
    const openedOn = async (at, extra = {}) => {
      const b = boot({ plan: twoDays(), entries: utcEntries(extra), now: at });
      await b.ctx.load();
      return b.byId['pick-tomorrow']._class.has('on') ? 'tomorrow' : 'today';
    };

    check('the morning opens on today', (await openedOn('08:00')) === 'today');
    check('and the afternoon does too', (await openedOn('15:30')) === 'today');

    // The boundary. Nudge hour is 20:00 by default, and the screen turns with
    // it rather than a minute either side.
    check('19:59 is still today', (await openedOn('19:59')) === 'today');
    check('20:00 is tomorrow', (await openedOn('20:00')) === 'tomorrow');
    check('and so is later', (await openedOn('23:30')) === 'tomorrow');

    // Past midnight is a new today, not a late yesterday.
    check('half past midnight is today again', (await openedOn('00:30')) === 'today');

    // The hour follows the profile, because it is the same hour the nudge uses.
    check('a later nudge hour moves the turn with it',
      (await openedOn('20:00', { nudge_hour: 22 })) === 'today');
    check('and the screen turns when that hour comes',
      (await openedOn('22:00', { nudge_hour: 22 })) === 'tomorrow');
    check('an earlier one turns earlier',
      (await openedOn('18:00', { nudge_hour: 18 })) === 'tomorrow');

    // plans_in decided this once. It decides nothing about it now.
    check('who you are does not enter into it',
      (await openedOn('11:00', { plans_in: 'morning' })) === 'today' &&
        (await openedOn('11:00', { plans_in: 'evening' })) === 'today');
    check('nor in the evening',
      (await openedOn('21:00', { plans_in: 'morning' })) === 'tomorrow' &&
        (await openedOn('21:00', { plans_in: 'evening' })) === 'tomorrow');
  }

  console.log('\nconfirm sends the date of the day on screen');
  {
    // THE BUG THIS EXISTS FOR. The confirm posted `date: planDate` — the
    // function, not its result. JSON.stringify drops a function-valued key
    // silently, so the body went out with no date at all and the server
    // answered "date must be YYYY-MM-DD" on every confirm, on every platform.
    //
    // It survived because the suite confirmed days and then read the BLOCKS
    // out of the body. Nothing ever looked at the date, so the one field that
    // was missing was the one field never asserted.
    const TOMORROW = new Date(Date.UTC(2026, 6, 28)).toISOString().slice(0, 10);

    const { ctx, byId, posted } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.load();

    posted.length = 0;
    await byId['confirm'].onclick();
    const body = posted.find((p) => p.url === '/plan').body;

    check('the date is there at all', 'date' in body, JSON.stringify(Object.keys(body)));
    check('and it is a string, not a dropped function', typeof body.date === 'string',
      typeof body.date);
    check('in the shape the server accepts', /^\d{4}-\d{2}-\d{2}$/.test(String(body.date)),
      String(body.date));
    check("and it is today's date, the day on screen", body.date === TODAY,
      `${body.date} vs ${TODAY}`);

    // The switch has to carry through to the payload too, or a confirm on one
    // day would save over the other.
    await byId['pick-tomorrow'].onclick();
    posted.length = 0;
    await byId['confirm'].onclick();
    const tomorrowBody = posted.find((p) => p.url === '/plan').body;
    check('switching to Tomorrow sends tomorrow instead', tomorrowBody.date === TOMORROW,
      `${tomorrowBody.date} vs ${TOMORROW}`);
  }

  console.log('\na morning planner opens on today');
  {
    const { ctx, byId } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '11:00',
    });
    await ctx.load();
    check('today is the active word', byId['pick-today']._class.has('on'));
    check('and Starts is hidden', byId.starts._class.has('hidden'));
  }

  console.log('\ntoday: what has been, and what is left');
  {
    // 10:45, so the third block at 11:00 has genuinely not begun. At 11:00
    // exactly it would have, and would lose its chip with the rest.
    const { ctx, byId, slots, cardOf, rowOf, titles } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '10:45',
    });
    await ctx.load();

    check('all three blocks are there', titles().join() === 'Reading,Gym,UF application',
      titles().join());
    check('the two that have finished are past',
      cardOf(slots()[0])._class.has('past') && cardOf(slots()[1])._class.has('past'));
    check('and the one still to come is not', !cardOf(slots()[2])._class.has('past'));

    const chipIn = (s) => rowOf(s).children.find((c) => c._class.has('dur'));
    check('a past block has no duration chip', !chipIn(slots()[0]));
    check('the upcoming one does', Boolean(chipIn(slots()[2])));

    // And nothing in its place. The chip is withheld because the length can no
    // longer change; there is no question to put there, because a block that
    // did not happen comes out of the day instead.
    check('a past block carries nothing beside its title',
      rowOf(slots()[0]).children.length === 1, String(rowOf(slots()[0]).children.length));
    check('nor does the second one', rowOf(slots()[1]).children.length === 1,
      String(rowOf(slots()[1]).children.length));

    const divider = byId.builder.children.filter((c) => c._class.has('now'));
    check('one divider', divider.length === 1, `${divider.length}`);
    check('between the past and what is left',
      byId.builder.children.indexOf(divider[0]) === 2,
      String(byId.builder.children.indexOf(divider[0])));
    check('it carries a dot and a rule',
      divider[0].children.some((c) => c._class.has('dot')) &&
        divider[0].children.some((c) => c._class.has('ln')));
    check('and no word at all', divider[0].text().trim() === '',
      JSON.stringify(divider[0].text()));
    check('so nothing there claims a side of the line',
      !/NOW|Next/i.test(divider[0].text()), divider[0].text());

    check('a past block keeps the hour it happened at',
      slots()[0].text().includes('8:00 AM – 9:00 AM'), slots()[0].text().trim());
  }

  console.log('\na past block is not asked about, and swipes away like any other');
  {
    // The whole miss mechanism is gone. There is no question on a past block,
    // no marked state, and nothing to tap: a block that did not happen comes
    // out of the day, which is the same gesture as everywhere else.
    const { ctx, slots, cardOf, rowOf, backingOf, titles } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '11:00',
    });
    await ctx.load();

    check('the past block asks nothing',
      !rowOf(slots()[0]).children.some((c) => c._class.has('askmiss')));
    check('and carries nothing at all beside its title',
      rowOf(slots()[0]).children.length === 1,
      String(rowOf(slots()[0]).children.length));

    // Tapping where the question used to be must not do anything either.
    const before = titles().join();
    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    up(card, 100, 100);
    check('a tap on it changes nothing', titles().join() === before, titles().join());

    down(card, 200, 100);
    move(card, 150, 100);
    check('but the swipe says Remove, not "didn\'t happen"',
      backingOf(slots()[0]).textContent === 'Remove', backingOf(slots()[0]).textContent);
    // One surface. The removing side used to be the warn colour across the
    // whole card, which was loudest exactly here — on a block that is over,
    // where taking it out is how the day gets recorded rather than damage.
    check('on the same quiet backing as every other swipe',
      !backingOf(slots()[0])._class.has('hot') && !backingOf(slots()[0])._class.has('calm'),
      [...backingOf(slots()[0])._class].join(' '));

    move(card, 100, 100);
    up(card, 100, 100);
    await wait(CLOSED);
    check('and it goes', titles().join() === 'Gym,UF application', titles().join());
  }

  console.log('\na block added to today starts after now');
  {
    const { ctx, slots, titles } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '11:17',
    });
    await ctx.load();

    ctx.addBlock({ title: 'Errand' });
    check('it is on the end', titles()[3] === 'Errand', titles().join());
    // 11:17 rounds up to 11:30, but UF application runs to 13:00, so the
    // cursor is later than the boundary and wins.
    check('it follows the last block rather than the clock',
      slots()[3].text().includes('1:00 PM – 1:30 PM'), slots()[3].text().trim());
  }

  console.log('\na day that has run out of blocks starts the next one at the half hour');
  {
    const { ctx, slots, titles } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '11:17',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'p1', title: 'Done', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
          ],
        },
      },
    });
    await ctx.load();

    ctx.addBlock({ title: 'Next' });
    check('two blocks', titles().join() === 'Done,Next', titles().join());
    check('the finished one kept its hour', slots()[0].text().includes('8:00 AM – 9:00 AM'),
      slots()[0].text().trim());
    check('and the new one starts at the next half hour, not the wake time',
      slots()[1].text().includes('11:30 AM – 12:00 PM'), slots()[1].text().trim());
  }

  console.log('\ntomorrow has no past and no divider');
  {
    const { ctx, byId, slots, cardOf } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.load();

    // Reached rather than landed on. The page opens on today now, so a case
    // about tomorrow has to say so.
    await byId['pick-tomorrow'].onclick();

    check('nothing is past', slots().every((s) => !cardOf(s)._class.has('past')));
    check('and there is no divider',
      byId.builder.children.filter((c) => c._class.has('now')).length === 0);
    ctx.addBlock({ title: 'Later' });
    check('a new block flows from the wake time', slots()[1].text().includes('9:00 AM – 9:30 AM'),
      slots()[1].text().trim());
  }

  console.log('\na thing already in the shown day is greyed, and nothing else');
  {
    const things = [
      { id: 'e-uf', type: 'project', title: 'UF application', days: 6, mark: '!!!', due: null, size: null, last_scheduled: null },
      { id: 'e-spanish', type: 'habit', title: 'Spanish', days: 3, mark: null, due: null, size: null, last_scheduled: null },
      { id: 'e-free', type: 'task', title: 'Return the router', days: 1, mark: '!', due: null, size: null, last_scheduled: null },
    ];
    const { ctx, byId, slots, titles } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning', items: things }), now: '10:45',
    });
    await ctx.load();

    const rows = () => byId.things.children.filter((c) => c._class.has('row'));
    const rowFor = (title) => rows().find((r) => r.text().includes(title));
    const markOf = (r) => r.children[0].children.find((c) => c._class.has('mark'));

    check('the one in today is greyed', rowFor('UF application')._class.has('locked'));
    check('and says nothing beside it', !rows().some((r) => r.text().includes('plan')),
      rowFor('UF application').text().trim());
    check('there is no badge left anywhere',
      !rows().some((r) => r.children[0].children.some((c) => c._class.has('inplan'))));
    check('its warning mark is held back too, because being scheduled answers it',
      !markOf(rowFor('UF application')));

    check('one in tomorrow is not greyed while today is shown',
      !rowFor('Spanish')._class.has('locked'));
    check('nor is one in no plan at all', !rowFor('Return the router')._class.has('locked'));
    check('and an unscheduled thing keeps its mark',
      Boolean(markOf(rowFor('Return the router'))));

    await byId['pick-tomorrow'].onclick();
    check('the greying follows the switch', rowFor('Spanish')._class.has('locked'));
    check('and what was greyed on today is free on tomorrow',
      !rowFor('UF application')._class.has('locked'));
    check('with its mark back', Boolean(markOf(rowFor('UF application'))));
  }

  console.log('\ntapping a greyed thing takes it back out of the day');
  {
    const things = [
      { id: 'e-spanish', type: 'habit', title: 'Spanish', days: 3, mark: null, due: null, size: null, last_scheduled: null },
      { id: 'e-free', type: 'task', title: 'Return the router', days: 1, mark: null, due: null, size: null, last_scheduled: null },
    ];
    const { ctx, byId, slots, titles } = boot({
      plan: twoDays(), entries: utcEntries({ items: things }), now: '10:45',
    });
    await ctx.load();

    // The page opens on today, so a case about tomorrow's plan reaches it.
    await byId['pick-tomorrow'].onclick();

    const rows = () => byId.things.children.filter((c) => c._class.has('row'));
    const rowFor = (t) => rows().find((r) => r.text().includes(t));

    check('tomorrow holds one block', titles().join() === 'Spanish', titles().join());
    check('and its row is greyed', rowFor('Spanish')._class.has('locked'));

    rowFor('Spanish').onclick();
    await wait(CLOSED);
    check('tapping it removes the block', titles().join() === '', `"${titles().join()}"`);
    check('and the row comes back to normal', !rowFor('Spanish')._class.has('locked'));
    check('undoably, like any other removal', byId['undo-host'].children.length === 1);

    // Put it back and add it twice, to check one tap takes one block.
    byId['undo-host'].children[0].children.find((c) => c.tagName === 'button').onclick();
    check('undo restores it', titles().join() === 'Spanish', titles().join());
    check('and greys the row again', rowFor('Spanish')._class.has('locked'));

    // One tap in, one tap out. It never adds a second block for the same
    // thing, because after the first tap the row is greyed and a tap on a
    // greyed row means take it out.
    rowFor('Return the router').onclick();
    check('a tap on a free row puts it in',
      titles().join() === 'Spanish,Return the router', titles().join());
    rowFor('Return the router').onclick();
    await wait(CLOSED);
    check('and the next tap takes it straight back out',
      titles().join() === 'Spanish', titles().join());
  }

  console.log('\ntwice in one day comes out one tap at a time');
  {
    const things = [
      { id: 'e-uf', type: 'project', title: 'UF application', days: 6, mark: null, due: null, size: null, last_scheduled: null },
    ];
    const { ctx, byId, titles } = boot({
      entries: utcEntries({ items: things }),
      now: '10:45',
      plan: {
        [TOMORROW]: {
          plan: { date: TOMORROW, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'd1', title: 'UF application', entryId: 'e-uf', start_minutes: 480, duration_minutes: 60 },
            { id: 'd2', title: 'Email', entryId: null, start_minutes: 540, duration_minutes: 30 },
            { id: 'd3', title: 'UF application', entryId: 'e-uf', start_minutes: 570, duration_minutes: 60 },
          ],
        },
      },
    });
    await ctx.load();

    // The plan under test is tomorrow's, and the page opens on today.
    await byId['pick-tomorrow'].onclick();

    const rowFor = (t) => byId.things.children.filter((c) => c._class.has('row'))
      .find((r) => r.text().includes(t));

    check('three blocks, two of them the same thing',
      titles().join() === 'UF application,Email,UF application', titles().join());
    check('the row is greyed', rowFor('UF application')._class.has('locked'));

    rowFor('UF application').onclick();
    await wait(CLOSED);
    check('one tap takes the last of them',
      titles().join() === 'UF application,Email', titles().join());
    check('and the row stays greyed while one remains',
      rowFor('UF application')._class.has('locked'));

    rowFor('UF application').onclick();
    await wait(CLOSED);
    check('the next tap takes the other', titles().join() === 'Email', titles().join());
    check('and now the row is free', !rowFor('UF application')._class.has('locked'));
  }

  console.log('\na thing comes out of the day whatever the clock says');
  {
    const things = [
      { id: 'e-read', type: 'habit', title: 'Reading', days: 3, mark: null, due: null, size: null, last_scheduled: null },
      { id: 'e-uf', type: 'project', title: 'UF application', days: 6, mark: null, due: null, size: null, last_scheduled: null },
    ];
    // Reading ran 08:00–09:00 and is over; UF application starts at 11:00 and
    // has not begun. It is 10:45.
    const { ctx, byId, titles } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning', items: things }), now: '10:45',
    });
    await ctx.load();

    const rowFor = (t) => byId.things.children.filter((c) => c._class.has('row'))
      .find((r) => r.text().includes(t));

    check('both rows are greyed', rowFor('Reading')._class.has('locked') &&
      rowFor('UF application')._class.has('locked'));

    // Reading is over. It used to be exempt, because the server refused to
    // remove a block whose message had gone out; it no longer does, so the row
    // no longer pretends otherwise.
    rowFor('Reading').onclick();
    await wait(CLOSED);
    check('the one that is over comes out too', titles().join() === 'Gym,UF application',
      titles().join());
    check('and its row frees up', !rowFor('Reading')._class.has('locked'));
    check('with an undo, like any other removal', byId['undo-host'].children.length > 0);

    rowFor('UF application').onclick();
    await wait(CLOSED);
    check('and so does the one still to come', titles().join() === 'Gym', titles().join());
    check('its row frees up as well', !rowFor('UF application')._class.has('locked'));
  }

  console.log('\na note is hidden once its block is over');
  {
    const { ctx, slots, cardOf, byId, posted } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '10:45',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'n1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true, note: 'chapter four' },
            { id: 'n2', title: 'Deep work', entryId: null, start_minutes: 600, duration_minutes: 60, sent: true, note: 'pricing page' },
            { id: 'n3', title: 'Errands', entryId: null, start_minutes: 720, duration_minutes: 60, note: 'router, then bank' },
          ],
        },
      },
    });
    await ctx.load();

    const noteIn = (s) => cardOf(s).children.find((c) => c._class.has('note'));

    check('the block that is over does not show its note', !noteIn(slots()[0]));
    check('the one in progress still does',
      noteIn(slots()[1]) && noteIn(slots()[1]).textContent === 'pricing page',
      noteIn(slots()[1]) && noteIn(slots()[1]).textContent);
    check('and so does the one still to come',
      noteIn(slots()[2]) && noteIn(slots()[2]).textContent === 'router, then bank',
      noteIn(slots()[2]) && noteIn(slots()[2]).textContent);

    // Hidden, not lost. The confirm still carries it.
    posted.length = 0;
    await byId['confirm'].onclick();
    const sentBody = posted.find((p) => p.url === '/plan').body;
    check('the hidden note is still sent', sentBody.blocks[0].note === 'chapter four',
      String(sentBody.blocks[0].note));
    check('along with the others',
      sentBody.blocks[1].note === 'pricing page' && sentBody.blocks[2].note === 'router, then bank');
  }

  console.log('\na late day moves what is left, and only what is left');
  {
    // 08:00–09:00 has been and gone and its message went out. The next block
    // is stored at 10:00 and has not begun. It is 09:15, so the next half hour
    // is 09:30 and the block still to come moves up to meet it.
    //
    // The one thing that must not happen is the first block moving with it. It
    // is history: the message named 08:00, and the server refuses to retime a
    // delivered block anyway, so a payload that tried would be rejected whole
    // and the day would silently fail to save.
    const { ctx, slots, byId, posted } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '09:15',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'g1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
            { id: 'g2', title: 'Deep work', entryId: null, start_minutes: 600, duration_minutes: 60 },
          ],
        },
      },
    });
    await ctx.load();

    check('the delivered block is where it always was',
      slots()[0].text().includes('8:00 AM – 9:00 AM'), slots()[0].text().trim());
    check('and reads as past', slots()[0].children[1]._class.has('past'));
    check('what is left moved up to the next half hour',
      slots()[1].text().includes('9:30 AM – 10:30 AM'), slots()[1].text().trim());
    check('so the day no longer matches what is stored, and says so',
      byId['confirm'].textContent === 'Confirm', byId['confirm'].textContent);

    posted.length = 0;
    await byId['confirm'].onclick();

    const sentBody = posted.find((p) => p.url === '/plan');
    check('confirm sent the day', Boolean(sentBody));

    const [first, second] = sentBody.body.blocks;
    check('the delivered block is sent at the hour it was stored at',
      first.start_minutes === 480, String(first.start_minutes));
    check('with the duration it was stored with', first.duration_minutes === 60,
      String(first.duration_minutes));
    check('and its id, so the server updates rather than replaces', first.id === 'g1',
      String(first.id));

    check('only the upcoming one carries a new time', second.start_minutes === 570,
      String(second.start_minutes));
    check('and it keeps its id too', second.id === 'g2', String(second.id));

    // The server refuses a delivered block whose time changed, so sending the
    // stored value is not a nicety: sending anything else would reject the
    // whole request.
    check('nothing a delivered block owns was touched',
      first.start_minutes === 480 && first.duration_minutes === 60);
  }

  console.log('\nan expired block is history too, not just a delivered one');
  {
    // Started but never delivered — the scheduler was down, or the block was
    // past its grace window. `sent` is false, so the server would allow a
    // retime. The page must still not offer one: it began, so it is the day
    // that happened.
    const { ctx, slots, byId, posted } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '09:15',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'x1', title: 'Missed by the scheduler', entryId: null, start_minutes: 480, duration_minutes: 60, sent: false },
            { id: 'x2', title: 'Deep work', entryId: null, start_minutes: 600, duration_minutes: 60 },
          ],
        },
      },
    });
    await ctx.load();

    check('it stayed where it was stored', slots()[0].text().includes('8:00 AM – 9:00 AM'),
      slots()[0].text().trim());
    check('and still reads as past', slots()[0].children[1]._class.has('past'));

    posted.length = 0;
    await byId['confirm'].onclick();
    const body = posted.find((p) => p.url === '/plan').body;
    check('and is sent unchanged', body.blocks[0].start_minutes === 480,
      String(body.blocks[0].start_minutes));
  }

  console.log('\nthe divider does not throw the drag off by one');
  {
    // THE BUG. The gap-opening read every child of the builder, and on a day
    // with something behind it the divider is one of those — while the drag
    // indexes into `blocks`. The two disagreed by one from the divider down,
    // so the gap opened in the wrong place, the divider was shifted instead of
    // a block, and blocks were pushed onto each other. The list appeared to
    // collapse together and then landed correctly, because only the animation
    // was reading the wrong index.
    const { ctx, byId, slots, cardOf, titles } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '10:15',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'q1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
            { id: 'q2', title: 'Gym', entryId: null, start_minutes: 540, duration_minutes: 60, sent: true },
            { id: 'q3', title: 'Errands', entryId: null, start_minutes: 660, duration_minutes: 60 },
            { id: 'q4', title: 'Email', entryId: null, start_minutes: 720, duration_minutes: 60 },
          ],
        },
      },
    });
    await ctx.load();

    const kids = () => byId.builder.children;
    const divider = () => kids().find((c) => c._class.has('now'));
    check('the day has a divider in it', Boolean(divider()));
    check('so the builder holds more children than blocks',
      kids().length === slots().length + 1, `${kids().length} vs ${slots().length}`);

    // Carry the last block up one place — the case reported.
    const card = cardOf(slots()[3]);
    down(card, 100, 300);
    await wait(HELD);
    move(card, 100, 300 - SLOT);

    // The one it passes should move down to open the gap, and nothing else.
    check('the block it passes opens the gap',
      slots()[2].style.transform === `translateY(${SLOT}px)`, slots()[2].style.transform);
    check('the finished blocks are left alone',
      !slots()[0].style.transform && !slots()[1].style.transform,
      `${slots()[0].style.transform} / ${slots()[1].style.transform}`);
    check('and the divider is not dragged around with them',
      !divider().style.transform, divider().style.transform);

    up(card, 100, 300 - SLOT);
    await wait(SETTLED);
    check('it lands where the gap was', titles().join() === 'Reading,Gym,Email,Errands',
      titles().join());
    check('and nothing is left holding a transform',
      slots().every((s) => !s.style.transform),
      JSON.stringify(slots().map((s) => s.style.transform)));
  }

  console.log('\na block cannot be carried into the part of the day that happened');
  {
    // THE BUG. The drop target clamped at index 0 and knew nothing about the
    // past, so an upcoming block could be dragged above every finished one and
    // dropped there.
    //
    // It was not only that the screen said something untrue. reflow holds a
    // begun block at its stored hour and flows the rest from the next half
    // hour, so a block dropped at the top took the next half hour and the
    // finished block beneath it kept 8:00 AM — the day rendered backwards, and
    // the divider went looking for an edge that was no longer there.
    const { ctx, byId, slots, cardOf, titles } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '10:15',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'p1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
            { id: 'p2', title: 'Gym', entryId: null, start_minutes: 540, duration_minutes: 60, sent: true },
            { id: 'p3', title: 'Errands', entryId: null, start_minutes: 660, duration_minutes: 60 },
            { id: 'p4', title: 'Email', entryId: null, start_minutes: 720, duration_minutes: 60 },
          ],
        },
      },
    });
    await ctx.load();

    check('two are finished', cardOf(slots()[0])._class.has('past') &&
      cardOf(slots()[1])._class.has('past'));
    check('and two are still to come', !cardOf(slots()[2])._class.has('past') &&
      !cardOf(slots()[3])._class.has('past'));

    // Carry the last block as far up as the list allows.
    const card = cardOf(slots()[3]);
    down(card, 100, 400);
    await wait(HELD);
    move(card, 100, 400 - SLOT * 3);
    up(card, 100, 400 - SLOT * 3);
    await wait(SETTLED);

    check('it stops at the first free place, not at the top',
      titles().join() === 'Reading,Gym,Email,Errands', titles().join());
    check('so the finished blocks are still the first two',
      titles().slice(0, 2).join() === 'Reading,Gym', titles().join());

    // The real damage was here: the day used to run backwards afterwards.
    const hours = slots().map((s) => s.text().match(/\d+:\d+ [AP]M/)[0]);
    const at = hours.map((h) => {
      const [, hh, mm, ap] = h.match(/(\d+):(\d+) ([AP]M)/);
      return ((Number(hh) % 12) + (ap === 'PM' ? 12 : 0)) * 60 + Number(mm);
    });
    check('and the day still runs forwards', at.every((m, i) => i === 0 || m >= at[i - 1]),
      JSON.stringify(hours));

    check('the finished ones kept the hours they happened at',
      hours[0] === '8:00 AM' && hours[1] === '9:00 AM', JSON.stringify(hours));

    const line = byId.builder.children.filter((c) => c._class.has('now'));
    check('and there is still exactly one divider', line.length === 1, String(line.length));
    check('below the two that are over', byId.builder.children.indexOf(line[0]) === 2,
      String(byId.builder.children.indexOf(line[0])));
  }

  console.log('\na block you are in the middle of is locked');
  {
    // 09:30, so Deep work (09:00–10:00) has begun and has not finished. It
    // used to keep its duration chip, and shrinking it below the half hour
    // already elapsed moved it silently into the past — an action the server
    // refuses on a delivered block anyway.
    const inProgress = () => ({
      [TODAY]: {
        plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
        blocks: [
          { id: 'i1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
          { id: 'i2', title: 'Deep work', entryId: null, start_minutes: 540, duration_minutes: 60, sent: true },
          { id: 'i3', title: 'Errands', entryId: null, start_minutes: 600, duration_minutes: 60 },
        ],
      },
    });
    const opts = { plan: inProgress(), entries: utcEntries({ plans_in: 'morning' }), now: '09:30' };

    const { ctx, byId, slots, cardOf, rowOf, chipOf, titles } = boot(opts);
    await ctx.load();

    check('three blocks', titles().join() === 'Reading,Deep work,Errands', titles().join());
    check('the first is over', cardOf(slots()[0])._class.has('past'));
    check('the second has begun but is not over', !cardOf(slots()[1])._class.has('past'));

    check('it has no duration chip', !chipOf(slots()[1]));
    check('the one still to come does', Boolean(chipOf(slots()[2])));

    // No question on any of them. There is no such question any more.
    const askIn = (s) => rowOf(s).children.find((c) => c._class.has('askmiss'));
    check('nothing asks whether it happened',
      !slots().some((s) => Boolean(askIn(s))));

    // It says what it is instead. The slot the chip vacated was reading as a
    // block that had failed to render one.
    const actIn = (s) => rowOf(s).children.find((c) => c._class.has('running'));
    check('it says it is active', actIn(slots()[1]) && actIn(slots()[1]).textContent === 'active',
      actIn(slots()[1]) && actIn(slots()[1]).textContent);
    check('the one that is over does not', !actIn(slots()[0]));
    check('nor does the one still to come', !actIn(slots()[2]));

    // And the divider sits ABOVE it. The line separates what has happened from
    // what has not, so a block you are in the middle of belongs below it with
    // the rest of what is left.
    //
    // It sat below the running block for a while, which the word forced: "Next"
    // is a claim about the block underneath, and a block already running is not
    // next. With the word gone the line goes back to marking the edge of the
    // past, which is the division that was wanted all along.
    const kids = byId.builder.children;
    const line = kids.filter((c) => c._class.has('now'));
    check('there is one divider', line.length === 1, String(line.length));
    check('and it sits above the block in progress',
      kids.indexOf(line[0]) === 1, String(kids.indexOf(line[0])));
    check('so the running block is below the line, with what is still to come',
      kids.indexOf(line[0]) < kids.indexOf(slots()[1]));
    check('and the block that is over is above it',
      kids.indexOf(slots()[0]) < kids.indexOf(line[0]));

    // Holding it must not pick it up.
    const card = cardOf(slots()[1]);
    down(card, 100, 100);
    await wait(HELD);
    check('holding it does not lift it', !card._class.has('lifted'));
    up(card, 100, 100);

    // Nor may it take a note.
    down(card, 100, 100);
    move(card, 190, 100);
    check('the note swipe does not travel', !card.style.transform, card.style.transform);
    up(card, 190, 100);
    check('and no editor opened', !cardOf(slots()[1]).children.some((c) => c._class.has('noteedit')));
  }

  console.log('\nthe lock follows the clock, not the last render');
  {
    // THE BUG. The lock was a boolean captured when the card was drawn, and
    // nothing re-renders on a clock tick — so a page left open across a
    // block's start time went on offering everything it had offered before it
    // started. Every one of these passed at render time and was wrong a minute
    // later.
    // A page drawn at 09:59 and left alone until 11:00. Deep work runs
    // 10:00–14:00, so at render time it had not started and at press time it
    // had been running an hour.
    //
    // Each case gets its own boot. A gesture leaves swallowClick set so the
    // click it produced does not also reach the chip — correct, and it means
    // one case per rendered page or they mask each other.
    const stale = async () => {
      const b = boot({
        entries: utcEntries({ plans_in: 'morning' }),
        now: '09:59',
        plan: {
          [TODAY]: {
            plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
            blocks: [
              { id: 's1', title: 'Earlier', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
              { id: 's2', title: 'Deep work', entryId: null, start_minutes: 600, duration_minutes: 240 },
            ],
          },
        },
      });
      await b.ctx.load();
      b.setClock('11:00');
      return b;
    };

    {
      const { slots, chipOf } = await stale();
      check('the chip drawn before it started is still on screen',
        Boolean(chipOf(slots()[1])));
      check('still saying four hours', chipOf(slots()[1]).textContent === '4h',
        chipOf(slots()[1]).textContent);
    }

    {
      // The wrap is the sharp end: 4h goes to 30m, which would end a block
      // that began at 10:00 at 10:30 — half an hour ago — sliding it bodily
      // into the past.
      const { slots, rowOf, chipOf } = await stale();
      chipOf(slots()[1]).onclick();
      check('pressing it does not resize the block',
        slots()[1].text().includes('10:00 AM – 2:00 PM'), slots()[1].text().trim());
      check('it clears the chip instead', !chipOf(slots()[1]));
      check('and the block says it is active',
        Boolean(rowOf(slots()[1]).children.find((c) => c._class.has('running'))));
    }

    {
      const { slots, cardOf } = await stale();
      const card = cardOf(slots()[1]);
      down(card, 100, 100);
      await wait(HELD);
      check('holding the stale card does not pick it up', !card._class.has('lifted'));
      up(card, 100, 100);
    }

    {
      const { slots, cardOf } = await stale();
      const card = cardOf(slots()[1]);
      down(card, 100, 100);
      move(card, 190, 100);
      check('the note swipe does not travel', !card.style.transform,
        card.style.transform);
      up(card, 190, 100);
      check('so no editor opened',
        !cardOf(slots()[1]).children.some((c) => c._class.has('noteedit')));
    }

    {
      // Removal is the one thing still allowed, at any hour.
      const { byId, slots, cardOf, titles } = await stale();
      const card = cardOf(slots()[1]);
      down(card, 200, 100);
      move(card, 100, 100);
      up(card, 100, 100);
      await wait(CLOSED);
      check('but it can still be removed', titles().join() === 'Earlier', titles().join());
      check('with an undo', byId['undo-host'].children.length > 0);
    }
  }

  console.log('\nswiping left on a begun block removes it, like every other block');
  {
    // This used to mark it missed instead, because a delivered block could not
    // be removed. Both halves of that are gone: the server allows the removal,
    // and there is no miss to record.
    const inProgress = () => ({
      [TODAY]: {
        plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
        blocks: [
          { id: 'i1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
          { id: 'i2', title: 'Deep work', entryId: null, start_minutes: 540, duration_minutes: 60, sent: true },
          { id: 'i3', title: 'Errands', entryId: null, start_minutes: 600, duration_minutes: 60 },
        ],
      },
    });
    const { ctx, slots, cardOf, rowOf, backingOf, byId, titles, posted } = boot({
      plan: inProgress(), entries: utcEntries({ plans_in: 'morning' }), now: '09:30',
    });
    await ctx.load();

    const actIn = (s) => rowOf(s).children.find((c) => c._class.has('running'));
    check('it starts out saying active', Boolean(actIn(slots()[1])));

    const card = cardOf(slots()[1]);
    down(card, 200, 100);
    move(card, 150, 100);
    check('the label is Remove', backingOf(slots()[1]).textContent === 'Remove',
      backingOf(slots()[1]).textContent);
    check('on the one backing, carrying no tone', !backingOf(slots()[1])._class.has('hot'),
      [...backingOf(slots()[1])._class].join(' '));

    posted.length = 0;
    move(card, 100, 100);
    up(card, 100, 100);
      await wait(CLOSED);

    check('and the block goes', titles().join() === 'Reading,Errands', titles().join());
    check('with an undo offered', byId['undo-host'].children.length > 0);
    check('and nothing posted to a miss route',
      !posted.some((p) => /\/miss/.test(p.url)), JSON.stringify(posted.map((p) => p.url)));
  }

  console.log('\nswipe left still removes a block that has not begun');
  {
    const { ctx, slots, cardOf, backingOf, titles } = boot({
      entries: utcEntries({ plans_in: 'morning' }),
      now: '09:30',
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [
            { id: 'u1', title: 'Reading', entryId: null, start_minutes: 480, duration_minutes: 60, sent: true },
            { id: 'u2', title: 'Errands', entryId: null, start_minutes: 600, duration_minutes: 60 },
          ],
        },
      },
    });
    await ctx.load();

    const card = cardOf(slots()[1]);
    down(card, 200, 100);
    move(card, 150, 100);
    check('the label is Remove', backingOf(slots()[1]).textContent === 'Remove',
      backingOf(slots()[1]).textContent);
    move(card, 100, 100);
    up(card, 100, 100);
      await wait(CLOSED);
    check('and it goes', titles().join() === 'Reading', titles().join());
  }

  console.log('\nnothing anywhere still offers a miss');
  {
    const { ctx, slots, rowOf, posted } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '10:45',
    });
    await ctx.load();

    // Two past blocks and one still to come. None of the three may carry the
    // question, and nothing may have gone to the route that recorded it.
    const marks = slots().flatMap((s) =>
      rowOf(s).children.filter((c) => c._class.has('askmiss')));
    check('no block asks whether it happened', marks.length === 0, String(marks.length));
    check('and no text anywhere says so',
      !slots().some((s) => s.text().includes("didn't happen")));
    check('nothing was posted to /miss', !posted.some((p) => /\/miss/.test(p.url)),
      JSON.stringify(posted.map((p) => p.url)));
  }

  console.log('\nthe menu still works on a locked row');
  {
    const things = [
      { id: 'e-uf', type: 'task', title: 'UF application', days: 6, mark: null, due: null, size: null, last_scheduled: null },
    ];
    const { ctx, byId } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning', items: things }), now: '11:00',
    });
    await ctx.load();

    const row = byId.things.children.filter((c) => c._class.has('row'))[0];
    check('it is locked', row._class.has('locked'));

    const acts = row.children.find((c) => c._class.has('rowacts'));
    check('it still has a menu', Boolean(acts));
    check('with all three actions',
      acts.children.map((c) => c.textContent).join() === 'Done,Edit,Delete',
      acts.children.map((c) => c.textContent).join());

    const hint = row.children[0].children.find((c) => c._class.has('hint'));
    hint.onclick({ stopPropagation() {} });
    check('and the hint still opens it', !acts._class.has('hidden'));
  }

  console.log('\nDone and Delete offer an undo, and write nothing until it lapses');
  {
    // Built fresh per boot. The page holds the array the fetch stub handed it
    // and splices that array, so one shared fixture would be emptied by the
    // first case and every later one would start short. A real fetch parses
    // new JSON each time; the stub does not.
    const items = () => [
      { id: 'e-a', type: 'task', title: 'Alpha', days: 1, mark: null, due: null, size: null, last_scheduled: null },
      { id: 'e-b', type: 'task', title: 'Beta', days: 2, mark: null, due: null, size: null, last_scheduled: null },
      { id: 'e-c', type: 'habit', title: 'Gamma', days: 3, mark: null, due: null, size: null, last_scheduled: null },
    ];
    const fresh = () => boot({
      entries: utcEntries({ plans_in: 'morning', items: items() }), now: '11:00',
    });

    const rowsIn = (byId) => byId.things.children.filter((c) => c._class.has('row'));
    const namesIn = (byId) =>
      rowsIn(byId).map((r) => r.children[0].children[0].textContent).join();
    const menuOf = (row) => row.children.find((c) => c._class.has('rowacts'));
    const press = (row, word) => {
      const b = menuOf(row).children.find((c) => c.textContent === word);
      b.onclick({ stopPropagation() {} });
    };
    const undoBar = (byId) => byId['undo-host'].children[0];

    {
      // DELETE, undone. Nothing may have been written, because a delete cannot
      // be reversed: status='deleted' is a tombstone the server will not revive.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[1], 'Delete');
      check('the row goes at once', namesIn(byId) === 'Alpha,Gamma', namesIn(byId));
      check('and the bar says what happened',
        undoBar(byId).text().includes('Deleted'), undoBar(byId).text());
      check('but NOTHING was posted yet', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));

      undoBar(byId).children.find((c) => c.textContent === 'Undo').onclick();
      check('undo puts it back where it was', namesIn(byId) === 'Alpha,Beta,Gamma',
        namesIn(byId));
      check('and still nothing was posted', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));
      check('the bar is gone', byId['undo-host'].children.length === 0);
    }

    {
      // DELETE, left alone. The write happens when the offer lapses.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[1], 'Delete');
      await wait(UNDO_LAPSED);
      check('the write lands after the window', posted.length === 1,
        JSON.stringify(posted.map((p) => p.url)));
      check('on the delete route, for that row',
        posted[0] && posted[0].url === '/entries/e-b/delete', posted[0] && posted[0].url);
      check('and the row stays gone', namesIn(byId) === 'Alpha,Gamma', namesIn(byId));
      check('with the bar cleared', byId['undo-host'].children.length === 0);
    }

    {
      // DONE, the same machinery.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[0], 'Done');
      check('it says Done, not Deleted', undoBar(byId).text().includes('Done'),
        undoBar(byId).text());
      check('nothing posted yet', posted.length === 0);

      await wait(UNDO_LAPSED);
      check('then it posts to done', posted.length === 1 && posted[0].url === '/entries/e-a/done',
        JSON.stringify(posted.map((p) => p.url)));
    }

    {
      // A second action commits the first. Two deletes in a row must delete
      // both, and one bar cannot describe two rows.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[0], 'Delete');
      press(rowsIn(byId)[0], 'Delete');
      check('the first is written when the second arrives',
        posted.length === 1 && posted[0].url === '/entries/e-a/delete',
        JSON.stringify(posted.map((p) => p.url)));
      check('and both rows are off the list', namesIn(byId) === 'Gamma', namesIn(byId));

      await wait(UNDO_LAPSED);
      check('then the second is written too', posted.length === 2,
        JSON.stringify(posted.map((p) => p.url)));
      check('undoing now would be too late for either',
        byId['undo-host'].children.length === 0);
    }

    {
      // A closed tab inside the window still means it.
      const { ctx, byId, posted, win } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[0], 'Delete');
      check('nothing posted while the offer stands', posted.length === 0);

      win.fire('pagehide');
      check('leaving the page writes it', posted.length === 1,
        JSON.stringify(posted.map((p) => p.url)));
      check('and it keeps the request alive past the page',
        posted[0] && posted[0].keepalive === true, JSON.stringify(posted[0]));
    }

    {
      // Delete no longer asks first — the undo replaces the confirm.
      const { ctx, byId, confirmed } = fresh();
      await ctx.load();
      press(rowsIn(byId)[1], 'Delete');
      check('nothing was confirmed', confirmed.length === 0, JSON.stringify(confirmed));
    }
  }

  console.log(bad === 0 ? '\nBuilder clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
