// What the page actually looks like.
//
// EVERY OTHER CHECK IN THIS PROJECT READS THE PAGE AS TEXT. That is why a
// stylesheet can pass three hundred assertions and still arrive on a phone with
// STATUS clipped off the right edge, the left margin gone, or — the worst one —
// an invisible full-screen layer over the whole app that took every touch and
// broke nothing a test could see.
//
// This renders it in a real browser at a real phone width and looks. It answers
// the questions no amount of reading the CSS can:
//
//   - is anything wider than the screen
//   - is anything clipped at either edge
//   - does every section share one gutter
//   - and how far is it from the drawing it is meant to be
//
// Chromium, not Safari, so it does not reproduce iOS text inflation or WebKit
// gesture behaviour. It closes most of the gap and it is honest about which
// part it does not.
//
//   node tests/look.js            render, measure, and diff
//   node tests/look.js --open     the same, and leave the browser open
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'shots');
const PHONE = 390; // iPhone 14/15/16 in CSS pixels
const FRAME = 352; // the width ledger.html draws its phone at

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// A day worth looking at: something finished, something running, something to
// come, two things with no hour, and a calendar with one event on it. Drawn
// from the same shapes the routes really send.
const TODAY = '2031-06-14';
const API = {
  '/config': { url: 'https://stub.supabase.co', anon_key: 'anon' },
  '/settings': {
    telegram: { set: true, hint: '…3785' },
    calendar: { set: true, hint: 'x/…/basic.ics' },
    timezone: 'America/New_York',
    wake_minutes: 540,
    wake_min: 240,
    wake_max: 720,
    wake_step: 30,
    today: TODAY,
  },
  '/entries': {
    today: TODAY,
    timezone: 'America/New_York',
    wake_time: '09:00',
    items: [
      { id: 'e1', type: 'project', title: 'UF application', size: 'a few days', due: '2031-06-20', mark: '!!!', days: 3, days_until_due: 6, last_scheduled: null, note: null, pinned: false, later: false },
      { id: 'e2', type: 'habit', title: 'Spanish call', frequency: 'daily', mark: null, days: 0, last_scheduled: TODAY, note: null, pinned: false, later: false },
      { id: 'e3', type: 'task', title: 'Return the router', mark: '!', days: 11, last_scheduled: null, note: null, pinned: false, later: false },
    ],
    saved: [],
  },
};

const PLAN = {
  plan: { date: TODAY, status: 'confirmed', wake_minutes: 540 },
  blocks: [
    { id: 'b1', title: 'Morning routine', entryId: null, start_minutes: 540, duration_minutes: 90, note: null, done: true },
    { id: 'b2', title: 'Spanish call', entryId: 'e2', start_minutes: 630, duration_minutes: 30, note: null, done: true },
    { id: 'b3', title: 'Business Intelligence', entryId: null, start_minutes: 660, duration_minutes: 240, note: null, done: true },
    { id: 'b4', title: 'Roommate Balance System', entryId: null, start_minutes: 900, duration_minutes: 60, note: null, done: true },
    { id: 'b5', title: 'Party Regulation System', entryId: null, start_minutes: 960, duration_minutes: 60, note: null, done: true },
    { id: 'b6', title: 'Parking pass', entryId: null, start_minutes: null, duration_minutes: null, note: null, done: false },
    { id: 'b7', title: 'Reading', entryId: 'e2', start_minutes: null, duration_minutes: null, note: null, done: false },
  ],
};

const CALENDAR = { date: TODAY, items: [{ title: 'Dentist', start_minutes: 780, duration_minutes: 60 }], failed: false, configured: true };

/** Answer every request the page makes, so nothing depends on a server. */
async function stub(page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === '/' || p.endsWith('.html')) return route.continue();

    // The two faces come off Google. Blocked on purpose: a render that waits on
    // a network it may not have is a render that lies about what a cold start
    // looks like. The stacks fall back to the system faces, which is what a
    // failed fetch does in the wild.
    if (url.hostname.includes('googleapis') || url.hostname.includes('gstatic')) {
      return route.abort();
    }

    const body =
      API[p] ||
      (p.startsWith('/plan/') ? PLAN : null) ||
      (p.startsWith('/calendar/') ? CALENDAR : null) ||
      {};

    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

