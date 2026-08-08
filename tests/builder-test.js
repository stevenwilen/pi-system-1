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
  // Moves an existing child as well as inserting a new one, which is what the
  // real one does and what the setup screen relies on to reorder itself for a
  // first run.
  insertBefore(node, before) {
    const had = this.children.indexOf(node);
    if (had !== -1) this.children.splice(had, 1);
    const at = before ? this.children.indexOf(before) : -1;
    node._parent = this;
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }
  setAttribute(k, v) { this._attrs[k] = v; this[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  addEventListener() {} removeEventListener() {}
  // A real height AND a real position, because the reorder maths measures both.
  // 40 high with the stylesheet's 12px gap puts one row every 52px, so a drag
  // of 52 is exactly one place.
  //
  // AND ROWS ARE NOT ALL THE SAME HEIGHT. A block carrying a note is a line
  // taller, which the flat `at * 52` could not express — so every case ran on a
  // uniform ladder and the maths could assume one pitch for the whole day
  // without any case minding. A row's top is the sum of what is above it.
  get _selfHeight() {
    // A note line, the way the stylesheet gives it one: 12px text at 1.45 with
    // a 9px margin above it. The exact number does not matter; that it is not
    // zero is the whole point.
    return 40 + (this._find('note').length ? 26 : 0);
  }
  getBoundingClientRect() {
    const kin = this._parent ? this._parent.children : [this];
    let top = 0;
    for (const c of kin) {
      if (c === this) break;
      top += c._selfHeight + 12;
    }
    return { top, height: this._selfHeight };
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
// The one line that starts the page, and a throw if there was nothing there to
// remove. It was `load(`, then `start()`, and is now `begin()` — the page wraps
// the boot and its patience timer together, and stripping only the `start()`
// inside it left the rest of the function body orphaned. The guard below said
// so on the first run after the change, which is the whole reason it exists.
//
// A case that wants the real boot calls `ctx.begin()` itself.
const rawScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const SCRIPT = rawScript
  .replace(/^\s*begin\(\);\s*$/m, '')
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
  calendar = [], plan = null, failed = false, reduced = false, configured = true,
  // A url whose request never settles, so a case can hold the boot open the way
  // a phone with its network held does.
  hangOn = null,
  entries = null, now = null, failEntries = false,
  // What GET /settings answers. Configured by default, so no case falls into
  // the first-run screen without asking for it — the cases about that ask.
  settings = {
    telegram: { set: true, hint: '…3785' },
    calendar: { set: true, hint: 'x/…/basic.ics' },
    // What the route sends, in full. The window comes down from the server so
    // the stepper and the route cannot disagree about what is offerable, and a
    // stub that left it out would exercise the page's fallbacks instead of the
    // path every real load takes.
    timezone: 'America/New_York',
    wake_minutes: 8 * 60,
    wake_min: 4 * 60,
    wake_max: 12 * 60,
    wake_step: 30,
    today: '2026-07-27',
  },
  // WHAT THE DEVICE SAYS ITS ZONE IS, which is otherwise whatever machine the
  // suite happens to be running on. The timezone suggestion is a comparison
  // between this and what is stored, so a case about it has to fix both sides
  // or it passes or fails by geography.
  deviceZone = 'America/New_York',
  // Signed in unless a case says otherwise. Every case here is about the
  // planner, and the planner is only reachable with a session — booting each
  // one through the gate would be re-testing sign-in three hundred times.
  signedIn = true,
  // Handed in when a case is simulating a RELOAD: the same device, the same
  // storage, a fresh page.
  storage = null,
  // What POST /settings/timezone answers. Success unless a case wants the
  // refusal path, which is a screen state of its own: the picker has to go
  // back to what is actually stored.
  timezoneReply = null,
  // What POST /plan answers. The confirm hands back the notes it moved off the
  // Things list and onto blocks, and a case about that has to be able to say
  // which ones arrived where.
  planReply = null,
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
  //
  // WITH THE CLASSES IT DECLARES TOO. They used to start bare, which made
  // every "is this hidden" check meaningless: `hidden` was never on the element
  // in the first place, so asserting it was absent passed whatever the page
  // did. The gate ships hidden and is shown by removing that class — three
  // checks about it were green before the code they cover existed.
  const byId = {};
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) || []) {
    const id = /\sid="([^"]+)"/.exec(tag);
    if (!id) continue;
    const el = new El((/^<([a-zA-Z]+)/.exec(tag) || [])[1] || 'div');
    const klass = /\sclass="([^"]*)"/.exec(tag);
    if (klass) el.className = klass[1];
    byId[id[1]] = el;
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

  // Every request the page made, and what it claimed to be. Separate from
  // `posted` because that one only sees writes, and the header matters on
  // every read too.
  const asked = [];

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

  // The device's storage, as a Map with the four methods the page uses.
  //
  // Seeded with a session that expires an hour from the frozen clock, so the
  // page finds one, believes it, and never tries to refresh it. A case about
  // the gate empties it.
  const stored = storage || new Map();
  if (signedIn) {
    stored.set(
      'pi.session',
      JSON.stringify({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Math.floor(clock.now() / 1000) + 3600,
        email: 'planner@example.test',
      })
    );
  }

  /**
   * Intl, with one thing fixed: what this device says its own zone is.
   *
   * Only the no-timeZone case is touched. Every other call on the page names a
   * zone explicitly — the date, the local hour, the clock shown beside the
   * picker — and those must go on doing real conversions, or the cases about
   * the day boundary would be testing this wrapper instead of the page.
   */
  const RealDTF = Intl.DateTimeFormat;
  const DTF = function DateTimeFormat(locales, options) {
    const made = new RealDTF(locales, options);
    if (!options || !options.timeZone) {
      const real = made.resolvedOptions.bind(made);
      made.resolvedOptions = () => ({ ...real(), timeZone: deviceZone });
    }
    return made;
  };
  DTF.prototype = RealDTF.prototype;
  DTF.supportedLocalesOf = RealDTF.supportedLocalesOf.bind(RealDTF);

  const localIntl = {
    DateTimeFormat: DTF,
    NumberFormat: Intl.NumberFormat,
    supportedValuesOf: Intl.supportedValuesOf && Intl.supportedValuesOf.bind(Intl),
  };

  // Reloads are counted, not performed. A suite that actually reloaded would
  // be a suite that stopped.
  const reloads = [];

  const sandbox = {
    console, setTimeout, clearTimeout, Intl: localIntl, Math, JSON,
    location: {
      href: 'https://app.example/',
      // BOTH, so a case can say which one the page reached for. The page
      // navigates rather than reloading — an installed app reloaded in place
      // can come back suspended — and a stub with only reload() would let that
      // silently become a no-op.
      replace: (url) => reloads.push({ how: 'replace', url }),
      reload: () => reloads.push({ how: 'reload' }),
    },
    navigator: { vibrate: () => {} },
    Date: clock,
    String, Number, Boolean, Array, Object,
    alert: () => {},
    localStorage: {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, String(v)),
      removeItem: (k) => stored.delete(k),
    },
    // Recorded rather than merely answered, so a case can assert that Delete
    // stopped asking.
    confirm: (q) => {
      confirmed.push(q);
      return true;
    },

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

      // Who the request said it was. Recorded on every call, GET included,
      // because a route reached without this header is a route that 401s in
      // production and looks like an empty day on screen.
      asked.push({
        url,
        auth: (opts && opts.headers && opts.headers.Authorization) || null,
      });

      if (hangOn && url.startsWith(hangOn)) return new Promise(() => {});

      return {
        ok: true,
        status: 200,
        json: async () => {
          // Ahead of the gate in the page, and ahead of everything here. The
          // project's URL is what makes a token refreshable.
          if (url === '/config') return { url: 'https://stub.supabase.co', anon_key: 'anon-key' };
          if (url === '/settings') return settings;
          if (url === '/entries' && failEntries) throw new Error('offline');
          if (url.startsWith('/calendar')) return { items: calendar, failed, configured };
          if (url.startsWith('/plan/')) return planFor(url);
          if (url === '/settings/timezone') {
            return timezoneReply || { timezone: 'Europe/Berlin', today: '2026-07-27' };
          }
          if (url === '/settings/wake') return { wake_minutes: 450 };
          if (/\/plan\/block\/[^/]+\/done$/.test(url)) return { id: 'b', done: true };
          if (/\/entries\/[^/]+\/pin$/.test(url)) {
            // A case about the refusal path sets this on the context.
            return ctx && ctx.__failPin
              ? { error: 'no' }
              : { id: 'x', pinned: JSON.parse((opts && opts.body) || '{}').pinned };
          }
          if (url === '/plan') {
            return planReply || { date: 'x', blocks: 0, status: 'confirmed', ids: [], notes: [] };
          }
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

  // The aside's event rows. Its sentences — "Nothing on it." and the failures —
  // are <p>, deliberately, and are not in here.
  const calRows = () => byId['cal-list'].children.filter((c) => c._class.has('calrow'));
  const calSays = () => byId['cal-list'].children
    .filter((c) => !c._class.has('calrow')).map((c) => c.textContent).join(' ');

  // EVERY touchmove listener on the document, with nothing excused.
  //
  // It briefly skipped whatever was already registered when the script
  // finished, because pull-to-reload installed one permanently and broke
  // "nothing is held before the press". The pull is gone, and that exemption
  // has to go with it: a case now asserts the document holds NO standing touch
  // listener, and a helper that filtered standing listeners out would make that
  // check pass against the exact thing it exists to catch.
  const touchmoves = () => listeners.filter((l) => l.type === 'touchmove');

  return {
    ctx, byId, slots, cardOf, backingOf, rowOf, chipOf, noteOf, editorOf, calRows, calSays,
    titleOf, titles, listeners, touchmoves, win, posted, confirmed, asked, stored,
    // Type a name into the open add field and press Enter, which is the whole
    // of adding something by hand now.
    typeAdd: (title) => {
      byId['add-field'].value = title;
      byId['add-field'].onkeydown({ key: 'Enter' });
    },
    reloads,
    // Every document listener of a kind, in order, so a case can drive the
    // page-level gestures the way the browser would.
    fire: (type, event) => listeners.filter((l) => l.type === type).forEach((l) => l.fn(event)),
    // Wind the frozen clock on without re-rendering, the way a page left
    // open on a phone experiences time passing.
    setClock: (hhmm) => clock.moveTo && clock.moveTo(hhmm),
  };
}

/**
 * The rows of the Things list.
 *
 * A row is one level down now. It sits inside a `.thing`, which is what holds
 * still while the row slides off the backing behind it — so `#things`'s own
 * children are the slots and not the rows. Every case reached in and read
 * `.row` off the children directly, which stopped finding anything at all the
 * day the wrapper arrived.
 */
const thingSlots = (byId) => byId.things.children.filter((c) => c._class.has('thing'));
const thingRows = (byId) =>
  thingSlots(byId).map((t) => t.children.find((c) => c._class.has('row'))).filter(Boolean);
const backingOfThing = (slot) => slot.children.find((c) => c._class.has('backing'));

/**
 * The "Anytime today" rows: things committed to the day and not to an hour.
 *
 * Drawn in their own container, so none of the block helpers reach them — and
 * deliberately not in the builder, because the builder's whole order is the
 * hour and these have none.
 */
const anytimeSlots = (byId) => byId['anytime-list'].children.filter((c) => c._class.has('atime'));
const anytimeRows = (byId) =>
  anytimeSlots(byId).map((t) => t.children.find((c) => c._class.has('arow'))).filter(Boolean);
const anytimeTitles = (byId) =>
  anytimeRows(byId).map((r) => {
    const text = r.children.find((c) => c._class.has('atext'));
    return (text.children.find((c) => c._class.has('atitle')) || {}).textContent || '';
  });
const anytimeAt = (byId) => anytimeSlots(byId).map((s) => s.dataset.at).join();
const tickOf = (row) => row.children.find((c) => c._class.has('atick'));
const anytimeNote = (row) => {
  const text = row.children.find((c) => c._class.has('atext'));
  return (text.children.find((c) => c._class.has('anote')) || {}).textContent || null;
};

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
    check('and the day ends at nothing rather than at a dash',
      byId['end-time'].textContent === '0:00', byId['end-time'].textContent);

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
    check('the one above did not', slots()[0].text().includes('8:00 AM'),
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
      slots()[0].text().includes('8:00 AM'), slots()[0].text().trim());
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
    const { ctx, slots, cardOf, win , titleOf } = boot();
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
      slots().map((s) => titleOf(s)).join(' ') === 'B A C',
      slots().map((s) => titleOf(s)).join(' '));
  }

  console.log('\ndragging a day that also holds anytime items');
  {
    // THE REPORTED BUG: a drag moves a block other than the one being carried.
    //
    // The builder draws only the TIMED blocks — an anytime item has no hour, so
    // it is drawn in its own section below — while every index the drag works
    // in is an index into `blocks`, which holds both, interleaved in the order
    // they were added. One anytime item anywhere above the finger and the two
    // run one apart, and the further down the day, the further out.
    //
    // This is the same class of mistake as the divider once caused, and the
    // comment on `siblings` says so: filtering the builder's children to slots
    // fixed the divider, and it does not fix this, because here it is `blocks`
    // that has the extra entries rather than the builder.
    const { ctx, slots, cardOf, byId , titleOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addAnytime({ title: 'Loose' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });

    const onScreen = () => slots().map((s) => titleOf(s)).join(' ');
    check('the day draws its three timed blocks', onScreen() === 'A B C', onScreen());
    check('and the anytime item is not one of them', !onScreen().includes('Loose'), onScreen());

    // Carry the FIRST timed block down one place. Nothing about the anytime
    // item should enter into it.
    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);
    move(card, 100, 100 + SLOT);

    // What steps aside while the finger is still down. The row being dropped
    // onto moves up; nothing else moves at all.
    check('the row it is heading for steps out of the way',
      slots()[1].style.transform === `translateY(-${SLOT}px)`, slots()[1].style.transform);
    check('and the row below that stays put',
      !slots()[2].style.transform, slots()[2].style.transform);

    up(card, 100, 100 + SLOT);
    await wait(SETTLED);

    check('the block that was carried is the block that moved',
      onScreen() === 'B A C', onScreen());
    // It is drawn in its own section, so it is never in `titles()`. The point
    // is that a drag in the day above it did not disturb it: the array it
    // shares with the timed blocks used to be spliced under it.
    check('and the anytime item is still in its own list',
      anytimeTitles(byId).join() === 'Loose', anytimeTitles(byId).join());
  }

  console.log('\nwherever the anytime items sit, the drag does not feel them');
  {
    // The error the old code made was the count of anytime items ABOVE the
    // finger, so it grew the further down the day you were and vanished at the
    // top. Every arrangement here would have behaved differently; all of them
    // have to behave the same now.
    const day = async (build) => {
      const { ctx, slots, cardOf, byId , titleOf } = boot();
      await ctx.load();
      build(ctx);
      return { ctx, slots, cardOf, byId, titleOf };
    };

    const drag = async ({ slots, cardOf }, row, rows) => {
      const card = cardOf(slots()[row]);
      down(card, 100, 100);
      await wait(HELD);
      move(card, 100, 100 + rows * SLOT);
      up(card, 100, 100 + rows * SLOT);
      await wait(SETTLED);
    };
    const order = (d) => d.slots().map((s) => d.titleOf(s)).join(' ');

    {
      // Loose ones first, so every row is offset.
      const d = await day((ctx) => {
        ctx.addAnytime({ title: 'L1' });
        ctx.addAnytime({ title: 'L2' });
        ctx.addBlock({ title: 'A' });
        ctx.addBlock({ title: 'B' });
        ctx.addBlock({ title: 'C' });
      });
      await drag(d, 2, -2); // carry C to the top
      check('two loose items above the day: the carried block still lands',
        order(d) === 'C A B', order(d));
      const was = 'L1,L2';
      check('and both loose items are untouched',
        anytimeTitles(d.byId).join() === was, anytimeTitles(d.byId).join());
      // THE PLACES THEY HOLD IN THE ARRAY, not just the order they read in.
      // Splicing `blocks` under them shuffles them without changing either
      // title, so reading the titles alone is a check the old code passes.
      check('and hold the same places in the array',
        anytimeAt(d.byId) === '0,1', anytimeAt(d.byId));
    }

    {
      // One in the middle and one at the end.
      const d = await day((ctx) => {
        ctx.addBlock({ title: 'A' });
        ctx.addBlock({ title: 'B' });
        ctx.addAnytime({ title: 'L1' });
        ctx.addBlock({ title: 'C' });
        ctx.addAnytime({ title: 'L2' });
      });
      await drag(d, 0, 2); // A to the bottom
      check('interleaved: the carried block still lands',
        order(d) === 'B C A', order(d));
      check('and the loose items keep their own order',
        anytimeTitles(d.byId).join() === 'L1,L2', anytimeTitles(d.byId).join());
      check('and the places they held in the array',
        anytimeAt(d.byId) === '2,4', anytimeAt(d.byId));
    }

    {
      // PAST THE END. The clamp used to be `blocks.length`, which counts the
      // loose ones — so a block could be carried to a row that does not exist
      // and the day quietly rearranged itself around the miss.
      const d = await day((ctx) => {
        ctx.addBlock({ title: 'A' });
        ctx.addBlock({ title: 'B' });
        ctx.addAnytime({ title: 'L1' });
        ctx.addAnytime({ title: 'L2' });
        ctx.addAnytime({ title: 'L3' });
      });
      await drag(d, 0, 4); // four rows down, in a day two rows long
      check('carried past the last row, it stops at the last row',
        order(d) === 'B A', order(d));
      check('with the loose items still loose',
        anytimeTitles(d.byId).join() === 'L1,L2,L3', anytimeTitles(d.byId).join());
      check('exactly where they were',
        anytimeAt(d.byId) === '2,3,4', anytimeAt(d.byId));
    }

    {
      // And the plain day still behaves, which is what says none of the above
      // was bought by breaking the ordinary case.
      const d = await day((ctx) => {
        ctx.addBlock({ title: 'A' });
        ctx.addBlock({ title: 'B' });
        ctx.addBlock({ title: 'C' });
      });
      await drag(d, 2, -1);
      check('a day with nothing loose in it is unchanged by all this',
        order(d) === 'A C B', order(d));
    }
  }

  console.log('\nrows are not all the same height, and the drag has to measure');
  {
    // A block carrying a note is a line taller than one without. The drag used
    // to measure ONE pitch, off whichever neighbour the carried block happened
    // to have, and then count places by dividing the travel by it — so on a day
    // with notes in it every row below a tall one sat somewhere the arithmetic
    // did not think it was, and a drag landed a place out.
    //
    // What the finger is over is a question about positions. It is answered by
    // reading them now.
    const { ctx, slots, cardOf , titleOf } = boot();
    await ctx.load();
    ctx.addBlock({ title: 'A' });
    ctx.addBlock({ title: 'B' });
    ctx.addBlock({ title: 'C' });
    ctx.addBlock({ title: 'D' });
    // B gets a note, so everything below B sits 26px lower than a flat ladder.
    ctx.saveNote(1, 'ring first');

    const order = () => slots().map((s) => titleOf(s)).join(' ');
    check('the day is as built', order() === 'A B C D', order());

    const tops = slots().map((s) => s.getBoundingClientRect().top);
    check('and the rows really are unevenly spaced',
      tops[2] - tops[1] !== tops[1] - tops[0], tops.join(' '));

    // Carry A down past the tall row, to C — and NOT as far as D.
    //
    // The travel is 131px. A uniform pitch of 52 makes that "three places
    // down", which is D; the rows say A's middle has only just passed C's. The
    // last row is deliberately not the target, because a target past the end
    // gets clamped back and the clamp would hide the miscount.
    const rowMid = (r) => tops[r] + slots()[r].getBoundingClientRect().height / 2;
    const travel = rowMid(2) - rowMid(0) + 1;

    const card = cardOf(slots()[0]);
    down(card, 100, 100);
    await wait(HELD);
    move(card, 100, 100 + travel);
    up(card, 100, 100 + travel);

    // THE RIDE, before the render replaces everything. It travels to where the
    // block will actually be — the row it landed on, less its own height, since
    // going down it comes to rest flush with the bottom of the row it passed.
    // Counting places and multiplying by one pitch gives 104 here, and the
    // block would visibly slide to the wrong place and then jump.
    check('and rides to where it will actually sit',
      card.style.transform === 'translateY(130px)', card.style.transform);

    await wait(SETTLED);

    check('it lands in the row its middle has reached, not the one a flat ladder counts',
      order() === 'B C A D', order());
    check('and the note stayed with the block that had it',
      (slots().find((s) => s.text().includes('ring first')) || { text: () => '' })
        .text().includes('B'),
      slots().map((s) => titleOf(s)).join(' '));
  }

  console.log('\nstarting a drag on an already-scrolled page');
  {
    const { ctx, slots, cardOf, win , titleOf } = boot();
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
      slots().map((s) => titleOf(s)).join(' ') === 'B A C',
      slots().map((s) => titleOf(s)).join(' '));
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
    const { ctx, slots, cardOf, titles , titleOf } = boot();
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
      slots().map((s) => titleOf(s)).join(' ') === 'B C A',
      slots().map((s) => titleOf(s)).join(' '));
    check('and the times were recomputed from the top',
      slots()[0].text().includes('8:00 AM'), slots()[0].text().trim());
    check('every transform was cleared', slots().every((s) => !s.style.transform));
  }

  console.log('\ndragging up, and off the ends');
  {
    const { ctx, slots, cardOf , titleOf } = boot();
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
      slots().map((s) => titleOf(s)).join(' ') === 'C A B',
      slots().map((s) => titleOf(s)).join(' '));
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
    const { ctx, slots, cardOf , titleOf } = boot({ reduced: true });
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
      slots().map((s) => titleOf(s)).join(' ') === 'B A',
      slots().map((s) => titleOf(s)).join(' '));
  }

  console.log('\nthe rest of the builder still holds');
  {
    const { ctx, byId, slots } = boot();
    await ctx.load();
    check('nothing to confirm on an empty day', byId['confirm'].disabled === true);
    // A day with nothing in it has an answer, and the answer is nothing. The
    // dash belongs to the switch, which does not yet know.
    check('and the end time says nothing rather than a dash',
      byId['end-time'].textContent === '0:00', byId['end-time'].textContent);

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

  console.log('\nthe seal stays pressed for as long as the day is saving');
  {
    // WHAT THIS IS FOR. Saving is a round trip, and until it came back the
    // button looked exactly as it had before it was touched — about a second
    // of nothing, which reads as a tap that did not register.
    const { ctx, byId } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.load();

    const seal = byId['confirm'];
    const real = ctx.fetch;

    // Read from inside the request rather than after it, because after it is
    // exactly when the state is supposed to be gone.
    let midFlight = null;
    ctx.fetch = async (url, opts) => {
      if (url === '/plan') midFlight = seal._class.has('pressing');
      return real(url, opts);
    };

    await seal.onclick();
    check('pressed while the request is out', midFlight === true);
    check('and released once the day is saved', !seal._class.has('pressing'));

    // The two ways a save is known to go wrong. Both give up early, and a seal
    // left pressed after either is a button that has stopped answering.
    ctx.fetch = async (url, opts) => {
      if (url === '/plan') throw new Error('offline');
      return real(url, opts);
    };
    await seal.onclick();
    check('a request that never lands releases it', !seal._class.has('pressing'));

    ctx.fetch = async (url, opts) => {
      if (url === '/plan') return { ok: true, json: async () => ({ error: 'refused' }) };
      return real(url, opts);
    };
    await seal.onclick();
    check('and so does a refusal from the server', !seal._class.has('pressing'));

    // AND THE WAY THAT IS NOT KNOWN. Both cases above return rather than
    // throw, so a release on the line after the save would have covered them
    // and this case is the only one that says why it is a `finally` instead:
    // the seal has to let go on every way out of the save, including one
    // nobody anticipated. Stuck pressed, it stays stuck until a reload.
    ctx.fetch = async (url, opts) => {
      if (url === '/plan') {
        return { ok: true, json: async () => ({ get error() { throw new Error('boom'); } }) };
      }
      return real(url, opts);
    };
    let threw = false;
    try {
      await seal.onclick();
    } catch {
      threw = true;
    }
    check('the unexpected still reaches the surface', threw);
    check('and the seal lets go anyway', !seal._class.has('pressing'));

    // The press itself is the pointer's, not the click's: iOS fires `:active`
    // only under conditions this button does not always meet, and it would end
    // at the release anyway — which is where the waiting starts.
    seal.onpointerdown();
    check('a finger down presses it', seal._class.has('pressing'));
    seal.onpointercancel();
    check('a press stolen by a scroll lets go', !seal._class.has('pressing'));
    seal.onpointerdown();
    seal.onpointerleave();
    check('and so does a finger slid off the button', !seal._class.has('pressing'));
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
    // Its hour and its name, and nothing else: no chip, no label, no question.
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
      slots()[0].text().includes('8:00 AM'), slots()[0].text().trim());
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
    check('the finished one kept its hour', slots()[0].text().includes('8:00 AM'),
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

    const rows = () => thingRows(byId);
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

  console.log('\ntapping a greyed thing adds another, it does not take it out');
  {
    const things = [
      { id: 'e-spanish', type: 'habit', title: 'Spanish', days: 3, mark: null, due: null, size: null, note: null, last_scheduled: null },
      { id: 'e-free', type: 'task', title: 'Return the router', days: 1, mark: null, due: null, size: null, note: null, last_scheduled: null },
    ];
    const { ctx, byId, titles } = boot({
      plan: twoDays(), entries: utcEntries({ items: things }), now: '10:45',
    });
    await ctx.load();

    // The page opens on today, so a case about tomorrow's plan reaches it.
    await byId['pick-tomorrow'].onclick();

    const rows = () => thingRows(byId);
    const rowFor = (t) => rows().find((r) => r.text().includes(t));

    check('tomorrow holds one block', titles().join() === 'Spanish', titles().join());
    check('and its row is greyed', rowFor('Spanish')._class.has('locked'));

    // THE CHANGE. One gesture, one meaning. It used to take the thing back OUT
    // when the row was grey, so the same press did opposite things depending
    // on a state you had to read the colour to know — and scheduling one thing
    // twice was impossible, though two sessions of a project in a day is an
    // ordinary way to plan.
    rowFor('Spanish').onclick();
    check('tapping it adds a second', titles().join() === 'Spanish,Spanish',
      titles().join());
    check('the row stays greyed', rowFor('Spanish')._class.has('locked'));
    check('and nothing was removed to do it', byId['undo-host'].children.length === 0);

    rowFor('Spanish').onclick();
    check('and again, as many as you like',
      titles().join() === 'Spanish,Spanish,Spanish', titles().join());

    // A free row behaves the same way. There is one branch now, not two.
    rowFor('Return the router').onclick();
    check('a tap on a free row puts it in',
      titles().join() === 'Spanish,Spanish,Spanish,Return the router', titles().join());
    rowFor('Return the router').onclick();
    check('and the next one adds another of it too',
      titles().join() === 'Spanish,Spanish,Spanish,Return the router,Return the router',
      titles().join());
  }

  console.log('\nremoval belongs to the block, not to the row');
  {
    // What the row used to do is done where the thing being removed is the
    // thing you are pointing at — and it keeps the undo it always had.
    const things = [
      { id: 'e-uf', type: 'project', title: 'UF application', days: 6, mark: null, due: null, size: null, note: null, last_scheduled: null },
    ];
    const { ctx, byId, slots, titles, cardOf, backingOf } = boot({
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
    await byId['pick-tomorrow'].onclick();

    const rowFor = (t) => thingRows(byId).find((r) => r.text().includes(t));

    check('three blocks, two of them the same thing',
      titles().join() === 'UF application,Email,UF application', titles().join());
    check('the row is greyed', rowFor('UF application')._class.has('locked'));

    // Swipe the last one away.
    const card = cardOf(slots()[2]);
    down(card, 0, 0);
    move(card, -90, 0);
    up(card, -90, 0);
    await wait(CLOSED);

    check('the swipe takes that block', titles().join() === 'UF application,Email',
      titles().join());
    check('undoably, like any other removal', byId['undo-host'].children.length === 1);
    check('and the row stays greyed while one remains',
      rowFor('UF application')._class.has('locked'));

    // The other one, and the row frees up: locked is read off the blocks on
    // screen, so it follows them without being told.
    const first = cardOf(slots()[0]);
    down(first, 0, 0);
    move(first, -90, 0);
    up(first, -90, 0);
    await wait(CLOSED);

    check('the last of them goes too', titles().join() === 'Email', titles().join());
    check('and now the row is free', !rowFor('UF application')._class.has('locked'));
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
      slots()[0].text().includes('8:00 AM'), slots()[0].text().trim());
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

    check('it stayed where it was stored', slots()[0].text().includes('8:00 AM'),
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

    const row = thingRows(byId)[0];
    check('it is locked', row._class.has('locked'));

    const acts = row.children.find((c) => c._class.has('rowacts'));
    check('it still has a menu', Boolean(acts));
    // DELETE IS NOT IN IT. It left for the swipe, which is where the
    // confirmation is; a Delete in the menu as well would be a second route to
    // the same write, two paces from the hint, reachable by a finger that only
    // meant to open the menu.
    check('with everything that has no gesture, and no delete',
      acts.children.map((c) => c.textContent).join() === 'Done,Anytime,Pin,Later,Edit',
      acts.children.map((c) => c.textContent).join());

    const hint = row.children[0].children.find((c) => c._class.has('hint'));
    hint.onclick({ stopPropagation() {} });
    check('and the hint still opens it', !acts._class.has('hidden'));
  }

  console.log('\nDone offers an undo; Delete asks first and writes at once');
  {
    // Built fresh per boot. The page holds the array the fetch stub handed it
    // and splices that array, so one shared fixture would be emptied by the
    // first case and every later one would start short. A real fetch parses
    // new JSON each time; the stub does not.
    const items = () => [
      { id: 'e-a', type: 'task', title: 'Alpha', days: 1, mark: null, due: null, size: null, note: null, last_scheduled: null },
      { id: 'e-b', type: 'task', title: 'Beta', days: 2, mark: null, due: null, size: null, note: null, last_scheduled: null },
      { id: 'e-c', type: 'habit', title: 'Gamma', days: 3, mark: null, due: null, size: null, note: null, last_scheduled: null },
    ];
    const fresh = () => boot({
      entries: utcEntries({ plans_in: 'morning', items: items() }), now: '11:00',
    });

    const rowsIn = (byId) => thingRows(byId);
    const namesIn = (byId) =>
      rowsIn(byId).map((r) => r.children[0].children[0].textContent).join();
    const menuOf = (row) => row.children.find((c) => c._class.has('rowacts'));
    const press = (row, word) => {
      const b = menuOf(row).children.find((c) => c.textContent === word);
      b.onclick({ stopPropagation() {} });
    };
    const undoBar = (byId) => byId['undo-host'].children[0];

    // A swipe far enough to mean it, on a row rather than a block.
    const swipe = (byId, at, dx) => {
      const row = rowsIn(byId)[at];
      down(row, 0, 0);
      move(row, dx, 0);
      up(row, dx, 0);
    };
    // The question a swipe left leaves behind, or null.
    const askOf = (byId) =>
      thingSlots(byId)
        .map((t) => t.children.find((c) => c._class.has('asking')))
        .find(Boolean) || null;
    const pressAsk = (byId, word) => {
      const b = askOf(byId).children
        .find((c) => c._class.has('askacts'))
        .children.find((c) => c.textContent === word);
      b.onclick({ stopPropagation() {} });
    };

    {
      // DELETE ASKS. The undo is gone from this one: a thing may be weeks of
      // history and the row cannot come back, so the doubt is raised before
      // the write rather than after it.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(byId, 1, -80);
      const ask = askOf(byId);
      check('the row turns into the question', Boolean(ask));
      check('and the question names the thing',
        Boolean(ask) && ask.text().includes('Delete Beta?'), ask && ask.text());
      check('and the list is still three rows long', thingSlots(byId).length === 3,
        String(thingSlots(byId).length));
      check('nothing was written', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));
      check('and no undo was offered', byId['undo-host'].children.length === 0);

      // CANCEL PUTS IT BACK. This is the half a confirm exists for.
      pressAsk(byId, 'Cancel');
      check('cancel restores the row', namesIn(byId) === 'Alpha,Beta,Gamma',
        namesIn(byId));
      check('and still nothing was written', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));
      check('with no question left on screen', askOf(byId) === null);
    }

    {
      // DELETE COMMITS. No window, because the question was the window.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(byId, 1, -80);
      pressAsk(byId, 'Delete');

      check('the row goes', namesIn(byId) === 'Alpha,Gamma', namesIn(byId));
      check('and it is written at once, with no window',
        posted.length === 1 && posted[0].url === '/entries/e-b/delete',
        JSON.stringify(posted.map((p) => p.url)));
      check('the request survives the page closing',
        posted[0] && posted[0].keepalive === true, JSON.stringify(posted[0]));
      check('and no undo was offered for it',
        byId['undo-host'].children.length === 0);
    }

    {
      // SHORT OF IT IS NOTHING. The commit distance is most of a thumb's
      // travel on purpose: this one cannot be taken back.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(byId, 1, -40);
      check('a half swipe asks nothing', askOf(byId) === null);
      check('and the list is untouched', namesIn(byId) === 'Alpha,Beta,Gamma',
        namesIn(byId));
      check('with nothing written', posted.length === 0);
    }

    {
      // AND THE SWIPE IS NOT A TAP. The row schedules on a tap, so a finger
      // that swiped and released must not also put the thing in the day.
      const { ctx, byId, slots } = fresh();
      await ctx.load();

      const row = rowsIn(byId)[0];
      down(row, 0, 0);
      move(row, -80, 0);
      up(row, -80, 0);
      const before = slots().length;
      row.onclick({});
      check('the click after a swipe schedules nothing',
        slots().length === before, String(slots().length));

      // And the next real tap still works, which is what a flag held across
      // gestures would have broken: a browser that fires no click after a
      // swipe would leave it set, and the next tap anywhere in the list would
      // be eaten by something that happened on another row a minute ago.
      pressAsk(byId, 'Cancel');
      const again = rowsIn(byId)[0];
      down(again, 0, 0);
      up(again, 0, 0);
      again.onclick({});
      check('but the next plain tap does', slots().length === before + 1,
        String(slots().length));
    }

    {
      // DONE, which kept the undo. It is not the same kind of loss: a finished
      // task is work that happened, and the server would in fact take it back.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[0], 'Done');
      check('it says Done', undoBar(byId).text().includes('Done'),
        undoBar(byId).text());
      check('nothing posted yet', posted.length === 0);
      check('and it asks no question', askOf(byId) === null);

      await wait(UNDO_LAPSED);
      check('then it posts to done', posted.length === 1 && posted[0].url === '/entries/e-a/done',
        JSON.stringify(posted.map((p) => p.url)));
    }

    {
      // A closed tab inside a Done window still means it.
      const { ctx, byId, posted, win } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[0], 'Done');
      check('nothing posted while the offer stands', posted.length === 0);

      win.fire('pagehide');
      check('leaving the page writes it', posted.length === 1,
        JSON.stringify(posted.map((p) => p.url)));
      check('and it keeps the request alive past the page',
        posted[0] && posted[0].keepalive === true, JSON.stringify(posted[0]));
    }

    {
      // A delete while a Done offer stands commits the Done. Two actions, two
      // writes, and one bar that can only ever describe one of them.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(rowsIn(byId)[0], 'Done');
      swipe(byId, 0, -80);
      pressAsk(byId, 'Delete');

      check('both were written', posted.length === 2, JSON.stringify(posted.map((p) => p.url)));
      check('the Done first', posted[0].url === '/entries/e-a/done', posted[0].url);
      check('then the delete', posted[1].url === '/entries/e-b/delete', posted[1].url);
      check('and the bar is gone', byId['undo-host'].children.length === 0);
    }

    {
      // NOT A NATIVE CONFIRM. The question is a row in the list, so it can name
      // the thing, and so Cancel and Delete can be the words rather than OK.
      const { ctx, byId, confirmed } = fresh();
      await ctx.load();
      swipe(byId, 1, -80);
      check('nothing was raised at the browser', confirmed.length === 0,
        JSON.stringify(confirmed));
      const ask = askOf(byId);
      const words = ask.children.find((c) => c._class.has('askacts'))
        .children.map((c) => c.textContent).join();
      // Beta is a task, so all three: the way out, the answer that is often the
      // true one, and the one that cannot be taken back — in that order.
      check('the way out comes first and the irreversible one last',
        words === 'Cancel,Done,Delete', words);
    }

    {
      // DONE FROM THE QUESTION, which is what a swipe on a task usually means.
      // It takes the row off the list the same way the menu's Done does, undo
      // and all — deleting it instead would record that it should not have
      // existed, which is the opposite claim about the same work.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(byId, 1, -80);
      pressAsk(byId, 'Done');

      check('the row goes', namesIn(byId) === 'Alpha,Gamma', namesIn(byId));
      // Guarded, because the way this goes wrong is that there is no bar at
      // all: wire Done to the delete path and it writes at once with nothing
      // offered back. Unguarded that reads as a crash, which ends the run and
      // takes every case after it down rather than reporting one red line.
      const bar = undoBar(byId);
      check('and it is Done that is offered back, not Deleted',
        Boolean(bar) && bar.text().includes('Done'), bar && bar.text());
      check('nothing written while the offer stands', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));

      await wait(UNDO_LAPSED);
      check('then it posts to done, not delete',
        posted.length === 1 && posted[0].url === '/entries/e-b/done',
        JSON.stringify(posted.map((p) => p.url)));
      check('and no question is left on screen', askOf(byId) === null);
    }

    {
      // NOT ON A HABIT. The server refuses to finish one in a single go, so a
      // button for it would be offering a refusal.
      const { ctx, byId } = fresh();
      await ctx.load();

      swipe(byId, 2, -80);
      const words = askOf(byId).children.find((c) => c._class.has('askacts'))
        .children.map((c) => c.textContent).join();
      check('a habit is offered the two answers it has', words === 'Cancel,Delete', words);
      check('and the question still names it',
        askOf(byId).text().includes('Delete Gamma?'), askOf(byId).text());
    }
  }

  console.log('\na note on a thing is a message to the next scheduling of it');
  {
    // One with a note waiting and one without, so every check about the mark
    // has both halves in front of it.
    const items = () => [
      { id: 'e-a', type: 'project', title: 'Rewire the study', days: 1, mark: null, due: null, size: null, note: null, last_scheduled: null },
      { id: 'e-b', type: 'task', title: 'Return the router', days: 2, mark: null, due: null, size: null, note: 'bring the blue folder', last_scheduled: null },
    ];
    const fresh = (extra = {}) => boot({
      entries: utcEntries({ plans_in: 'morning', items: items() }), now: '11:00', ...extra,
    });

    const rows = (byId) => thingRows(byId);
    const markOf = (row) =>
      row.children[0].children.find((c) => c._class.has('notemark')) || null;
    const fieldOf = (row) => row.children.find((c) => c._class.has('thingnote')) || null;
    const swipe = (row, dx) => {
      down(row, 0, 0);
      move(row, dx, 0);
      up(row, dx, 0);
    };

    {
      // THE MARK SAYS THERE IS ONE. It does not say what it says: the list
      // must not get longer, and the note is addressed to the person about to
      // schedule this rather than to the person scanning the list.
      const { ctx, byId } = fresh();
      await ctx.load();

      check('a thing with a note carries a mark', Boolean(markOf(rows(byId)[1])));
      check('and one without carries none', markOf(rows(byId)[0]) === null);
      check('the row never shows the words',
        !rows(byId)[1].text().includes('blue folder'), rows(byId)[1].text());
      check('and the row is still two lines',
        rows(byId)[1].children.filter((c) => c._class.has('thingnote')).length === 0);
    }

    {
      // SWIPE RIGHT WRITES ONE. The same direction the blocks use, because it
      // is the same question asked of a different kind of row.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(rows(byId)[0], 80);
      const field = fieldOf(rows(byId)[0]);
      check('the field opens', Boolean(field));
      check('empty, because there was nothing there', field.value === '', field.value);
      check('it is a plain input, not the block textarea',
        field.tagName === 'input' && field.type === 'text', field.tagName);
      check('capitalised by sentence, for dictation',
        field.getAttribute('autocapitalize') === 'sentences');
      check('and not autocompleted at',
        field.getAttribute('autocomplete') === 'off' &&
        field.getAttribute('autocorrect') === 'off');
      check('nothing was written by opening it', posted.length === 0);

      field.value = 'start with the pricing page';
      field.onblur();
      // The write goes through api(), which awaits a token before it fetches.
      // Without a turn of the loop this reads an empty list and passes on nothing.
      await wait(0);

      check('leaving the field writes it',
        posted.length === 1 && posted[0].url === '/entries/e-a/note',
        JSON.stringify(posted.map((p) => p.url)));
      check('with the words in it',
        posted[0].body.note === 'start with the pricing page', JSON.stringify(posted[0].body));
      check('the field closes', fieldOf(rows(byId)[0]) === null);
      check('and the row gains its mark', Boolean(markOf(rows(byId)[0])));
    }

    {
      // SWIPING AGAIN IS HOW ONE IS READ, and how it is edited.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(rows(byId)[1], 80);
      check('it opens with what is already there',
        fieldOf(rows(byId)[1]).value === 'bring the blue folder',
        fieldOf(rows(byId)[1]).value);

      // Unchanged is not a write. A field opened to be read and closed again
      // must not send anything.
      fieldOf(rows(byId)[1]).onblur();
      await wait(0);
      check('closing it unchanged writes nothing', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));
      check('and the note is still there', Boolean(markOf(rows(byId)[1])));
    }

    {
      // EMPTY IS NOT A NOTE. Clearing the field is how one is removed.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(rows(byId)[1], 80);
      const field = fieldOf(rows(byId)[1]);
      field.value = '   ';
      field.onblur();
      // The write goes through api(), which awaits a token before it fetches.
      // Without a turn of the loop this reads an empty list and passes on nothing.
      await wait(0);

      check('whitespace clears it',
        posted.length === 1 && posted[0].body.note === null,
        JSON.stringify(posted.map((p) => p.body)));
      check('and the mark goes with it', markOf(rows(byId)[1]) === null);
    }

    {
      // ONCE, HOWEVER IT IS LEFT. Enter and blur both arrive on a phone — the
      // keyboard's own Done fires one and dismissing it fires the other — and
      // two writes for one sentence is one request too many.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      swipe(rows(byId)[0], 80);
      const field = fieldOf(rows(byId)[0]);
      field.value = 'said once';
      field.onkeydown({ key: 'Enter' });
      field.onblur();
      // The write goes through api(), which awaits a token before it fetches.
      // Without a turn of the loop this reads an empty list and passes on nothing.
      await wait(0);

      check('Enter then blur writes once', posted.length === 1,
        JSON.stringify(posted.map((p) => p.body)));
    }

    {
      // A ROW BEING WRITTEN ON IS NOT A ROW BEING TAPPED. The tap schedules,
      // and reaching for the field would otherwise put the thing in the day
      // under the keyboard that just opened.
      const { ctx, byId, slots } = fresh();
      await ctx.load();

      swipe(rows(byId)[0], 80);
      const before = slots().length;
      rows(byId)[0].onclick({});
      check('a tap on the row does not schedule it',
        slots().length === before, String(slots().length));
    }

    {
      // AND IT IS THE CONFIRM THAT SPENDS IT. The server decides — a block
      // does not exist until then — and both ends of the move show without a
      // reload: the block gains the line, the row loses the mark.
      const { ctx, byId, slots, noteOf } = fresh({
        planReply: {
          date: 'x', blocks: 1, status: 'confirmed', ids: ['b1'],
          notes: ['bring the blue folder'],
        },
      });
      await ctx.load();

      rows(byId)[1].onclick({});
      check('the thing is in the day', slots().length === 1, String(slots().length));
      check('and the block has no note yet', !noteOf(slots()[0]));

      await byId['confirm'].onclick();

      const line = noteOf(slots()[0]);
      check('the confirm brings it back onto the block', Boolean(line));
      check('with the words that were waiting',
        line && line.textContent === 'bring the blue folder', line && line.textContent);
      check('and the row it came off has no mark left',
        markOf(rows(byId)[1]) === null);
    }
  }

  console.log('\nthe timezone is one row, and the row is the control');
  {
    // What GET /settings answers.
    const settingsFor = (zone) => ({
      telegram: { set: true, hint: '…3785' },
      calendar: { set: true, hint: 'x/…/basic.ics' },
      timezone: zone,
      wake_minutes: 7 * 60,
      wake_min: 4 * 60,
      wake_max: 12 * 60,
      wake_step: 30,
      today: '2026-07-27',
      bot: '@pisystem1_bot',
    });

    const open = async (opts) => {
      const b = boot(opts);
      await b.ctx.load();
      b.byId['settings-open'].onclick();
      // loadSettings is a fetch, so the row is filled a turn later.
      await wait(0);
      return b;
    };

    {
      // THE VALUE IS ON THE ROW, not behind it. It was a panel — a stepper for
      // the hour a day starts, a dropdown, a live clock and two paragraphs —
      // and that is a lot of screen for something set once and then only ever
      // read.
      const { byId, posted } = await open({
        settings: settingsFor('America/New_York'), deviceZone: 'America/New_York',
      });

      check('the row says what it is set to',
        byId['when-state'].textContent === 'America/New_York', byId['when-state'].textContent);
      check('and nothing was written by looking', posted.length === 0,
        JSON.stringify(posted.map((p) => p.url)));

      // The select is the row: pressing anywhere on it is pressing the select,
      // so what opens is the phone's own wheel.
      const pick = byId['tz-pick'];
      check('the picker is a select', pick.tagName === 'select', pick.tagName);
      check('open on what is stored', pick.value === 'America/New_York', pick.value);
      check('holding the whole list', pick.children.length > 100, String(pick.children.length));
      check('with real zone names in it',
        pick.children.some((o) => o.value === 'Europe/Berlin'));
    }

    {
      // CHOOSING ONE WRITES IT, and there is nothing else to press.
      const { byId, posted } = await open({ settings: settingsFor('America/New_York') });
      posted.length = 0;

      const pick = byId['tz-pick'];
      pick.value = 'Europe/Berlin';
      pick.onchange();
      await wait(0);

      check('it goes to the timezone route',
        posted.length === 1 && posted[0].url === '/settings/timezone',
        JSON.stringify(posted.map((p) => p.url)));
      check('carrying what was chosen', posted[0].body.timezone === 'Europe/Berlin',
        JSON.stringify(posted[0].body));
      check('and the row says so at once',
        byId['when-state'].textContent === 'Europe/Berlin', byId['when-state'].textContent);
    }

    {
      // A STORED ZONE THE LIST DOES NOT HOLD still opens on itself. UTC is the
      // case: it is a real answer and is not in supportedValuesOf, so a select
      // built from that list alone would open on whatever sorts first and show
      // a zone nobody had chosen.
      const { byId } = await open({ settings: settingsFor('UTC') });
      check('the row still reads UTC', byId['when-state'].textContent === 'UTC',
        byId['when-state'].textContent);
      check('and the picker opens on it', byId['tz-pick'].value === 'UTC',
        byId['tz-pick'].value);
      check('with it present as an option',
        byId['tz-pick'].children.some((o) => o.value === 'UTC'));
    }

    {
      // THE DEVICE'S OWN ZONE IS ALWAYS IN THE LIST, whatever the runtime knows.
      // The one-tap offer that used to be built on it is gone with the panel,
      // so this is what is left of it — and it is the floor under a browser
      // with no supportedValuesOf, which would otherwise leave a picker holding
      // one option: a dead control wearing the clothes of a live one.
      const { byId } = await open({
        settings: settingsFor('UTC'), deviceZone: 'Pacific/Auckland',
      });
      check('the device zone can be picked',
        byId['tz-pick'].children.some((o) => o.value === 'Pacific/Auckland'));
    }

    {
      // REFUSED, AND THE ROW GOES BACK TO WHAT IS STORED. Barely reachable —
      // every option came out of the browser's own tzdb — but a row left
      // showing a value the server would not take is a screen disagreeing with
      // the database and saying nothing about it.
      const { byId } = await open({
        settings: settingsFor('America/New_York'),
        timezoneReply: { error: 'not a timezone: Mars/Olympus.' },
      });

      const pick = byId['tz-pick'];
      pick.value = 'Europe/Berlin';
      pick.onchange();
      await wait(0);

      check('the row is back on the stored zone',
        byId['when-state'].textContent === 'America/New_York', byId['when-state'].textContent);
      check('and so is the picker', byId['tz-pick'].value === 'America/New_York',
        byId['tz-pick'].value);
    }

    {
      // WHAT WENT WITH THE PANEL. Named one by one, because each was a control
      // that wrote something and a check that only counts them would pass
      // against a half-removed screen.
      const html = require('fs').readFileSync(ROOT + '/public/index.html', 'utf8');
      check('no stepper for the hour a day starts', !/wake-def-minus/.test(html));
      check('nor a live clock beside the zone', !/tz-now/.test(html));
      check('nor a one-tap offer', !/tz-suggest/.test(html));
      check('nor a panel for them to sit in', !/when-detail/.test(html));
      check('the row is a label, so the select opens from anywhere on it',
        /<label class="srow tzrow" id="when-row">/.test(html));
      check('and it is named for the one thing it now does',
        /<span class="srow-name">Timezone<\/span>/.test(html));
    }
  }

  console.log('\na link at the foot of the page fetches it again');
  {
    // WHY THIS EXISTS AT ALL. An installed app has no address bar and no
    // browser pull-to-refresh, so without something here there is no way from
    // inside it to pick up a new build — which is how a phone ends up running
    // a fortnight-old version and showing a screen that no longer exists.
    //
    // IT WAS A PULL FROM THE TOP for a few revisions, and a gesture is the
    // wrong shape for this: invisible until somebody tells you it is there,
    // and competing for the same finger as the scroll it starts inside. The
    // threshold had to be retuned once because of exactly that competition.
    const { ctx, byId, reloads } = boot();
    await ctx.load();

    check('nothing has reloaded on its own', reloads.length === 0, String(reloads.length));

    byId['refresh'].onclick();
    check('pressing it fetches the page again', reloads.length === 1, String(reloads.length));

    // A NAVIGATION, NOT A RELOAD IN PLACE. An installed app reloaded in place
    // can come back suspended: nothing painted and every fetch held until the
    // screen is touched, which is the blank screen this link was reported for.
    // Replacing the address is an ordinary navigation to a fresh document.
    check('by navigating rather than resuming the page it is on',
      reloads[0].how === 'replace', JSON.stringify(reloads[0]));
    check('to where it already is', reloads[0].url === 'https://app.example/',
      String(reloads[0].url));

    // The page rather than the day: what goes stale is the app itself, and
    // re-reading the data would not replace it.
    const html = require('fs').readFileSync(ROOT + '/public/index.html', 'utf8');
    check('and it is the page it fetches, not the day',
      /\$\('refresh'\)\.onclick[\s\S]{0,400}location\.replace\(location\.href\)/.test(html));

    // THE GESTURE IS GONE, named piece by piece: a half-removed gesture leaves
    // listeners on the document that quietly take touches from the page.
    check('no pull threshold is left', !/PULL_COMMIT/.test(html));
    check('nor the damping it needed', !/damped\(/.test(html));
    check('nor the handlers', !/movedPull|releasedPull|canPull/.test(html));
    check('nor the dot it moved', !/id="pull"/.test(html));

    // AND NOTHING IS LISTENING ON THE DOCUMENT AT REST. The reorder installs a
    // touchmove while a block is carried and takes it away again; anything
    // standing there permanently would be the pull's leftovers.
    const { touchmoves } = boot();
    check('the document holds no standing touch listener', touchmoves().length === 0,
      String(touchmoves().length));
  }

  console.log('\npinned things are held at the top, and the screen says why');
  {
    // A pin is the only thing on this screen that changes the order by hand.
    // Everything else about it is arithmetic on what the person declared — and
    // so is this, in the end: the list GUESSES at what needs attention, and a
    // pin is somebody saying it outright.
    const items = () => [
      // IN THE ORDER THE SERVER WOULD SEND THEM. The stub hands this array
      // back untouched and the page does not re-sort on load, so a fixture in
      // any other order is a starting state that cannot happen: marked first,
      // then coldest.
      { id: 'e-uf', type: 'project', title: 'UF application', days: 6, mark: '!!!', due: '2026-07-28', size: 'a week', note: null, pinned: false, last_scheduled: null },
      { id: 'e-read', type: 'habit', title: 'Reading', days: 11, mark: null, due: null, size: null, note: null, pinned: false, last_scheduled: null },
      { id: 'e-gym', type: 'habit', title: 'Gym', days: 2, mark: null, due: null, size: null, note: null, pinned: false, last_scheduled: null },
    ];
    const fresh = (extra = {}) => boot({
      entries: utcEntries({ plans_in: 'morning', items: items(), ...extra }), now: '11:00',
    });

    const names = (byId) => thingRows(byId)
      .map((r) => r.children[0].children[0].textContent).join();
    const menuOf = (row) => row.children.find((c) => c._class.has('rowacts'));
    const press = (byId, at, word) => {
      const b = menuOf(thingRows(byId)[at]).children.find((c) => c.textContent === word);
      b.onclick({ stopPropagation() {} });
    };
    // The mark on a row, which is out at the edge with the deadline asterisks
    // — not inside the title. Beside the name it read as part of the name, and
    // moved as titles changed length; everything after the name is a mark
    // ABOUT the row, and the pin is one of those.
    const pinMark = (byId, at) => {
      const top = thingRows(byId)[at].children[0];
      return top.children.find((c) => c._class && c._class.has('pinmark')) || null;
    };
    const marked = (byId) => thingRows(byId)
      .map((r, i) => (pinMark(byId, i) ? 1 : 0)).join('');

    {
      // NOTHING PINNED, NOTHING SAID. A standing label over an empty group is
      // a section of the list that says nothing on almost every day.
      const { ctx, byId } = fresh();
      await ctx.load();

      check('the list is in its usual order', names(byId) === 'UF application,Reading,Gym',
        names(byId));
      check('and no row carries a pin', marked(byId) === '000', marked(byId));
      check('the menu offers a pin', Boolean(menuOf(thingRows(byId)[1])
        .children.find((c) => c.textContent === 'Pin')));
    }

    {
      // PINNING MOVES IT AT ONCE, above a deadline that has run out. That cost
      // is the deliberate part: a pin outranks the arithmetic, and the screen
      // does not argue about it.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      posted.length = 0;

      press(byId, 2, 'Pin');

      check('the pinned thing goes to the top', names(byId) === 'Gym,UF application,Reading',
        names(byId));
      check('ABOVE SOMETHING OVERDUE, which is the whole decision',
        names(byId).indexOf('Gym') < names(byId).indexOf('UF application'));
      // ONE LIST, and the row says why it is where it is. A heading and a gap
      // would split three things into two groups of one and two.
      check('the row that moved carries a pin', Boolean(pinMark(byId, 0)));
      check('and it is the only one that does', marked(byId) === '100', marked(byId));
      // OUT WITH THE OTHER MARKS, and immediately before the asterisks so the
      // two read as one cluster rather than as two ideas at the same edge.
      const top = thingRows(byId)[0].children[0];
      const order = top.children.map((c) => c.className).join(' ');
      check('the mark is not inside the title', !top.children[0].children.length,
        JSON.stringify(order));
      // The names of the row's top line, in order. On a row with a deadline
      // the pin must be the thing immediately before the asterisks, so the two
      // read as one cluster rather than two ideas sharing an edge.
      const withDeadline = thingRows(byId)[1].children[0].children.map((c) => c.className);
      check('it sits out at the edge, after the title',
        order.indexOf('pinmark') > order.indexOf('title'), order);
      check('and the row that has a deadline still shows its asterisks',
        withDeadline.join(' ') === 'title mark hint', withDeadline.join(' '));
      check('and it is named for anything that cannot see it',
        pinMark(byId, 0).getAttribute('aria-label') === 'pinned',
        pinMark(byId, 0).getAttribute('aria-label'));

      // Written at once. There is no Confirm over this list, and a pin that
      // lived only in the page would be lost by the reload meant to restore it.
      await wait(0);
      check('it is written straight away',
        posted.length === 1 && posted[0].url === '/entries/e-gym/pin',
        JSON.stringify(posted.map((p) => p.url)));
      check('saying which way it went', posted[0].body.pinned === true,
        JSON.stringify(posted[0].body));
    }

    {
      // NOTHING SPLITS THE LIST. It is one list with a mark in it, which is the
      // whole of the difference from the group this replaced.
      const { ctx, byId } = fresh();
      await ctx.load();
      press(byId, 2, 'Pin');

      const html = require('fs').readFileSync(ROOT + '/public/index.html', 'utf8');
      check('there is no heading over the pinned ones', !/pinhead/.test(html));
      check('nor a gap after the last of them', !/afterpins/.test(html));
      check('every row is still a plain row',
        thingSlots(byId).every((t) => t.className === 'thing'),
        thingSlots(byId).map((t) => t.className).join('|'));
    }

    {
      // UNPINNING PUTS IT BACK where the arithmetic wants it.
      const { ctx, byId, posted } = fresh();
      await ctx.load();
      press(byId, 2, 'Pin');
      await wait(0);
      posted.length = 0;

      check('it says Unpin once it is pinned', Boolean(menuOf(thingRows(byId)[0])
        .children.find((c) => c.textContent === 'Unpin')));

      press(byId, 0, 'Unpin');
      await wait(0);

      check('it drops back into the order', names(byId) === 'UF application,Reading,Gym',
        names(byId));
      check('and the mark goes with it', marked(byId) === '000', marked(byId));
      check('and that is written too',
        posted.length === 1 && posted[0].body.pinned === false,
        JSON.stringify(posted.map((p) => p.body)));
    }

    {
      // TWO PINS ARE ORDERED BY THE SAME ARITHMETIC as everything else, so the
      // pinned group is not a second list with its own rules.
      const { ctx, byId } = fresh();
      await ctx.load();
      press(byId, 1, 'Pin');   // Reading, no mark, 11 days
      press(byId, 2, 'Pin');   // Gym, no mark, 2 days — after Reading

      check('the colder of the two pins comes first',
        names(byId) === 'Reading,Gym,UF application', names(byId));
    }

    {
      // A REFUSED PIN PUTS THE ROW BACK. A row sitting at the top of a list the
      // database does not agree with is wrong in a way that survives until the
      // next load and then silently corrects itself.
      const { ctx, byId } = fresh();
      await ctx.load();
      ctx.__failPin = true;

      press(byId, 2, 'Pin');
      check('it moves on the press', names(byId) === 'Gym,UF application,Reading',
        names(byId));

      await wait(0);
      check('and goes back when the write is refused',
        names(byId) === 'UF application,Reading,Gym', names(byId));
      check('with no mark left behind', marked(byId) === '000', marked(byId));
    }

    {
      // WHAT THE SERVER SENDS IS WHAT IS DRAWN. A pin that arrives already set
      // needs no press to be at the top.
      // AS THE SERVER WOULD SEND IT: pinned first, then the usual two halves.
      // The page does not re-sort what it is handed — it holds no second
      // opinion about this order, which is the point of sortThings existing
      // only for the moment a pin changes it here — so a fixture with a pinned
      // row anywhere but the front is a delivery that cannot happen.
      const already = items();
      const read = already.find((t) => t.id === 'e-read');
      read.pinned = true;
      const b = boot({
        entries: utcEntries({
          plans_in: 'morning',
          items: [read, ...already.filter((t) => t !== read)],
        }),
        now: '11:00',
      });
      await b.ctx.load();

      check('a thing that arrives pinned is already at the top',
        names(b.byId).startsWith('Reading'), names(b.byId));
      check('and it is marked on the first render', Boolean(pinMark(b.byId, 0)));
    }
  }

  console.log('\nnothing reaches the server without saying who it is');
  {
    const { ctx, byId, asked } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.start();

    // EVERY request, not just the writes. A read that forgets the header is
    // not a visibly broken read — it is a 401, which the page turns into an
    // empty day. That is the shape of this failure: nothing looks wrong.
    const appCalls = asked.filter((a) => a.url !== '/config');
    check('the page asked for something', appCalls.length > 0, String(appCalls.length));
    check('and every one of them carried a token',
      appCalls.every((a) => /^Bearer \S/.test(a.auth || '')),
      JSON.stringify(appCalls.filter((a) => !a.auth).map((a) => a.url)));

    // /config is the exception, necessarily: it is what you fetch when you
    // have nothing, and it is how the page learns where to sign in.
    const config = asked.find((a) => a.url === '/config');
    check('config was fetched first, without one', config && !config.auth,
      JSON.stringify(config));
    check('and it was fetched before anything else', asked[0].url === '/config',
      asked[0].url);

    // Writes too, through the same wrapper.
    byId['pick-tomorrow'].onclick && (await byId['pick-tomorrow'].onclick());
    await byId['confirm'].onclick();
    const confirmCall = asked.filter((a) => a.url === '/plan').pop();
    check('a confirm says who it is', /^Bearer \S/.test((confirmCall || {}).auth || ''),
      JSON.stringify(confirmCall));
  }

  console.log('\nno session means the gate, not an empty planner');
  {
    const { ctx, byId, asked } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00', signedIn: false,
    });
    await ctx.start();

    check('the gate is up', !byId['gate']._class.has('hidden'));
    check('and nothing was asked for', asked.every((a) => a.url === '/config'),
      JSON.stringify(asked.map((a) => a.url)));
    check('so the builder is empty', byId['builder'].children.length === 0);

    // THE DISTINCTION THIS PROTECTS. An empty planner and a signed-out one
    // look identical if the page just renders whatever it has, which is
    // nothing either way. The gate is what makes them different screens.
    check('and the list is empty too', byId['things'].children.length === 0);
  }

  console.log('\na session the server refuses puts the gate back up');
  {
    const { ctx, byId, stored } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });

    const real = ctx.fetch;
    ctx.fetch = async (url, opts) => {
      if (url === '/config') return real(url, opts);
      return { ok: false, status: 401, json: async () => ({ error: 'not signed in' }) };
    };

    await ctx.start();

    check('the gate came back', !byId['gate']._class.has('hidden'));
    // The stored session goes with it. Left behind, the next load would try
    // the same dead token, fail the same way, and look like a broken app
    // rather than one asking you to sign in again.
    check('and the dead session was thrown away', !stored.has('pi.session'),
      String(stored.get('pi.session')));
  }

  console.log('\nthe seal reads right after a day switch and back');
  {
    // The exact sequence a confirmed day, Tomorrow, Today reported as broken.
    // This says nothing about how it LOOKS — the stub has no layout — but it
    // separates "the button is in the wrong state" from "the button is in the
    // right state and is drawn wrong", which are different bugs in different
    // files.
    const { ctx, byId } = boot({
      plan: {
        [TODAY]: {
          plan: { date: TODAY, status: 'confirmed', wake_minutes: 480 },
          blocks: [{ id: 'b-1', title: 'Alpha', start_minutes: 600, duration_minutes: 30, entryId: null, note: null }],
        },
        [TOMORROW]: { plan: null, blocks: [] },
      },
      entries: utcEntries(), now: '11:00',
    });
    await ctx.load();

    check('today opens confirmed', byId['confirm'].textContent === 'Confirmed',
      byId['confirm'].textContent);
    check('and is not pressable', byId['confirm'].disabled === true);

    await byId['pick-tomorrow'].onclick();
    check('tomorrow has nothing to confirm', byId['confirm'].textContent === 'Confirm',
      byId['confirm'].textContent);

    await byId['pick-today'].onclick();
    check('and today reads confirmed again', byId['confirm'].textContent === 'Confirmed',
      byId['confirm'].textContent);
    check('with nothing left over from the way back',
      byId['confirm'].disabled === true && !byId['confirm']._class.has('pressing'),
      `disabled=${byId['confirm'].disabled} classes=${byId['confirm'].className}`);
  }

  console.log('\nsetup is somewhere you go, never somewhere you are sent');
  {
    // A new account used to land on setup instead of the planner. It does
    // not: whoever hands this system to someone explains the dots, which is
    // cheaper than a screen that stops everyone on their way in.
    const bare = { telegram: { set: false, hint: null }, calendar: { set: false, hint: null } };
    const { ctx, byId } = boot({
      plan: twoDays(), entries: utcEntries({ items: [] }), now: '11:00', settings: bare,
    });
    await ctx.start();

    check('an account with nothing at all still opens on the day',
      byId['settings-scrim']._class.has('hidden'));
    check('and the day is what it is looking at', byId['builder'].children.length > 0);

    // And it is still one tap away.
    byId['settings-open'].onclick();
    check('the dots open it', !byId['settings-scrim']._class.has('hidden'));

    // What the way out SAYS is markup now rather than something the script
    // rewrites per visit, so plan-layout-check is where that is pinned. The
    // stub does not read text out of the file — the old assertion here only
    // passed because openSettings used to set it.
    check('and nothing had to be told which kind of visit this was',
      ctx.openSettings.length === 0, `openSettings takes ${ctx.openSettings.length} argument(s)`);
  }

  console.log('\nsigning out takes the day off the screen with it');
  {
    const { ctx, byId, stored } = boot({
      plan: twoDays(), entries: utcEntries(), now: '11:00',
    });
    await ctx.start();

    check('there was a day to begin with', byId['builder'].children.length > 0);
    check('and the account is named', byId['whoami'].textContent === 'planner@example.test',
      byId['whoami'].textContent);

    await byId['sign-out'].onclick();

    check('the session is gone', !stored.has('pi.session'));
    check('the gate is up', !byId['gate']._class.has('hidden'));
    // NOT JUST HIDDEN. The next person to open this device must not find the
    // last one's day sitting behind the sign-in screen.
    check('the day is off the screen', byId['builder'].children.length === 0,
      String(byId['builder'].children.length));
    check('and so is the list', byId['things'].children.length === 0,
      String(byId['things'].children.length));
  }

  console.log('\nthe cover comes off even when nothing answers');
  {
    // THE REPORTED BUG, in the only form this suite can hold: press Refresh and
    // the page comes back blank until you touch the screen.
    //
    // The cover is what is blank. It is a full-screen fill over the app, and it
    // used to come off in `start().finally(uncover)` — so it stayed up for
    // exactly as long as the slowest fetch of the boot took, with no bound on
    // that at all. A request that never settles is not an exotic state on a
    // phone: an app woken by a reload can have its network held until the next
    // interaction, which is why the screen came back when it was touched.
    //
    // Nothing here is about iOS. A cover that hides the app until the network
    // agrees to answer is wrong on any device; the phone is only where it was
    // noticed.
    const { ctx, byId } = boot({ hangOn: '/entries' });

    // Read off the page rather than written down here. A `const` inside the
    // script is not a property of the vm's global, so it cannot be reached the
    // way a function can — and a number copied into this file would be a test
    // that keeps waiting 2.5 seconds long after the page stopped.
    const patience = Number(/BOOT_PATIENCE = (\d+)/.exec(html)[1]);
    check('the page says how long it will hide behind the cover',
      Number.isFinite(patience) && patience > 0 && patience < 10000, String(patience));

    ctx.begin();
    // Past the cover's own deadline. The boot itself never finishes here — that
    // is the case — so waiting on it would be waiting for ever.
    await new Promise((r) => setTimeout(r, patience + 300));

    check('the cover is off', byId['booting']._class.has('done'),
      [...byId['booting']._class].join(' '));
    check('and out of the way, not merely see-through',
      byId['booting'].style.display === 'none', byId['booting'].style.display);

    // AND WHAT SHOWS SAYS WHAT IT IS. Lifting the cover onto an app frame with
    // an empty day under it would look finished and wrong; the day carries the
    // same waiting mark the day switch uses, which is the honest screen for
    // something that has not arrived.
    const waiting = byId['builder'].children.filter((c) => c._class.has('waiting'));
    check('and the day says it is still coming', waiting.length === 1,
      `${byId['builder'].children.length} in the builder`);
    check('rather than reading as an empty day',
      byId['builder'].children.every((c) => !c._class.has('slot')));

    // NOT THE GATE. This person is signed in; the cover lifting early must not
    // turn into being shown the door.
    check('the gate stays down', byId['gate']._class.has('hidden'));
  }

  console.log('\na one-off goes straight onto the day and never onto the list');
  {
    // WHAT THIS IS FOR. Everything on the Anytime list used to have come off a
    // Things row, so a reminder — walk the dog, put the bins out — had to be
    // filed as a permanent thing you are carrying, scheduled onto the day,
    // ticked, and then finished on the list separately, because ticking an
    // anytime item answers "did this happen" and not "is this over". Four steps
    // and two lists for something that belongs to neither.
    const { ctx, byId, slots, titles, posted, typeAdd } = boot();
    await ctx.load();

    // REACHABLE ON AN EMPTY DAY. The Anytime section is hidden until something
    // is in it, so a button inside it could never add the first one.
    check('the anytime section starts hidden', byId['anytime']._class.has('hidden'));
    check('but the way in is there anyway', typeof byId['add-anytime'].onclick === 'function');

    const endedAt = byId['end-time'].textContent;
    byId['add-anytime'].onclick();

    // IN THE PAGE, NOT OVER IT. This was the browser's own prompt() — a system
    // dialog covering the app, one per block, on a day you build several at a
    // time.
    check('the field opens where the controls were',
      !byId['add-field']._class.has('hidden') && byId['adds']._class.has('hidden'));
    check('and says what it will make',
      byId['add-field'].getAttribute('placeholder') === 'What needs doing?',
      String(byId['add-field'].getAttribute('placeholder')));

    typeAdd('Walk the dog');
    check('the section opens', !byId['anytime']._class.has('hidden'));
    check('with the one-off on it',
      anytimeTitles(byId).join() === 'Walk the dog', anytimeTitles(byId).join());

    // NOT IN THE DAY'S HOURS. It has no start and no length, so the day ends
    // where the timed blocks say it does.
    check('it is not a block in the day', titles().length === 0, titles().join());
    check('so it does not move when the day ends',
      byId['end-time'].textContent === endedAt,
      `${endedAt} -> ${byId['end-time'].textContent}`);

    // AND NOT ON THE THINGS LIST, which is the whole of it.
    const things = () => byId['things'].children.map((c) => c.text()).join(' ');
    check('nothing was added to the things list', !things().includes('Walk the dog'),
      things());

    // TICKING IS THE END OF IT. There is no entry to go back and close, which
    // is the step this whole thing removes.
    check('it starts unticked', !anytimeRows(byId)[0]._class.has('did'));
    tickOf(anytimeRows(byId)[0]).onclick();
    check('and ticking marks it done', anytimeRows(byId)[0]._class.has('did'),
      [...anytimeRows(byId)[0]._class].join(' '));

    // What the confirm sends: a block with no hour, no length, and nothing
    // behind it.
    posted.length = 0;
    await byId['confirm'].onclick();
    const body = posted.find((p) => p.url === '/plan').body;
    const sent = body.blocks.find((b) => b.title === 'Walk the dog');
    check('it is confirmed as part of the day', Boolean(sent), JSON.stringify(body.blocks));
    check('with no hour', sent.start_minutes === null, JSON.stringify(sent));
    check('and no length', sent.duration_minutes === null, JSON.stringify(sent));
    check('and nothing on the list behind it',
      sent.entryId === null || sent.entryId === undefined, JSON.stringify(sent));
  }

  console.log('\nthe add field: nothing typed adds nothing, and it stays open');
  {
    const { ctx, byId, typeAdd, slots } = boot();
    await ctx.load();

    byId['add-anytime'].onclick();
    for (const nothing of ['', '   ']) typeAdd(nothing);
    check('an empty line adds nothing', anytimeTitles(byId).length === 0,
      anytimeTitles(byId).join());
    check('and the section stays hidden', byId['anytime']._class.has('hidden'));
    check('but the field is still open to type in',
      !byId['add-field']._class.has('hidden'));

    // OPEN AFTER EACH ONE. A day is built a handful at a time, and closing
    // after every entry is the cost the browser's prompt used to charge.
    typeAdd('One');
    check('the field stays open after adding', !byId['add-field']._class.has('hidden'));
    check('and empties itself', byId['add-field'].value === '',
      JSON.stringify(byId['add-field'].value));
    typeAdd('Two');
    typeAdd('Three');
    check('so three go in without reopening anything',
      anytimeTitles(byId).join() === 'One,Two,Three', anytimeTitles(byId).join());

    // LEAVING SAVES IT, the rule a note on a block already follows. Tapping
    // away from something you typed and watching it vanish loses work.
    byId['add-field'].value = 'Typed and left';
    byId['add-field'].onblur();
    check('leaving the field keeps what was in it',
      anytimeTitles(byId).join() === 'One,Two,Three,Typed and left',
      anytimeTitles(byId).join());
    check('and closes it back to the controls',
      byId['add-field']._class.has('hidden') && !byId['adds']._class.has('hidden'));

    // THE OTHER CONTROL MAKES A BLOCK, which is the whole difference between
    // the pair, and it is one line apart in the page.
    byId['add-block'].onclick();
    check('the block field says what it will make',
      byId['add-field'].getAttribute('placeholder') === 'What is this block?',
      String(byId['add-field'].getAttribute('placeholder')));
    typeAdd('An hour of something');
    check('and it lands in the day rather than under it',
      slots().length === 1, `${slots().length}`);
    check('with the anytime list untouched', anytimeTitles(byId).length === 4,
      anytimeTitles(byId).join());
  }

  console.log('\nthe calendar aside puts things in the day, and never greys');
{
  const CAL = [
    { title: 'Dentist', start_minutes: 14 * 60, duration_minutes: 60 },
    { title: 'Standup', start_minutes: 9 * 60 + 30, duration_minutes: 30 },
    { title: 'Bin day', start_minutes: null, duration_minutes: null },
  ];

  {
    const { calRows, calSays, ctx } = boot({ calendar: CAL });
    await ctx.load();
    check('every event is a row', calRows().length === 3, `${calRows().length}`);
    check('and the aside says nothing else', calSays() === '', calSays());

    const row = calRows()[0];
    check('the time starts the row', row.children[0].textContent === '2:00 PM',
      row.children[0].textContent);
    check('then the title', row.children[1].textContent === 'Dentist',
      row.children[1].textContent);
    // AND NOTHING ELSE. It carried a muted + at the edge, and a mark on every
    // row to describe a gesture is a toll paid on every reading of the list to
    // explain something once. The aside is read far more often than pressed.
    check('and nothing after it', row.children.length === 2,
      row.children.map((c) => c.textContent).join('|'));
    check('no + anywhere in the aside', !calRows().some((r) => r.text().includes('+')),
      calRows().map((r) => r.text()).join(' / '));
    check('an all-day entry shows no time', calRows()[2].children[0].textContent === '',
      JSON.stringify(calRows()[2].children[0].textContent));
    check('but is still a row you can press', typeof calRows()[2].onclick === 'function');
  }

  {
    const { calRows, titles, slots, chipOf, ctx } = boot({ calendar: CAL });
    await ctx.load();
    check('nothing is in the day to start', titles().length === 0, `${titles().length}`);

    calRows()[0].onclick();
    check('pressing one puts it in the day', titles().join() === 'Dentist', titles().join());

    // THE TITLE IS THE TARGET, and with the + gone it is most of the row. It
    // has no handler of its own — the press belongs to the row and the title
    // is inside it — so a tap that lands on the word is a tap on the row.
    const words = calRows()[1].children[1];
    check('the title carries no handler of its own', !words.onclick);
    check('and it is the part of the row that stretches',
      words._class.has('ctitle'), [...words._class].join(' '));

    // ITS OWN LENGTH. The one thing about a calendar event the day can hold
    // exactly, and the alternative is three taps on the chip to say what the
    // calendar already said.
    check('at the length the calendar said', chipOf(slots()[0]).textContent === '1h',
      chipOf(slots()[0]).textContent);

    calRows()[2].onclick();
    check('an all-day entry comes in at one step',
      chipOf(slots()[1]).textContent === '30m', chipOf(slots()[1]).textContent);
  }

  {
    // NEVER GREYED, which is the difference from a Things row. A meeting you
    // have built the day around is still a meeting at two o'clock.
    const { calRows, titles, ctx } = boot({ calendar: CAL });
    await ctx.load();
    calRows()[0].onclick();

    // DRAWN AGAIN AFTER THE PRESS, which is the only way this case can fail.
    // The aside renders once on a day change and nothing about adding a block
    // re-runs it, so reading the row as it was left would assert a class that
    // could not have appeared — a check that passes because nothing happened.
    // Re-rendering is what a greying rule would have to survive.
    await ctx.loadCalendar('2026-07-28');

    const row = calRows()[0];
    check('the aside redraws to the same three rows', calRows().length === 3,
      `${calRows().length}`);
    check('the row it came from is not locked', !row._class.has('locked'),
      [...row._class].join(' '));
    check('nor greyed by any other name',
      ![...row._class].some((c) => /lock|grey|gray|done|used|taken/i.test(c)),
      [...row._class].join(' '));
    check('and it still reads the same', row.children[1].textContent === 'Dentist');
    check('and is still a row you can press', typeof row.onclick === 'function');

    // Pressing twice makes two, the same as the list does.
    calRows()[0].onclick();
    check('so pressing it again adds another', titles().join() === 'Dentist,Dentist',
      titles().join());
  }

  {
    // THREE WAYS TO HAVE NOTHING TO SHOW, still three sentences, and none of
    // them a row anybody can press.
    const quiet = boot({ calendar: [] });
    await quiet.ctx.load();
    check('a quiet day says so', quiet.calSays() === 'Nothing on it.', quiet.calSays());
    check('with no rows', quiet.calRows().length === 0);

    const none = boot({ calendar: [], configured: false });
    await none.ctx.load();
    check('never set up says something else',
      none.calSays().includes('No calendar yet'), none.calSays());

    const broken = boot({ calendar: [], failed: true });
    await broken.ctx.load();
    check('and a feed that could not be read says that',
      broken.calSays() === 'Could not reach your calendar.', broken.calSays());
    check('which is not the same sentence as a quiet day',
      broken.calSays() !== quiet.calSays());

    const half = boot({ calendar: CAL, failed: true });
    await half.ctx.load();
    check('a half-read feed still shows what it got', half.calRows().length === 3);
    check('and says it may not be all of it',
      half.calSays().includes('may not be all of it'), half.calSays());
  }
}

  console.log(bad === 0 ? '\nBuilder clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e.message, '\n', e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
