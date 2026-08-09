// Does the page answer a finger?
//
// THE BUG THIS EXISTS FOR rendered perfectly and could not be touched. A swipe
// backing — `position: absolute; inset: 0`, invisible at `opacity: 0` and still
// hit-testable — lost the positioned ancestor it anchored to and covered the
// whole viewport. Every suite passed. The screenshot pass would pass too: the
// page LOOKS right, because the thing over it cannot be seen.
//
// So this asks the only question that catches it: when you press where a row
// is, what does the browser say you pressed?
//
//   node tests/touch.js
const { chromium } = require('playwright');
const path = require('path');
const { serve, stub, PHONE, ROOT } = require('./look');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

/** A real drag, in pointer events, the way the page listens for them. */
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // In steps, because the handlers decide what a gesture IS on the first move
  // past the slop and hold to it after.
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
  }
  await page.mouse.up();
}

const boxOf = async (page, sel, n = 0) =>
  page.evaluate(([s, i]) => {
    const el = document.querySelectorAll(s)[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, [sel, n]);

(async () => {
  const site = await serve(path.join(ROOT, 'public'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: PHONE, height: 900 }, hasTouch: true });
  page.on('dialog', (d) => d.accept('written by a finger'));
  await stub(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'pi.session',
      JSON.stringify({ access_token: 'touch', refresh_token: 'touch', expires_at: 4102444800, email: 'touch@example.test' })
    )
  );
  await page.goto(`http://127.0.0.1:${site.port}/index.html`);
  await page.waitForTimeout(900);

  console.log('what is actually under your finger');
  {
    // THE CHECK THAT WOULD HAVE CAUGHT IT. Not "is a row there" — a row was
    // there, drawn correctly, the whole time — but "if you press where the row
    // is, does the browser hand the press to the row".
    const rows = await page.evaluate(() => {
      const out = [];
      for (const [name, sel] of [
        ['a block', '.block'],
        ['an anytime row', '.arow'],
        ['a things row', '.row'],
        // By id: 'confirm' is also a class on the setup sheet's own button, which
        // is inside a hidden panel and measures 0x0 — querySelector finds that
        // one first and reports the visible button as unreachable.
        ['the confirm button', '#confirm'],
        ['+ block', '#add-block'],
      ]) {
        const el = document.querySelector(sel);
        if (!el) { out.push([name, 'not drawn', false]); continue; }
        // Into view first. `elementFromPoint` only answers about the viewport,
        // so anything below the fold reports 'nothing' — which is the harness
        // being unable to look, not the page being unable to answer.
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const mine = hit === el || el.contains(hit);
        out.push([name, mine ? 'itself' : `${hit ? hit.tagName.toLowerCase() + '.' + (hit.className || '').toString().split(' ')[0] : 'nothing'}`, mine]);
      }
      return out;
    });

    for (const [name, got, ok] of rows) check(`pressing ${name} reaches ${name}`, ok, got);
  }

  console.log('\nand what the press does');
  {
    const before = await page.evaluate(() => document.querySelectorAll('.slot').length);
    const box = await boxOf(page, '.block', 3);
    await drag(page, { x: box.x + 90, y: box.y }, { x: box.x - 120, y: box.y });
    await page.waitForTimeout(400);

    const after = await page.evaluate(() => document.querySelectorAll('.slot').length);
    check('swiping a block left takes it out of the day', after === before - 1, `${before} -> ${after}`);
    check('and offers the undo',
      await page.evaluate(() => Boolean(document.querySelector('.undo'))));
  }

  {
    // THE LAST BLOCK, and the reason matters: a block that has BEGUN refuses
    // the right swipe on purpose — a note says what you are about to do, so it
    // is fixed once the block starts. The fixture's hours are fixed and the
    // real clock is not, so picking the first block made this pass in the
    // morning and fail in the evening. The last one is the one least likely to
    // have started.
    const n = await page.evaluate(() => document.querySelectorAll('.block').length);
    const box = await boxOf(page, '.block', n - 1);
    await drag(page, { x: box.x - 90, y: box.y }, { x: box.x + 120, y: box.y });
    await page.waitForTimeout(300);
    // ANSWERED, NOT DISMISSED. A note is asked for in the browser's own dialog
    // now, and Playwright dismisses those by default — so without this the
    // gesture works, prompt() returns null, and the check reads as a page that
    // ignored the swipe.
    check('swiping one right writes its note',
      await page.evaluate(() => Boolean(document.querySelector('.note'))),
      await page.evaluate(() => (document.querySelector('.note') || {}).textContent || 'none'));
  }

  {
    // The tick, which is a button inside a row that also takes gestures — the
    // one place a press has to reach past the row it sits on.
    const ticked = await page.evaluate(async () => {
      const tick = document.querySelector('.arow .atick');
      if (!tick) return 'no tick';
      tick.click();
      await new Promise((r) => setTimeout(r, 250));
      return document.querySelector('.arow').classList.contains('did') ? 'ticked' : 'nothing happened';
    });
    check('the anytime tick answers a press', ticked === 'ticked', ticked);
  }

  {
    // A FRESH PAGE FIRST. A committed swipe deliberately swallows the click
    // that follows it — otherwise a swipe begun on the chip would also lengthen
    // the block on its way out — and two swipes have just run. Reloading tests
    // the chip rather than the swallow.
    await page.reload();
    await page.waitForTimeout(900);

    const chip = await boxOf(page, '.dur', 0);
    if (chip) {
      const was = await page.evaluate(() => document.querySelector('.dur').textContent);
      await page.mouse.click(chip.x, chip.y);
      await page.waitForTimeout(200);
      const now = await page.evaluate(() => document.querySelector('.dur').textContent);
      check('the duration chip cycles', was !== now, `${was} -> ${now}`);
    }
  }

  console.log('\nand nothing is scrolling sideways under it');
  check('no horizontal scroll after all that',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await browser.close();
  site.close();

  console.log(bad === 0 ? '\nIt answers' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('could not touch:', e.message);
  process.exit(1);
});