/**
 * Everything the eye would catch and a text check cannot.
 *
 * Measured in the page rather than inferred: the browser has already done the
 * layout, so the only honest way to ask "is this clipped" is to ask it.
 */
async function measure(page, width) {
  return page.evaluate((w) => {
    const doc = document.documentElement;
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Two pixels of tolerance: a border can round outward.
      if (r.right > w + 2 || r.left < -2) {
        over.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
    }

    // Where each section's content actually starts and ends, which is the
    // question "does everything share one gutter" really asks.
    const gutters = {};
    // THE LEFTMOST AND RIGHTMOST THING IN EACH SECTION, not any thing in it.
    // A block title starts at 50 because an index column sits before it, and
    // that is the layout working — measuring it against the page gutter would
    // report the design as a fault.
    for (const [name, first, last] of [
      ['column head', '.colhead .c-i', '.colhead .c-s'],
      ['a block row', '.block .idx', '.block .st, .block .dur'],
      ['an anytime row', '.arow .atick', '.arow .atext'],
      ['things label', '.things-head .label', '.things-head .label'],
      ['day ends', '.ends span', '.ends b'],
    ]) {
      const l = document.querySelector(first);
      const r = document.querySelector(last);
      if (!l || !r) continue;
      gutters[name] = {
        left: Math.round(l.getBoundingClientRect().left),
        right: Math.round(w - r.getBoundingClientRect().right),
      };
    }

    return {
      scrollWidth: doc.scrollWidth,
      overflowing: over.slice(0, 8),
      gutters,
      blocks: document.querySelectorAll('.slot').length,
      anytime: document.querySelectorAll('.atime').length,
    };
  }, width);
}

