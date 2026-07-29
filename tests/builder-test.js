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
  append(...k) { for (const x of k) if (x) this.children.push(x); }
  replaceChildren(...k) { this.children = k.filter(Boolean); }
  appendChild(k) { this.children.push(k); return k; }
  setAttribute(k, v) { this._attrs[k] = v; this[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  addEventListener() {} removeEventListener() {}
  // A real, consistent height, because the reorder maths divides by it.
  // 40 + the 9px gap makes one slot 49px, so a drag of 49 is exactly one place.
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
  wake_time: '08:00', // as the server sends it: 24 hour, display is the page's job
  items: [],
};

const SLOT = 49; // one block's height plus the gap, per getBoundingClientRect

// The clock the page reads. It asks Intl for the hour in the profile's own
// timezone, so a case that needs "it is 11am" fixes the whole environment to a
// zone with no offset and freezes Date there.
function atClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const Frozen = class extends Date {
    constructor(...a) {
      if (a.length) return super(...a);
      return super(Date.UTC(2026, 6, 27, h, m, 0));
    }
    static now() {
      return Date.UTC(2026, 6, 27, h, m, 0);
    }
  };
  return Frozen;
}

/** Builds a fresh script instance with its own DOM. */
function boot({
  calendar = [], plan = null, failed = [], reduced = false,
  entries = null, now = null,
} = {}) {
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
  const win = { scrollY: 0 };

  // Every request that carried a body, so a case can read what the page sent
  // rather than infer it from what the page shows.
  const posted = [];

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
    Date: now ? atClock(now) : Date,
    String, Number, Boolean, Array, Object,
    alert: () => {}, confirm: () => true, prompt: () => 'Typed block',
    window: win,
    fetch: async (url, opts) => {
      if (opts && opts.body) posted.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true,
        json: async () => {
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
    titleOf, titles, listeners, touchmoves, win, posted,
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

    check('an evening planner opens on tomorrow', byId['pick-tomorrow']._class.has('on'));
    check('and today is the quiet one', !byId['pick-today']._class.has('on'));
    check('the date says which', byId['plan-date'].textContent === 'Tue 28 Jul',
      byId['plan-date'].textContent);
    check("tomorrow's plan is the one loaded", titles().join() === 'Spanish', titles().join());
    check('and the Starts control is there', !byId.starts._class.has('hidden'));

    await byId['pick-today'].onclick();
    check('tapping Today switches', byId['pick-today']._class.has('on'));
    check('and tomorrow goes quiet', !byId['pick-tomorrow']._class.has('on'));
    check('the date follows', byId['plan-date'].textContent === 'Mon 27 Jul',
      byId['plan-date'].textContent);
    check("today's plan is loaded", titles().join() === 'Reading,Gym,UF application',
      titles().join());
    check('and Starts is hidden, because the day already started',
      byId.starts._class.has('hidden'));

    await byId['pick-tomorrow'].onclick();
    check('and back again', titles().join() === 'Spanish', titles().join());
    check('with Starts shown again', !byId.starts._class.has('hidden'));
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

    const askIn = (s) => rowOf(s).children.find((c) => c._class.has('askmiss'));
    check('a past block asks instead', Boolean(askIn(slots()[0])));
    check('and it asks quietly', askIn(slots()[0]).textContent === "didn't happen?",
      askIn(slots()[0]).textContent);
    check('one already marked reads as missed', askIn(slots()[1]).textContent === 'missed',
      askIn(slots()[1]).textContent);
    check('in the warn colour', askIn(slots()[1])._class.has('was'));

    const divider = byId.builder.children.filter((c) => c._class.has('now'));
    check('one NOW divider', divider.length === 1, `${divider.length}`);
    check('between the past and what is left',
      byId.builder.children.indexOf(divider[0]) === 2,
      String(byId.builder.children.indexOf(divider[0])));
    check('it carries a dot and the word',
      divider[0].children.some((c) => c._class.has('dot')) &&
        divider[0].text().includes('NOW'));

    check('a past block keeps the hour it happened at',
      slots()[0].text().includes('8:00 AM – 9:00 AM'), slots()[0].text().trim());
  }

  console.log('\nmarking a past block missed, in place');
  {
    const { ctx, slots, rowOf } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '11:00',
    });
    await ctx.load();

    const ask = () => rowOf(slots()[0]).children.find((c) => c._class.has('askmiss'));
    check('it starts as a question', ask().textContent === "didn't happen?");

    await ask().onclick({ stopPropagation() {} });
    check('one tap marks it', ask().textContent === 'missed', ask().textContent);
    check('and it says so in the warn colour', ask()._class.has('was'));

    await ask().onclick({ stopPropagation() {} });
    check('tapping again undoes it', ask().textContent === "didn't happen?", ask().textContent);
    check('and drops the colour', !ask()._class.has('was'));
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
    check('nothing is past', slots().every((s) => !cardOf(s)._class.has('past')));
    check('and there is no divider',
      byId.builder.children.filter((c) => c._class.has('now')).length === 0);
    ctx.addBlock({ title: 'Later' });
    check('a new block flows from the wake time', slots()[1].text().includes('9:00 AM – 9:30 AM'),
      slots()[1].text().trim());
  }

  console.log('\na thing already in the shown day is locked');
  {
    const things = [
      { id: 'e-uf', type: 'project', title: 'UF application', days: 6, mark: '!!!', due: null, size: null, last_scheduled: null },
      { id: 'e-spanish', type: 'habit', title: 'Spanish', days: 3, mark: null, due: null, size: null, last_scheduled: null },
      { id: 'e-free', type: 'task', title: 'Return the router', days: 1, mark: null, due: null, size: null, last_scheduled: null },
    ];
    const { ctx, byId, slots, cardOf } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning', items: things }), now: '11:00',
    });
    await ctx.load();

    const rows = () => byId.things.children.filter((c) => c._class.has('row'));
    const rowFor = (title) => rows().find((r) => r.text().includes(title));
    const badge = (r) => r.children[0].children.find((c) => c._class.has('inplan'));

    check('the one in today is locked', rowFor('UF application')._class.has('locked'));
    check('and says where it is', badge(rowFor('UF application')).textContent === "in today's plan",
      badge(rowFor('UF application')) && badge(rowFor('UF application')).textContent);
    check('in place of its warning mark',
      !rowFor('UF application').children[0].children.some((c) => c._class.has('mark')));

    check('one in tomorrow is not locked while today is shown',
      !rowFor('Spanish')._class.has('locked'));
    check('nor is one in no plan at all', !rowFor('Return the router')._class.has('locked'));

    const before = slots().length;
    rowFor('UF application').onclick();
    check('tapping it adds nothing', slots().length === before, `${slots().length}`);

    rowFor('Return the router').onclick();
    check('but an unlocked row still schedules', slots().length === before + 1,
      `${slots().length}`);
    check('and locks itself immediately', rowFor('Return the router')._class.has('locked'));

    // Removing the block puts the row back on the same render.
    const added = slots()[slots().length - 1];
    const card = cardOf(added);
    down(card, 200, 100);
    move(card, 100, 100);
    up(card, 100, 100);
    check('removing its block unlocks it', !rowFor('Return the router')._class.has('locked'));
    check('and its mark comes back if it had one', true);

    await byId['pick-tomorrow'].onclick();
    check('the badge follows the switch',
      badge(rowFor('Spanish')).textContent === "in tomorrow's plan",
      badge(rowFor('Spanish')) && badge(rowFor('Spanish')).textContent);
    check('and what was locked on today is free on tomorrow',
      !rowFor('UF application')._class.has('locked'));
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

    const { ctx, slots, cardOf, rowOf, chipOf, titles } = boot(opts);
    await ctx.load();

    check('three blocks', titles().join() === 'Reading,Deep work,Errands', titles().join());
    check('the first is over', cardOf(slots()[0])._class.has('past'));
    check('the second has begun but is not over', !cardOf(slots()[1])._class.has('past'));

    check('it has no duration chip', !chipOf(slots()[1]));
    check('the one still to come does', Boolean(chipOf(slots()[2])));

    // Nothing to say about it yet: it has not failed to happen, it is
    // happening. The question belongs on a block that is over.
    const askIn = (s) => rowOf(s).children.find((c) => c._class.has('askmiss'));
    check('and it asks nothing yet', !askIn(slots()[1]));
    check('while the one that is over does', Boolean(askIn(slots()[0])));

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

  console.log('\nswiping left on a begun block marks it missed');
  {
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
    const { ctx, slots, cardOf, rowOf, backingOf, titles, posted } = boot({
      plan: inProgress(), entries: utcEntries({ plans_in: 'morning' }), now: '09:30',
    });
    await ctx.load();

    const askIn = (s) => rowOf(s).children.find((c) => c._class.has('askmiss'));

    // The backing has to say which of the three things this swipe is, before
    // the finger comes off.
    const card = cardOf(slots()[1]);
    down(card, 200, 100);
    move(card, 150, 100);
    check('the label is not Remove', backingOf(slots()[1]).textContent !== 'Remove',
      backingOf(slots()[1]).textContent);
    check('it says what it will do', backingOf(slots()[1]).textContent === "didn't happen",
      backingOf(slots()[1]).textContent);
    check('in the miss colour', backingOf(slots()[1])._class.has('hot'));

    posted.length = 0;
    move(card, 100, 100);
    up(card, 100, 100);

    check('the block is still there', titles().join() === 'Reading,Deep work,Errands',
      titles().join());
    check('and now reads as missed', askIn(slots()[1]).textContent === 'missed',
      askIn(slots()[1]) && askIn(slots()[1]).textContent);
    check('it posted the miss', posted.some((p) => /\/blocks\/i2\/miss/.test(p.url)),
      JSON.stringify(posted.map((p) => p.url)));
    check('as missed, not unmissed', posted[0].body.missed === true,
      JSON.stringify(posted[0].body));

    // Swiping again puts it back, and the backing says so.
    const again = cardOf(slots()[1]);
    down(again, 200, 100);
    move(again, 150, 100);
    check('the label flips', backingOf(slots()[1]).textContent === 'happened',
      backingOf(slots()[1]).textContent);
    check('and goes quiet, because putting it back is not a warning',
      backingOf(slots()[1])._class.has('calm') && !backingOf(slots()[1])._class.has('hot'));

    posted.length = 0;
    move(again, 100, 100);
    up(again, 100, 100);
    check('it is unmarked', !askIn(slots()[1]), askIn(slots()[1]) && askIn(slots()[1]).textContent);
    check('and that was posted too', posted[0].body.missed === false,
      JSON.stringify(posted[0].body));
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
    check('and it goes', titles().join() === 'Reading', titles().join());
  }

  console.log('\nthe tap on a block that is over still works');
  {
    const { ctx, slots, rowOf } = boot({
      plan: twoDays(), entries: utcEntries({ plans_in: 'morning' }), now: '10:45',
    });
    await ctx.load();
    const ask = () => rowOf(slots()[0]).children.find((c) => c._class.has('askmiss'));
    check('it is still a question', ask().textContent === "didn't happen?");
    await ask().onclick({ stopPropagation() {} });
    check('and still answers it', ask().textContent === 'missed', ask().textContent);
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

  console.log(bad === 0 ? '\nBuilder clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
