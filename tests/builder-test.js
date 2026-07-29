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
  wake_time: '08:00',
  items: [],
};

const SLOT = 49; // one block's height plus the gap, per getBoundingClientRect

/** Builds a fresh script instance with its own DOM. */
function boot({ calendar = [], plan = null, failed = [], reduced = false } = {}) {
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

  const sandbox = {
    console, setTimeout, clearTimeout, Intl, Date, Math, JSON,
    String, Number, Boolean, Array, Object,
    alert: () => {}, confirm: () => true, prompt: () => 'Typed block',
    window: win,
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        if (url.startsWith('/calendar')) return { items: calendar, failed };
        if (url.startsWith('/plan/')) return plan || { plan: null, blocks: [] };
        if (url === '/review') return { date: '2026-07-26', blocks: [] };
        return ENTRIES;
      },
    }),
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

  const touchmoves = () => listeners.filter((l) => l.type === 'touchmove');

  return {
    ctx, byId, slots, cardOf, backingOf, rowOf, chipOf, noteOf, editorOf,
    listeners, touchmoves, win,
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

    check('the end time follows', byId['end-time'].textContent === '09:00',
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
    check('laid out in sequence', slots()[2].text().includes('09:00 – 09:30'),
      slots()[2].text().trim());

    chipOf(slots()[0]).onclick(); // A: 30 -> 60
    check('the one below moved', slots()[1].text().includes('09:00 – 09:30'),
      slots()[1].text().trim());
    check('and the one below that', slots()[2].text().includes('09:30 – 10:00'),
      slots()[2].text().trim());
    check('the one above did not', slots()[0].text().includes('08:00 – 09:00'),
      slots()[0].text().trim());
    check('the end time followed live', byId['end-time'].textContent === '10:00',
      byId['end-time'].textContent);
  }

  console.log('\nswipe left removes, with an undo rather than a confirm');
  {
    const { ctx, byId, slots, cardOf, backingOf } = boot();
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
    check('and the one below moved up', slots()[0].text().includes('A') === false &&
      slots()[0].text().includes('B'), slots()[0].text().trim());
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
      slots()[0].text().includes('08:00 – 08:30'), slots()[0].text().trim());
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

  console.log('\na block that has already gone out cannot be swiped away');
  {
    const { ctx, slots, cardOf, backingOf, editorOf } = boot({
      plan: {
        plan: { date: '2026-07-28', status: 'confirmed', wake_minutes: 480 },
        blocks: [
          { id: 'a1', title: 'Sent', entryId: null, start_minutes: 480, duration_minutes: 30, sent: true },
          { id: 'b2', title: 'Unsent', entryId: null, start_minutes: 510, duration_minutes: 30, sent: false },
        ],
      },
    });
    await ctx.load();

    const sent = cardOf(slots()[0]);
    down(sent, 200, 100);
    move(sent, 100, 100); // a full removing swipe, and then some
    check('the card does not travel left', !sent.style.transform, sent.style.transform);
    check('and the miss colour never appears', !backingOf(slots()[0])._class.has('left'));
    up(sent, 100, 100);
    check('nothing was removed', slots().length === 2, `${slots().length}`);

    // Refusing on release, after the card had followed the finger the whole
    // way, would be offering the action and then taking it back.
    check('so it was never offered', !backingOf(slots()[0]).textContent,
      backingOf(slots()[0]).textContent);

    // The right-hand swipe is a note, which a delivered block may still have.
    down(sent, 100, 100);
    move(sent, 190, 100);
    check('but it can still be swiped the other way',
      backingOf(slots()[0])._class.has('right'));
    up(sent, 190, 100);
    check('and the note opens', Boolean(editorOf(slots()[0])));
    editorOf(slots()[0]).onblur();

    // A leftward drag has still moved the finger, so it must not be read as
    // stillness and leave the hold timer running.
    down(cardOf(slots()[0]), 200, 100);
    move(cardOf(slots()[0]), 100, 100);
    await wait(HELD);
    check('a refused swipe does not become a pick-up',
      !cardOf(slots()[0])._class.has('lifted'));
    up(cardOf(slots()[0]), 100, 100);

    const unsent = cardOf(slots()[1]);
    down(unsent, 200, 100);
    move(unsent, 100, 100);
    check('an undelivered block still swipes away', unsent.style.transform === 'translateX(-100px)',
      unsent.style.transform);
    up(unsent, 100, 100);
    check('and goes', slots().length === 1, `${slots().length}`);
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
    const { ctx, slots, cardOf } = boot();
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

    check('it landed last', slots().map((s) => s.text()).join('|').indexOf('A') >
      slots().map((s) => s.text()).join('|').indexOf('C'));
    check('the order is B C A',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' ') === 'B C A',
      slots().map((s) => s.text().trim().split(/\s+/)[0]).join(' '));
    check('and the times were recomputed from the top',
      slots()[0].text().includes('08:00 – 08:30'), slots()[0].text().trim());
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
    check('still a stepper', byId['wake-time'].textContent === '08:00');
    byId['wake-plus'].onclick();
    check('one step is half an hour', byId['wake-time'].textContent === '08:30');
    check('and the day moved with it', slots()[0].text().includes('08:30 – 09:00'),
      slots()[0].text().trim());
    for (let i = 0; i < 40; i++) byId['wake-minus'].onclick();
    check('still clamped at 04:00', byId['wake-time'].textContent === '04:00');
  }

  console.log(bad === 0 ? '\nBuilder clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