// SERVED, NOT OPENED FROM DISK. A file:// page has an opaque origin: its
// localStorage is unavailable, so the session cannot be seeded and the gate
// stands in front of everything. It also makes every relative fetch resolve to
// a path that is not a path. One tiny static server removes both.
const serve = (dir) =>
  new Promise((done) => {
    const s = http.createServer((req, res) => {
      const f = path.join(dir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
      if (!fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      res.end(fs.readFileSync(f));
    });
    s.listen(0, () => done({ port: s.address().port, close: () => s.close() }));
  });

module.exports = { serve, stub, API, PLAN, CALENDAR, TODAY, PHONE, FRAME, ROOT, OUT };

if (require.main !== module) return;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const site = await serve(path.join(ROOT, 'public'));
  const browser = await chromium.launch();

  // --- the app -------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: PHONE, height: 900 }, deviceScaleFactor: 2 });
  // Anything the page complains about, said out loud. A render that quietly
  // draws nothing is the failure this whole tool exists to stop being silent.
  page.on('pageerror', (e) => console.log('    page error:', e.message.slice(0, 140)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('net::ERR')) console.log('    console:', m.text().slice(0, 140));
  });
  const asked = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));

  await stub(page);
  await page.addInitScript(() => {
    // A session, so the gate does not stand in front of the thing being looked
    // at. Never a real token: every request is answered by the stub above.
    localStorage.setItem(
      'pi.session',
      JSON.stringify({ access_token: 'look', refresh_token: 'look', expires_at: 4102444800, email: 'look@example.test' })
    );
  });

  await page.goto(`http://127.0.0.1:${site.port}/index.html`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'app.png'), fullPage: true });

  console.log(`the app at ${PHONE}px  (a fixed future day, so it opens on Tomorrow and nothing is running)`);
  const m = await measure(page, PHONE);

  if (m.blocks === 0) console.log('    it asked for:', [...new Set(asked)].join(' '));
  check('it drew a day', m.blocks >= 3, `${m.blocks} block rows`);
  check('and its anytime list', m.anytime >= 1, `${m.anytime} rows`);

  // NO HORIZONTAL SCROLL. This is the one that mattered: overflow is what makes
  // Safari inflate the type, so it arrives as "everything is too big" rather
  // than as "something is too wide".
  // THE BAR IS GONE AND THE SCROLLING IS NOT, asked of the browser rather than
  // of the stylesheet: `scrollbar-width: none` is a declaration, and what
  // matters is that the page still moves under a wheel.
  const scroll = await page.evaluate(async () => {
    const before = window.scrollY;
    window.scrollTo(0, 400);
    await new Promise((r) => setTimeout(r, 50));
    const after = window.scrollY;
    window.scrollTo(0, before);
    return {
      bar: window.innerWidth - document.documentElement.clientWidth,
      tall: document.documentElement.scrollHeight > window.innerHeight,
      moved: after - before,
    };
  });
  check('no scrollbar takes up room', scroll.bar === 0, `${scroll.bar}px`);
  check('and the page still scrolls', !scroll.tall || scroll.moved > 0,
    `${scroll.moved}px of ${scroll.tall ? 'a long page' : 'a short one'}`);

  check('nothing is wider than the screen', m.scrollWidth <= PHONE,
    `${m.scrollWidth} vs ${PHONE}`);
  check('and nothing hangs past either edge', m.overflowing.length === 0,
    m.overflowing.join(' | ') || 'none');

  // ONE GUTTER. Every section's content starts and ends at the same inset —
  // this is the check that would have caught the # head on the screen edge and
  // STATUS clipped off the other one, three separate times.
  const lefts = Object.values(m.gutters).map((g) => g.left);
  const rights = Object.values(m.gutters).map((g) => g.right);
  console.log('    ' + Object.entries(m.gutters).map(([k, v]) => `${k} ${v.left}/${v.right}`).join('   '));
  check('every section starts at the same inset', new Set(lefts).size === 1, lefts.join(', '));
  check('and ends at it', Math.max(...rights) - Math.min(...rights) <= 2, rights.join(', '));
  check('which is the 18px the reference uses', lefts[0] === 18, String(lefts[0]));

  // --- the day with nothing in it ------------------------------------------
  //
  // A SECOND PAGE, because the first one is a full day and the empty state is
  // the one place two rows are drawn from the same rule with different contents
  // in them. It was reported from a phone as "different sizes between the two
  // lists" and measured identical here — 45.00 both — because `.st` is a 10px
  // MONO line box that came out at 17 against the words' 18. One pixel of slack,
  // across two faces, one fetched over the network. This is what says so.
  const empty = await browser.newPage({ viewport: { width: PHONE, height: 900 }, deviceScaleFactor: 2 });
  empty.on('pageerror', (e) => console.log('    page error:', e.message.slice(0, 140)));
  await empty.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname;
    if (p === '/' || p.endsWith('.html')) return route.continue();
    // The faces are allowed through HERE, unlike everywhere else in this file:
    // the thing being measured is a line box, and the fallback face is not the
    // one the phone renders.
    if (u.hostname.includes('googleapis') || u.hostname.includes('gstatic')) return route.continue();
    const body =
      API[p] ||
      (p.startsWith('/plan/') ? { plan: null, blocks: [] } : null) ||
      (p.startsWith('/calendar/') ? { date: TODAY, items: [], failed: false, configured: true } : null) ||
      {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await empty.addInitScript(() => {
    localStorage.setItem('pi.session', JSON.stringify({
      access_token: 'look', refresh_token: 'look', expires_at: 4102444800, email: 'look@example.test',
    }));
  });
  await empty.goto(`http://127.0.0.1:${site.port}/index.html`);
  await empty.waitForTimeout(900);
  const pickTomorrow = await empty.$('#pick-tomorrow');
  if (pickTomorrow) { await pickTomorrow.click(); await empty.waitForTimeout(400); }
  await empty.screenshot({ path: path.join(OUT, 'empty.png'), fullPage: true });

  const free = await empty.evaluate(() => {
    const one = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { h: Math.round(r.height * 100) / 100, w: Math.round(r.width), left: Math.round(r.left) };
    };
    const words = (sel) => {
      const el = document.querySelector(`${sel} .freenm`);
      return el ? Math.round(el.getBoundingClientRect().left) : null;
    };
    return {
      block: one('.free-block'),
      anytime: one('.free-anytime'),
      blockWords: words('.free-block'),
      anytimeWords: words('.free-anytime'),
      rows: document.querySelectorAll('.slot').length,
    };
  });

  console.log('\nthe day with nothing in it');
  check('an empty day still draws both lists',
    Boolean(free.block) && Boolean(free.anytime),
    `${free.block ? 'block' : 'no block'} / ${free.anytime ? 'anytime' : 'no anytime'}`);

  if (free.block && free.anytime) {
    // THE ONE THAT WAS REPORTED. Equal to the pixel, not equal to within one.
    check('the two placeholders are the same height',
      free.block.h === free.anytime.h, `${free.block.h} vs ${free.anytime.h}`);
    check('and the same width', free.block.w === free.anytime.w,
      `${free.block.w} vs ${free.anytime.w}`);
    check('both reaching the screen edge',
      free.block.left === 0 && free.block.w === PHONE, `${free.block.left}..${free.block.left + free.block.w}`);

    // Each borrows its own list's leading column, so the words are NOT expected
    // to start at the same place — the table leads with a 22px index and the
    // anytime list with a 15px tick. Stated so the 5px is on purpose rather
    // than something nobody looked at.
    check('the table\'s words clear its index column', free.blockWords === 50,
      String(free.blockWords));
    check('and the anytime list\'s clear its tick', free.anytimeWords === 45,
      String(free.anytimeWords));
  }

  check('and nothing in either is a real row', free.rows === 0, `${free.rows} slots`);

  // --- the drawing it is meant to be ---------------------------------------
  const ref = await browser.newPage({ viewport: { width: FRAME + 40, height: 900 }, deviceScaleFactor: 2 });
  await ref.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await ref.route('**/fonts.gstatic.com/**', (r) => r.abort());
  await ref.goto(`http://127.0.0.1:${site.port}/ledger.html`);
  await ref.waitForTimeout(400);
  const phoneEl = await ref.$('.phone');
  if (phoneEl) await phoneEl.screenshot({ path: path.join(OUT, 'reference.png') });

  console.log(`\nthe reference, drawn at ${FRAME}px`);
  check('ledger.html is here to compare against', Boolean(phoneEl));

  // THE TYPE, SIDE BY SIDE. Not a pixel diff — the two frames are different
  // widths, so a pixel diff would report the difference between 352 and 390 and
  // call it a design fault. What is comparable is the SHARE of the frame a
  // thing takes: a title is a title whatever the phone is.
  const share = async (p, sel, w) =>
    p.evaluate(([s, width]) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round((r.height / parseFloat(getComputedStyle(el).fontSize)) * 100) / 100;
    }, [sel, w]);

  const sizes = async (p, pairs) => {
    const out = {};
    for (const [name, sel] of pairs) {
      out[name] = await p.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? parseFloat(getComputedStyle(el).fontSize) : null;
      }, sel);
    }
    return out;
  };

  // The label sample is Things', not the anytime list's: that heading is gone,
  // and both were the same `.label` type in any case.
  const appType = await sizes(page, [['title', '.block .t'], ['time', '.block .time'], ['status', '.block .st'], ['index', '.idx'], ['label', '.things-head .label']]);
  const refType = await sizes(ref, [['title', '.nm'], ['time', '.tm'], ['status', '.st'], ['index', '.idx'], ['label', '.any .cap8']]);

  console.log('\ntype, as a share of the frame it is drawn in');
  for (const k of Object.keys(refType)) {
    if (appType[k] == null || refType[k] == null) continue;
    // The reference is drawn narrower, so the same look means a larger number.
    const want = Math.round(refType[k] * (PHONE / FRAME) * 10) / 10;
    const got = appType[k];
    const off = Math.round(Math.abs(got - want) * 10) / 10;
    check(`${k}: ${got}px against ${want}px`, off <= 0.8, off ? `${off}px out` : 'matches');
  }

  console.log(`\nwritten to tests/shots/`);
  if (process.argv.includes('--open')) await page.waitForTimeout(600000);
  await browser.close();
  site.close();

  console.log(bad === 0 ? '\nLooks right' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('could not look:', e.message);
  process.exit(1);
});
