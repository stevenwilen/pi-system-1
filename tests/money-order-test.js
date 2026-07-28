// Money tab ordering and the collapsed intent section, from the real script.
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
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
  addEventListener() {} removeEventListener() {}
  getBoundingClientRect() { return { top: 0, height: 40 }; }
  closest() { return this; }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  text() { return (this.textContent || '') + this.children.map((c) => c.text()).join(' '); }
}

const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function boot(intentItems, summary) {
  const ids = [...new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))];
  const byId = {};
  for (const id of ids) byId[id] = new El();
  // Class can sit either side of id in the markup, so both orders are read.
  // Matching only one silently left elements unstyled and made a correctly
  // closed section look open.
  for (const id of ids) {
    const after = html.match(new RegExp(`id="${id}"[^>]*?class="([^"]*)"`));
    const before = html.match(new RegExp(`class="([^"]*)"[^>]*?id="${id}"`));
    const cls = (after && after[1]) || (before && before[1]);
    if (cls) byId[id].className = cls;

    const ariaAfter = html.match(new RegExp(`id="${id}"[^>]*?aria-expanded="([^"]*)"`));
    const ariaBefore = html.match(new RegExp(`aria-expanded="([^"]*)"[^>]*?id="${id}"`));
    const aria = (ariaAfter && ariaAfter[1]) || (ariaBefore && ariaBefore[1]);
    if (aria) byId[id].setAttribute('aria-expanded', aria);
  }
  for (const t of ['habit', 'project', 'task']) {
    const b = new El('button'); b.dataset.type = t; byId['type-seg'].append(b);
  }
  const endsRow = new El(); endsRow.className = 'ends-row';
  byId['ends'].querySelector = () => endsRow;

  const ctx = vm.createContext({
    console, setTimeout, requestAnimationFrame: (f) => setTimeout(f, 0),
    Intl, Date, Math, JSON, String, Number, Boolean, Array, Object, Set, Map,
    alert: () => {}, confirm: () => true, prompt: () => null,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        const u = String(url);
        if (u.startsWith('/calendar')) return { events: [], all_day: [] };
        if (u.startsWith('/plan/')) return { plan: null, blocks: [] };
        if (u.startsWith('/review')) return { date: '2026-07-26', blocks: [] };
        if (u.startsWith('/finance-intent/setup-prompt')) return { prompt: 'INTERVIEW' };
        if (u.startsWith('/finance-intent')) return { kinds: ['situation','reserve','target','declared','slip'], modes: ['wall','floor'], items: intentItems };
        if (u.startsWith('/finance-summary')) return summary;
        return { today: '2026-07-27', timezone: 'America/New_York', wake_time: '08:00', items: [], paused: [] };
      },
    }),
    document: { getElementById: (id) => byId[id], createElement: (t) => new El(t) },
  });

  vm.runInContext(script, ctx);
  return { ctx, byId };
}

const SUMMARY = {
  days: 60, connected: true,
  window: { from: '2026-06-29', to: '2026-07-21' },
  sync: { newest: '2026-07-21', days_ago: 6, stale: true },
  total_spend: 390.6,
  categories: [{ category: 'Work', amount: 139, count: 9 }],
  uncategorised: { amount: 0, count: 0 },
  transfers: { count: 5, moved: 1129.4, rows: [{ date: '2026-07-17', description: 'Payment', amount: 323.18 }] },
};

const INTENTS = [
  { id: '1', kind: 'situation', mode: null, label: 'Between jobs', body: 'x' },
  { id: '2', kind: 'reserve', mode: 'wall', label: 'Brokerage', body: 'y' },
  { id: '3', kind: 'declared', mode: null, label: 'Tutoring', body: 'z' },
];

(async () => {
  console.log('before setup, nothing declared');
  {
    const { ctx, byId } = boot([], SUMMARY);
    await ctx.loadIntent();
    await ctx.loadMoney();

    check('setup section shown', !byId['setup-group']._class.has('hidden'));
    check('setup card shown', !byId['setup-card']._class.has('hidden'));
    check('intent section hidden', byId['intent-group']._class.has('hidden'));
    check('setup leads', byId['setup-group'].style.order === '0', `setup ${byId['setup-group'].style.order}`);
    check('spending sits below it', byId['spending-group'].style.order === '1', `spending ${byId['spending-group'].style.order}`);
  }

  console.log('\nafter setup, rows exist');
  {
    const { ctx, byId } = boot(INTENTS, SUMMARY);
    await ctx.loadIntent();
    await ctx.loadMoney();

    check('spending leads', byId['spending-group'].style.order === '0', `spending ${byId['spending-group'].style.order}`);
    check('intent section below it', byId['intent-group'].style.order === '1');
    check('setup section hidden', byId['setup-group']._class.has('hidden'));
    check('intent section shown', !byId['intent-group']._class.has('hidden'));

    console.log('\n  collapsed by default');
    check('body hidden', byId['intent-body']._class.has('hidden'));
    check('header says it is closed', byId['intent-head'].getAttribute('aria-expanded') === 'false');
    check('count shown', byId['intent-count'].textContent === '3', byId['intent-count'].textContent);

    console.log('\n  tapping the header');
    ctx.setIntentOpen(true);
    check('body shown', !byId['intent-body']._class.has('hidden'));
    check('header says it is open', byId['intent-head'].getAttribute('aria-expanded') === 'true');
    ctx.setIntentOpen(false);
    check('closes again', byId['intent-body']._class.has('hidden'));
  }

  console.log('\nthe transfers bubble is gone from the screen');
  {
    const { ctx, byId } = boot(INTENTS, SUMMARY);
    await ctx.loadMoney();
    const rendered = byId['money-numbers'].text();

    check('no "moved between accounts"', !/moved between accounts/i.test(rendered), rendered.slice(0, 80));
    check('no transfer row', !/Payment/.test(rendered));
    check('no transfer total', !/1129/.test(rendered));
    check('the spend total is still there', /390\.60/.test(rendered));
    check('and still says transfers are excluded', /transfers excluded/i.test(rendered));
    check('categories still render', /Work/.test(rendered));
    check('sync line still renders', /synced|stale|days ago/i.test(rendered));
  }

  console.log('\nthe exclusion itself is untouched');
  {
    const money = fs.readFileSync(ROOT + '/money.js', 'utf8');
    check('findTransfers still exported', /module\.exports[\s\S]*findTransfers/.test(money));
    check('pairing window unchanged', /PAIR_WINDOW_DAYS = 4/.test(money));
    check('sheet Transfer category still honoured', /category\.toLowerCase\(\) === 'transfer'/.test(money));
    check('spending still excludes them', /const spending = rows\.filter\(\(_, i\) => !transferIdx\.has\(i\)\)/.test(money));
    check('the endpoint still returns them', /transfers: \{/.test(money));
  }

  console.log('\nno dead code left behind');
  check('signed() removed', !/const signed =/.test(script));
  check('.moved styles removed', !/\.moved \{|\.moved-head|\.moved-row/.test(html));

  console.log(bad === 0 ? '\nMoney order clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})();
