// The screen's structure, checked against the stylesheet and markup.
//
// Every rule the mockup demonstrates, pinned so it cannot come back quietly.
// These are not preferences: each one is a distinction the screen makes with
// colour or shape, and a violation reads as the screen saying something it
// does not mean — a decorative thing looking actionable, a list looking like a
// stack of cards, a section boundary drawn twice.
//
// No database and no network: this reads the page as shipped.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');

// The stylesheet with its comments stripped, for the same two reasons the
// markup and the script are:
//
// A rule is found by reading the text before its `{` as a selector list, and a
// comment sitting above a rule is part of that text — so `#booting span` was
// being read as "…not saying. */ #booting span", which matches nothing anyone
// would look up. Every rule in this file carries a paragraph above it, so this
// is not an edge case.
//
// And several checks assert that a removed thing is not mentioned, while the
// comments explain at length what was removed and why.
const rawCss = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));

const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Does the stylesheet parse at all?
 *
 * THIS FILE STRIPS COMMENTS, so it is structurally blind to damage done to
 * one. Closing a comment early leaves prose sitting loose between rules and a
 * second `*​/` after it; the regex above pairs the markers the wrong way,
 * removes a different span than the browser would, and every check downstream
 * goes on reading a stylesheet that looks fine. The browser does not: it drops
 * rules until it can recover, and the page comes back half-styled.
 *
 * That shipped. The whole day rendered as plain text under a heading with
 * letter-spacing — enough CSS to look deliberate, not enough to be the app.
 *
 * So this walks the real text before anything is stripped, and it runs first.
 */
function cssDamage(text) {
  let inComment = false;
  let depth = 0;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') line++;

    if (inComment) {
      if (text[i] === '*' && text[i + 1] === '/') {
        inComment = false;
        i++;
      }
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '*') {
      inComment = true;
      i++;
      continue;
    }
    // A comment that was closed twice, or prose that was never opened.
    if (text[i] === '*' && text[i + 1] === '/') return `line ${line}: a */ outside a comment`;

    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth < 0) return `line ${line}: a } with nothing open`;
    }
  }

  if (inComment) return 'a comment is never closed';
  if (depth !== 0) return `${depth} rule(s) left open`;
  return null;
}

const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// The markup alone. The <script> lives inside <body>, so slicing to </body>
// and calling it markup meant every "gone from the markup" check was really
// reading the script as well — and passing or failing for the wrong reason.
//
// HTML comments go too, for the same reason the script's comments do below:
// several checks assert that a removed feature is not mentioned, and the
// markup explains at length which features were removed and why. A comment
// saying the cold list used to sit here would fail the check that says the
// cold list is gone.
// EVERY script element, not just the first and not just the bare ones. The
// page carries a second one now — `<script type="text/plain">` holding the
// setup prompt, which the browser will not run and which exists to be copied.
// It is prose, and it was being read as markup: the prompt says "a paused
// conversation" and "Why:", so the checks that prove the pause feature and the
// why field are gone both failed on an English sentence in a text box.
const body = html
  .slice(html.indexOf('<body>'), html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

// The script with its comments stripped. Several checks below assert that a
// removed feature is not mentioned, and this file explains at length which
// features were removed and why. Reading the raw text would fail precisely
// because the reasoning was written down.
const code = script
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// One rule's declarations, by selector.
//
// Grouped selectors count. `#booting span, .waiting span { … }` is one rule
// answering for both, and looking only for `#booting span {` found nothing —
// so a check would report the property missing when it was simply shared.
// Silent, and in the direction that reads as a real failure.
const rule = (selector) => {
  const at = css.indexOf(`\n      ${selector} {`);
  if (at !== -1) return css.slice(at, css.indexOf('\n      }', at));

  // A group: the selector is one of a comma-separated list. Returns the whole
  // rule, selectors included, which is what the direct hit above returns —
  // two shapes from one helper would have callers comparing unlike things.
  for (const m of css.matchAll(/\n {6}([^{@\n][^{]*?)\{([^}]*)\}/g)) {
    const names = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (names.includes(selector)) return m[0];
  }
  return '';
};

// Every rule whose declarations mention a value, by selector. Used to prove a
// colour appears only where it is allowed to.
function selectorsUsing(value) {
  const out = [];
  const re = /\n {6}([^{@\n][^{]*?)\{([^}]*)\}/g;
  for (const m of css.matchAll(re)) {
    if (m[2].includes(value)) out.push(m[1].trim().replace(/\s+/g, ' '));
  }
  return out;
}

// THE PALETTE, declared once for the whole file.
//
// Section 1 grades it for contrast and section 17 checks the mockup carries
// the same inks. Written out in both places it drifted the first time the
// theme moved: eight checks went on reporting failures about colours neither
// file still contained.
// NEUTRAL AND LIGHT. It was cream paper and ink, with a fibre texture, torn
// edges and two warm inks — a look chosen when this was a notebook. It is a
// planner you open several times a day to answer "what now", and the answer has
// to be the loudest thing on the screen, which it is not when the screen is
// being something.
//
// Nothing here is a colour that is not doing work: a near-white page, greys that
// differ enough to rank, one blue for what can be pressed, one red for what is
// running out.
const want = {
  '--bg': '#ffffff',
  '--tint': '#f4f7fc',
  '--text': '#0f1620',
  '--muted': '#5c6b7f',
  '--faint': '#97a3b4',
  '--ghost': '#c3ccd8',
  '--line': '#e6ebf1',
  '--rule': '#cfd8e3',
  '--accent': '#1e4fd8',
  '--warn': '#dc2626',
};

// FOUR GREYS, NOT THREE, and the fourth is the reason to say so. `ghost` is
// lighter than anything a contrast bar would pass, and it is allowed to be: it
// carries the index column and the state of a row that is already over —
// figures you count down, never words you read. It is checked for being the
// lightest of the four rather than for a ratio it is not asked to meet.

console.log('0. the stylesheet parses');
{
  // FIRST, because every other check in this file reads the stylesheet through
  // a comment-stripping regex and would go on passing against one the browser
  // throws half of away. See cssDamage.
  const damage = cssDamage(rawCss);
  check('nothing is broken open or left open', damage === null, damage || '');
}

console.log('\n0b. one gutter, and nothing wider than the phone');
{
  // THE MARGIN IS ON ONE CONTAINER. It was a horizontal padding on ten separate
  // elements plus a margin on two more, and those behave differently the moment
  // anything overflows — which is exactly what happened: on iOS the labels,
  // + BLOCK, + ANYTIME and DAY ENDS lost their gutter while the table rows kept
  // theirs, and the whole page was 1.6x too large with the DAY ENDS figure
  // clipped off the right edge.
  //
  // Desktop rendered it correctly at the same width, which is the tell. Safari
  // INFLATES TEXT on any page it decides is not mobile-optimised, and
  // horizontal overflow is one of the things that decides it. So the sizes were
  // never wrong; something was too wide, and the type scale was the symptom.
  check('the page carries the only gutter',
    /padding: 18px 18px /.test(rule('main')), rule('main').replace(/\s+/g, ' '));
  // Except the three section rules, which do the same trade a row does: out
  // past the margin so the line reaches the edge, then padding to put their
  // contents back on the gutter. A division that stops 18px short of the paper
  // reads as the top of a box rather than the end of a section.
  // `.free` is the space where a row would go, and it bleeds for the reason a
  // row does rather than the reason a section rule does: hatching that stopped
  // at the gutter would draw a box on the page instead of a band across it.
  const bleeders = ['.colhead', '.anytime', '.things-head', '.free'];
  for (const sel of bleeders) {
    const r = rule(sel);
    check(sel + ' reaches the edge', /margin-left: -18px/.test(r), r.replace(/s+/g,' ').slice(0,70));
    check('  and puts its contents back', /padding-left: 18px/.test(r));
  }
  // Day ends bleeds too now: the rule that ends the day reaches both edges the
  // way every other section rule does.
  check('day ends reaches the edge as well',
    /margin-left: -18px/.test(rule('.ends')) && /padding-left: 18px/.test(rule('.ends')),
    rule('.ends').replace(/\s+/g, ' ').slice(0, 70));
  check('and nothing else carries a gutter of its own',
    (css.match(/padding-left: 18px/g) || []).length === bleeders.length + 1,
    String((css.match(/padding-left: 18px/g) || []).length));

  // A row reaches the edge by pulling itself back out of that padding. This is
  // the one place the number appears twice, and they have to stay equal.
  // Read out of the sheet directly: a lookup by name finds the plain `.slot`
  // rule, which is the one that does NOT carry this.
  const bleed = (css.match(/\.slot,\s*\.thing,\s*\.atime \{[^}]*/) || [''])[0];
  check('rows pull back out to the edge',
    /margin-left: -18px/.test(bleed) && /margin-right: -18px/.test(bleed), bleed);
  check('and put their contents back on the gutter',
    /padding: \d+px 18px/.test(rule('.block')) && /padding: 0 18px/.test(rule('.arow')));

  // OFF EXPLICITLY. Without this, the inflation returns the next time anything
  // overflows by a pixel — and it returns as "the type scale is wrong", which
  // is three steps from the cause.
  check('text inflation is refused', /-webkit-text-size-adjust: 100%/.test(css));
  check('and by the standard property too', /[^-]text-size-adjust: 100%/.test(css));

  // Nothing may be wider than what holds it. A flex child's default min-width
  // is auto, which is why a long title pushed a row past the viewport instead
  // of wrapping inside it.
  check('no flex child refuses to shrink', /min-width: 0;/.test(rule('*')), rule('*'));

  // AND THE MOCKUP'S PHONE FRAME IS NOT IN HERE. It was 352px wide, and a fixed
  // width copied out of it is the first thing that would overflow a 390px
  // screen once the gutters are added.
  check('no phone frame came across from the mockup',
    !/width: 352px/.test(css) && !/\.phone/.test(css));

  // Pinch-zoom belongs to whoever needs it. maximum-scale and user-scalable=no
  // were on the viewport and do not prevent the inflation above — that is a
  // different mechanism — so they were costing accessibility for nothing.
  check('the viewport is device width at scale one',
    /width=device-width,\s*initial-scale=1,\s*viewport-fit=cover/.test(html));

  // NO PINCH. This is meant to feel installed rather than browsed.
  //
  // The flags are not enough on their own: iOS Safari has ignored
  // `user-scalable=no` since iOS 10, deliberately, so that a page cannot take
  // zoom from someone who needs it. They are there for the browsers that honour
  // them, and WebKit's gesture events are what actually stop a pinch on a
  // phone. Both, or it works on a desktop and not on the device it is for.
  check('and asks for no scaling', /maximum-scale=1/.test(html) && /user-scalable=no/.test(html));
  check('which is not enough on its own, so the gestures are refused too',
    /gesturestart/.test(code) && /gesturechange/.test(code));
  check('refused on the document, since a pinch can start anywhere',
    /document\.addEventListener\(kind/.test(code));
  check('and non-passively, or preventDefault does nothing',
    /passive: false/.test(code));

  // It must not reach for a touch event to do this. The rows arbitrate a swipe
  // against a scroll with touch handlers, and that arbitration was expensive.
  check('and it does not touch the swipe arbitration',
    !/gesturestart[\s\S]{0,200}touchstart/.test(code));

  // So it does not stretch on a tablet.
  check('and it stops widening at 480', /max-width: 480px/.test(rule('main')));
}

console.log('\n0c. a section rule, its label, and the rows under it');
{
  // ONE RELATIONSHIP, IN THREE PLACES:
  //
  //   section rule → 14px → label → 7px → first row
  //
  // The label belongs to the rows below it rather than to the rule above, so
  // the space under it is the smaller of the two. Equal gaps leave it floating
  // between the two things it exists to bind, and no gap at all — which is what
  // ANYTIME TODAY had — reads as a caption stuck to the underside of a line.
  const RULE_TO_LABEL = 14;
  const LABEL_TO_ROW = 7;

  check(`a label sits ${LABEL_TO_ROW}px above its first row`,
    new RegExp(`margin-bottom: ${LABEL_TO_ROW}px`).test(rule('.label')), rule('.label'));

  // Things keeps the relationship: a rule, 14px, then its label.
  check('the things list\'s label is 14px below its rule',
    new RegExp(`padding-top: ${RULE_TO_LABEL}px`).test(rule('.things-head')),
    rule('.things-head').replace(/\s+/g, ' ').slice(0, 80));

  // THE ANYTIME LIST HAS NO LABEL, so it has no such gap to keep. It read
  // "Anytime today · 00" — a name for a section already named by the + Anytime
  // at its foot, and a count already given by the rows themselves. What the
  // heading left behind was 14px of nothing above the first row, so the rule is
  // now the row's top edge, exactly as it is under the column heads.
  {
    const r = rule('.anytime');
    check('the anytime list is under a section rule',
      /border-top: 1\.5px solid var\(--heavy\)/.test(r), r.replace(/\s+/g, ' ').slice(0, 60));
    check('  and its first row sits flush against it',
      /padding-top: 0;/.test(r), r.replace(/\s+/g, ' ').slice(0, 80));
    check('  with no heading left to space away from',
      !/id="anytime-label"/.test(body) && !/anytime-label/.test(code),
      /anytime-label/.test(body + code) ? 'still referenced' : 'gone');
  }

  // THE COLUMN HEAD IS THE SAME RELATIONSHIP INVERTED: its label sits ABOVE its
  // rule, because the rule is the top of the table rather than the top of a
  // section. Six px, and tighter than the 14 for the same reason the 7 is
  // tighter than the 14 — the label is bound to the thing it names.
  check('the column head sits above its rule',
    /border-bottom: 1\.5px solid var\(--heavy\)/.test(rule('.colhead')));
  check('  with 6px between them',
    /padding-bottom: 6px/.test(rule('.colhead')), rule('.colhead').replace(/\s+/g, ' '));

  // And the three rules are the same weight, because they are the same kind of
  // division: the end of one part of the page and the start of another.
  const heavy = (css.match(/border-(top|bottom): 1\.5px solid var\(--heavy\)/g) || []).length;
  check('three sections, three rules of one weight', heavy >= 3, `${heavy}`);
}

console.log('\n0a. nothing absolute is left without an anchor');
{
  // THE BUG THIS EXISTS FOR, and it is the worst kind this file has caught.
  //
  // `.backing` is `position: absolute; inset: 0` — the surface a row slides off
  // to reveal. It anchors to its nearest POSITIONED ancestor, and when anytime
  // rows gained a swipe, their wrapper did not gain a `position: relative` with
  // it. So the backing walked past every ancestor to the viewport and covered
  // the entire screen.
  //
  // It has `opacity: 0` and is still hit-testable, so NOTHING LOOKED WRONG. The
  // app rendered perfectly and stopped responding to touch: no error, no
  // console, no failing test. Every suite passed. It reached a phone.
  //
  // Refresh went on working, which was the clue that found it: it sits after
  // that section in the document, so it painted on top of the invisible layers
  // while everything before them — the blocks, the calendar, Confirm — sat
  // underneath.
  //
  // The rule is general: an element that fills its ancestor must be told which
  // ancestor, or it fills the window.
  const anchored = [
    ['.slot', 'a block'],
    ['.thing', 'a things row'],
    ['.atime', 'an anytime row'],
  ];
  for (const [sel, what] of anchored) {
    const r = rule(sel);
    check(`${what} positions its own backing`,
      /position: relative/.test(r), `${sel}: ${r.replace(/\s+/g, ' ').slice(0, 60)}`);
  }

  // AND EVERY OTHER FULL-BLEED ABSOLUTE ON THE PAGE, found rather than listed.
  // Each one is named here with the thing that must position it, so a new one
  // cannot be added without an answer to "anchored to what".
  const fills = [...css.matchAll(/\n {6}([^{@\n][^{]*?)\{([^}]*position:\s*absolute[^}]*)\}/g)]
    .filter((m) => /inset:\s*0/.test(m[2]))
    // The selector alone. The match runs back into the tail of whatever rule
    // came before it, so what is wanted is the part after the last brace.
    .map((m) => m[1].split('}').pop().trim().replace(/\s+/g, ' '));

  const known = {
    '.backing': '.slot / .thing / .atime',
    '.tzpick': '.tzrow',
    '.undo::after': '.undo',
  };
  for (const sel of fills) {
    check(`${sel} is anchored on purpose`, Boolean(known[sel]),
      known[sel] || 'NOT NAMED — what positions this?');
  }
  check('and the ones that position them say so',
    /position: relative/.test(rule('.tzrow')) && /position: fixed/.test(rule('.undo')));
}

console.log('\n0d. no shorthand quietly undoes a longhand above it');
{
  // `padding-left: 18px` then `padding: 0 0 6px` four lines later is zero on the
  // left, and CSS says so without complaining. That is what put the # column
  // head hard on the screen edge and clipped STATUS off the other one, while
  // every check in this file went on passing — they read the longhand, which
  // was there, and never asked whether anything below it took it back.
  //
  // A margin shorthand did the same to the negative margins that make a rule
  // reach the edge. Two rules, one mistake, and it is the third time a
  // stylesheet detail has been invisible to a checker reading declarations one
  // at a time.
  const PAIRS = [['padding', ['padding-left', 'padding-right', 'padding-top', 'padding-bottom']],
                 ['margin', ['margin-left', 'margin-right', 'margin-top', 'margin-bottom']]];

  const offenders = [];
  for (const m of css.matchAll(/\n {6}([^{@\n][^{]*?)\{([^}]*)\}/g)) {
    const selector = m[1].split('}').pop().trim().replace(/\s+/g, ' ');
    const body = m[2];
    for (const [short, longs] of PAIRS) {
      const at = body.search(new RegExp(`(^|;|\\s)${short}:`));
      if (at === -1) continue;
      for (const long of longs) {
        const lat = body.indexOf(long + ':');
        // A longhand ABOVE a shorthand of the same family is overwritten by it.
        if (lat !== -1 && lat < at) offenders.push(`${selector}: ${long} then ${short}`);
      }
    }
  }

  check('nothing states a side and then takes it back',
    offenders.length === 0, offenders.join(' | ') || 'none');

  // And the three that were wrong, by name, so the fix cannot be undone by
  // reformatting.
  for (const sel of ['.colhead', '.anytime', '.things-head']) {
    const r = rule(sel);
    check(`${sel} keeps its gutter`, /padding-left: 18px/.test(r), r.replace(/\s+/g, ' ').slice(0, 80));
    check(`  and its bleed`, /margin-left: -18px/.test(r), r.replace(/\s+/g, ' ').slice(0, 80));
  }
}

console.log('\n0f. a note sits under the title it belongs to');
{
  // A note is appended to the CARD, so it began at the card's own padding while
  // the title began past the index column — 32px to its left, which reads as a
  // second column nobody asked for.
  //
  // Written as the sum it is rather than as 32, so it cannot drift from the
  // column it clears: the index is 22px wide and the row's gap is 10.
  const indent = /margin-left: calc\(22px \+ 10px\)/;
  check('a block note clears the index column', indent.test(rule('.note')), rule('.note'));
  // The field that edited one in the page is gone — a note is asked for in the
  // browser now — so the indent is only wanted on the note that is drawn.
  check('and those are the two numbers it is clearing',
    /width: 22px/.test(rule('.idx')) && /gap: 10px/.test(rule('.brow')));

  // The anytime editor went BESIDE its title rather than under it: .arow is a
}

console.log('\n0g. the scrollbar is hidden and the scrolling is not');
{
  // An installed app has no chrome, and a bar down the right edge is the one
  // piece of browser left showing. On a phone it is already an overlay that
  // fades; this is about the desktop, where it sits there permanently.
  //
  // ONLY THE INDICATOR GOES. The dangerous version of this change is the one
  // that reaches for `overflow: hidden` and takes the scrolling with it — the
  // page then looks right and the bottom half is unreachable, which is a thing
  // you find by scrolling rather than by looking.
  check('the bar is hidden', /scrollbar-width: none/.test(css));
  check('in every engine', /-ms-overflow-style: none/.test(css) &&
    /::-webkit-scrollbar \{ display: none/.test(css));
  check('and nothing hides the overflow itself',
    !/overflow:\s*hidden/.test(rule('html, body, #gate, .page, .sheet, .scrim')) &&
      !/overflow-y:\s*hidden/.test(css));
  check('the surfaces that scroll still say so',
    (css.match(/overflow-y: auto/g) || []).length >= 3);

  // ON ONE LINE, and that is not a style choice. A selector group listed down
  // the page ends on a line reading `.page {`, which is exactly what a lookup
  // by name finds first — four bugs in this file have come from that. On one
  // line there is no such line to find.
  check('the group is one line, so it shadows no rule by name',
    /html, body, #gate, \.page, \.sheet, \.scrim \{[^\n]*\}/.test(css));
  check('and .page still resolves to its own rule',
    /position: fixed/.test(rule('.page')), rule('.page').slice(0, 40));
}

console.log('\n1. the palette is exactly the one specified');
{
  const root = rule(':root');
  for (const [name, value] of Object.entries(want)) {
    check(`${name} is ${value}`, new RegExp(`${name}:\\s*${value}\\s*;`, 'i').test(root));
  }

  // AND THE SPEC SAYS THE SAME EIGHT, which it did not.
  //
  // Its table still listed the dark build — #16130F paper, a #6E8CB8 blue —
  // long after the theme became washi, so the one document anybody would read
  // to answer "what colour is this app" answered with the colours of a build
  // that no longer exists. Nothing went red, because nothing was comparing
  // them: the mockup was pinned to the page and the prose was pinned to
  // nothing.
  //
  // Checked by value rather than by table row. The spec is prose and its shape
  // is allowed to change; what is not allowed is a hex in it that the page has
  // never heard of.
  const spec = fs.readFileSync(ROOT + '/SPEC.md', 'utf8');
  const look = spec.slice(spec.indexOf('## 7. The look'));
  const inks = new Set(Object.values(want).map((v) => v.toLowerCase()));
  // One exception, named rather than exempted by pattern: the reference's own
  // faint, quoted in the prose that explains why the page does not use it. A
  // sweep that refused it would be refusing the sentence that gives the reason.
  const explained = new Set(['#97a3b4']);
  const strays = [...look.matchAll(/#[0-9a-fA-F]{6}\b/g)]
    .map((m) => m[0].toLowerCase())
    .filter((hex) => !inks.has(hex) && !explained.has(hex));

  check('and the spec names no colour the page does not have',
    strays.length === 0, [...new Set(strays)].join(', '));

  for (const [name, value] of Object.entries(want)) {
    check(`the spec's table has ${name}`, new RegExp(value, 'i').test(look), value);
  }

  // CONTRAST. It was the failure the paper theme was most prone to — a warm
  // ground eats contrast, and the reference it came from was illegible at
  // 3.8:1. A white page is far more forgiving, which is a reason to keep
  // checking rather than to stop: nothing here is a colour anybody had to fight
  // for, so nothing stops one drifting lighter for the look of it.
  //
  // WCAG relative luminance, then the contrast ratio against the paper.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const against = (hex, bg = '#ffffff') =>
    (Math.max(lum(hex), lum(bg)) + 0.05) / (Math.min(lum(hex), lum(bg)) + 0.05);

  const ratio = (hex) => Math.round(against(hex) * 10) / 10;

  // Read out of the STYLESHEET, not out of the map above.
  //
  // Grading the expected value only ever proves the constant in this file is
  // legible. It happens to be equivalent while the equality checks above pass
  // — but the moment they fail, every ratio below would be quietly grading a
  // colour the page had stopped using, and reporting it as fine.
  const ink = (name) => {
    const found = root.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'));
    if (!found) throw new Error(`${name} is not declared in :root`);
    return found[1].toLowerCase();
  };

  check('body ink clears 4.5:1 on the paper',
    against(ink('--text')) >= 4.5, `${ratio(ink('--text'))}:1`);
  check('and the secondary ink does too, which is what the reference missed',
    against(ink('--muted')) >= 4.5, `${ratio(ink('--muted'))}:1`);
  check('the blue clears it, because it carries words and not just lines',
    against(ink('--accent')) >= 4.5, `${ratio(ink('--accent'))}:1`);
  check('and the red does, as a mark on the page',
    against(ink('--warn')) >= 4.5, `${ratio(ink('--warn'))}:1`);
  // Confirm is white on blue now rather than paper on persimmon. Same question:
  // the pair has to clear the bar both ways round.
  check('and the confirm clears it the other way, white on blue',
    against(ink('--bg'), ink('--accent')) >= 4.5,
    `${Math.round(against(ink('--bg'), ink('--accent')) * 10) / 10}:1`);
  // FAINT IS 2.6:1, AND IT IS SPECIFIED. It was darkened once to clear 3:1 and
  // put back by hand afterwards, so it is a decision rather than an oversight —
  // which is the only reason this is a note and not a failure.
  //
  // What keeps it defensible is what it is allowed to carry: the times on rows
  // that are already over, and the status column. Never a title, never a body
  // size, never the only copy of anything. The check below is what holds that
  // line — if faint ever reaches a title, this stops being a note.
  check('faint carries no title', !/color: var\(--faint\)/.test(rule('.block .t')),
    rule('.block .t'));
  check('nor a things row title', !/color: var\(--faint\)/.test(rule('.row .title')),
    rule('.row .title'));
  check('and it is lighter than the grey that does carry words',
    lum(ink('--faint')) > lum(ink('--muted')));

  // THE THREE GREYS HAVE TO RANK. Text, then muted, then faint: if two of them
  // land close enough to read as one, the page has three registers and shows
  // two, and every "quieter than" decision in this file stops meaning anything.
  const step = (a, b) => Math.abs(lum(ink(a)) - lum(ink(b)));
  check('muted is plainly lighter than text', step('--text', '--muted') > 0.08,
    `${Math.round(step('--text', '--muted') * 1000) / 1000}`);
  check('and faint plainly lighter than muted', step('--muted', '--faint') > 0.08,
    `${Math.round(step('--muted', '--faint') * 1000) / 1000}`);

  // Nothing under 15px may be lighter than 400. The reference set 11px meta at
  // weight 300 on a textured ground, which is the other half of why it was
  // hard to read.
  check('nothing small is set at weight 300', !/font-weight:\s*300/.test(css),
    (css.match(/.*font-weight:\s*300.*/) || [''])[0].trim());
}

console.log('\n2. one label style, and the action is quieter than it');
{
  const label = rule('.label');
  // Smaller and tracked wider than the dark build. Letterspacing is how a
  // printed page makes a word quieter without making it fainter, which is the
  // trade this theme keeps having to make.
  // MONO CAPITALS, which is what heads a column in a ledger. Set in the same
  // face as every figure on the page, so a section heading and the numbers
  // under it belong to one another.
  check('9.5px', /font-size: 9.5px/.test(label));
  check('uppercase', /text-transform: uppercase/.test(label));
  check('0.2em tracking', /letter-spacing: 0\.2em/.test(label));
  check('in the mono face, like the figures it heads',
    /font-family: var\(--mono\)/.test(label));
  check('and set at 500, because 400 disappears at this size',
    /font-weight: 500/.test(label));
  check('muted, because a label names what is under it',
    /color: var\(--muted\)/.test(label));

  // Baseline, so the action sits on the label's line rather than centred
  // against a taller box.
  // The label is a column head now: the action beside it sits on the same
  // line, and the line box is the label's own.
  check('the action sits on its line',
    /align-items: (baseline|center)/.test(label) || /display: flex/.test(label), label);

  const act = rule('.label .act');
  check('the action drops the uppercase', /text-transform: none/.test(act));
  check('and the tracking', /letter-spacing: 0;/.test(act));
  check('so it cannot read as a second heading',
    !/font-weight: (6|7|8|9)00/.test(act), act.match(/font-weight[^;]*/) || '');

  // The whole point. A bolder or brighter action would make "+ Add" the
  // loudest thing in the section, which is backwards.
  check('it is never brighter than the label',
    !/color: var\(--text\)/.test(act), act.match(/color[^;]*/) || '');
}

console.log('\n3. everything is a row, and nothing is a card');
{
  const row = rule('.row');
  const divider = rule('.thing + .thing');

  // A ROW IS OPAQUE NOW, AND ONLY THAT. It slides aside to show a backing, and
  // a transparent row would let the word underneath read straight through the
  // title. The page's own colour is the whole of what is allowed: `--card` here
  // would be the thing this section exists to refuse, because a row wearing the
  // slip's colour is a row claiming to be a slip.
  const paper = (row.match(/background:[^;]*/) || [''])[0];
  check('a row is opaque in the page colour, or in nothing',
    !paper || /background:\s*var\(--bg\)/.test(paper), paper);
  check('never in a card colour', !/var\(--card/.test(row), row);
  check('nor a radius', !/border-radius/.test(row), row);

  // The hairline moved off the row and onto the slot that holds it, and that
  // is load-bearing rather than tidy: a divider travelling with the row would
  // make the whole list look like it was coming apart under one finger.
  // THE HAIRLINE IS ON THE ROW, like every other row on the page. It used to
  // sit on the slot that holds it, so a row sliding under a finger did not take
  // its own divider with it — which mattered when a row was the only thing on
  // the page that moved. Everything is a ruled row now, and one rule that lives
  // in a different place from all the others is the thing that drifts.
  check('every things row is ruled underneath',
    /border-bottom: 1px solid var\(--line\)/.test(row), row);
  check('and ruled nowhere else', !/border-top|border-left|border-right/.test(row), row);
  check('the old slot divider is gone, not merely unused',
    !/\.thing \+ \.thing/.test(css));

  // AND NOTHING CARD-LIKE UNDER ONE EITHER, which is the same rule applied to
  // the one place a row has anything behind it at all.
  //
  // The swipe backing draws a torn sheet of paper. That is right under a block
  // — a block IS a slip, and something has to be beneath one — and wrong under
  // a row, which is not laid on the page but part of it. It read as a second
  // object appearing from nowhere every time a Things row was swiped.
  //
  // Pinned because putting it back broke nothing: the page went on working and
  // only looked wrong, which is the kind of change that comes back.
  // There used to be a rule here cancelling the paper drawn under a row that
  // slides aside: a block was a slip and needed a sheet beneath it, a Things
  // row is part of the page and a second sheet read as an object appearing from
  // nowhere. Nothing draws paper any more, so the cancellation went with it.
  check('nothing is drawn under a row that slides aside',
    !/backing::after/.test(css));

  // AN ANYTIME ROW IS THREE THINGS ON ONE LINE, and they are measured from one
  // number so they cannot drift apart.
  //
  // It was `align-items: baseline` with the tick and the × both centred, which
  // is not alignment so much as a coincidence that happened to hold: the row's
  // height came from whichever child was tallest, so centring moved the tick
  // against the title the moment the × gained four pixels of padding. Nothing
  // failed — it only looked wrong, which is the category this file exists for.
  // A CHECKBOX AND A NAME, centred on one line. It was a tick, a title and an
  // × measured off a shared line-height so three things could hang from the top
  // of a row of any height — the × is gone (the row swipes now, like every
  // other row), and two things on one line need no shared measure.
  check('the tick is a square box', /width: 15px/.test(rule('.atick')) &&
    /height: 15px/.test(rule('.atick')), rule('.atick'));
  check('which fills when it is ticked',
    /background: var\(--accent\)/.test(rule('.arow.did .atick')));
  check('and draws its own tick, needing no glyph',
    /border-width: 0 1\.5px 1\.5px 0/.test(rule('.arow.did .atick::before')));
  check('the row centres the two of them',
    /align-items: center/.test(rule('.arow')), rule('.arow'));

  // NO RULE BETWEEN THEM, unlike the Things list above. That looks like an
  // inconsistency and is the opposite: Things is a long list you scan down,
  // where a hairline is what stops two rows reading as one. This is three or
  // four things under a heading inside an already-divided day, and ruling them
  // made a short list look like a table. Space separates, the way it does
  // everywhere else here — and "make it match Things" is exactly the tidy-up
  // that would put them back.
  check('nothing is ruled between the anytime rows',
    !/border/.test(rule('.atime + .atime')), rule('.atime + .atime') || '(no rule, which is the point)');
  check('so nothing on the row is centred against the whole of it',
    !/align-self: center/.test(rule('.atick')));

  // AND IT IS WORKED LIKE ANY OTHER ROW. It carried an × — a second way to
  // remove a thing, in a different place, with no undo behind it, while every
  // other row on the screen removes by swiping left and takes a note by
  // swiping right.
  check('no × is styled', !/\.ax(?![\w-])/.test(css));
  check('nor written', !/'ax'/.test(code));
  check('it slides off a backing, like a block',
    /className = 'backing'/.test(code) &&
      /attach\(\{ slot, card: row, backing, index: i \}\)/.test(code));
  check('an anytime note is asked for the same way', /return openNote[(]index[)]/.test(code));
  // A BLOCK IS A ROW NOW. It was a slip of paper: a card in its own colour,
  // its edge displaced through turbulence by an SVG filter so no two slips
  // matched, a shadow under it, and a fibre texture behind the whole page.
  //
  // That was chosen when this was a notebook. It is a planner opened several
  // times a day to answer "what now", and the answer has to be the loudest
  // thing on screen — which it is not when the screen is being something. What
  // the paper cost was a day you could read down in one movement; what it
  // bought was the sense of an object you could pick up, which the drag gives
  // anyway.
  const block = rule('.block');
  check('a block draws no card', !/background: var\(--surface\)/.test(block), block);
  check('it sits on the page itself', /background: var\(--bg\)/.test(block), block);
  check('with no radius', !/border-radius/.test(block), block);
  check('and no shadow', !/box-shadow/.test(block), block);

  // THE HAIRLINE IS THE WHOLE SEPARATION, and it is between rows rather than
  // around them — the same rule the Things list follows, for the same reason.
  // ON THE ROW, not between two of them. Every row carries its own rule
  // underneath, the way a ruled page does — so the table is ruled all the way
  // down rather than only where two rows meet.
  check('every row is ruled underneath',
    /border-bottom: 1px solid var\(--line\)/.test(block), block);
  check('and the anytime rows the same',
    /border-bottom: 1px solid var\(--line\)/.test(rule('.arow')), rule('.arow'));
  check('the column heads sit under the heavier rule',
    /border-bottom: 1\.5px solid var\(--heavy\)/.test(rule('.colhead')), rule('.colhead'));

  // NOTHING IS DISPLACED, DRAWN OR FILTERED. Named piece by piece because a
  // half-removed theme leaves a filter reference pointing at a def that no
  // longer exists, which renders as nothing at all on some engines and as an
  // invisible element on others.
  check('no turbulence filter is referenced anywhere', !/url\(#deckle/.test(css));
  check('nor defined in the markup', !/feTurbulence|feDisplacementMap/.test(body));
  check('and the page has no fibre behind it',
    !/repeating-linear-gradient/.test(rule('body::before')) &&
      !/body::before/.test(css));

  // THE SPAN, UNDER THE TITLE. It was a single start time in a fixed column
  // down the left for one revision: the hours stacked, and a glance down the
  // edge was the shape of the day.
  //
  // What that cost is the length of things. A block is a piece of the day WITH A
  // SIZE, and a start time says when it opens without saying what it takes — the
  // chip says 30m, so the row would state its length twice and its end not at
  // all. The span says both at once, which is what a block is.
  const time = rule('.block .time');
  check('the time sits under the title, not beside it',
    /margin-top: \d+px/.test(time) && !/flex: none/.test(time), time);
  check('it is tabular, so the hours line up down the page',
    /font-variant-numeric: tabular-nums/.test(time), time);
  // Muted, not faint: a block's own hours are the second thing read in the
  // row, and faint on white is 2.6:1.
  check('and quieter than the name above it',
    /color: var\(--muted\)/.test(time), time);
  check('it is set in the mono face, with every other figure',
    /font-family: var\(--mono\)/.test(time), time);

  // THE INDEX COLUMN is what makes this a table rather than a list.
  const idx = rule('.idx');
  check('there is an index column', /width: 22px/.test(idx) && /flex: none/.test(idx), idx);
  check('in mono, tabular, so 09 and 10 are one width',
    /font-family: var\(--mono\)/.test(idx) && /tabular-nums/.test(idx), idx);
  // THE ONE THING LEFT UNDER 4.5:1, and it is figures rather than words: a
  // counter read positionally down the edge, never a fact to be made out. Ghost
  // to faint, so it is at least the grey the rest of the quiet page uses.
  check('and it is the lightest thing on the row',
    /color: var\(--faint\)/.test(idx), idx);
  check('numbered by row of the day, not by place in the array',
    /rowOfBlock\(i\) \+ 1/.test(code));

  // AND A STATUS COLUMN. Over, happening, or still to come — one column.
  const st = rule('.st');
  check('there is a status column of one width', /width: 64px/.test(st), st);
  check('read from the right', /text-align: right/.test(st), st);
  check('a finished row says so', /textContent = 'DONE'/.test(code));
  // ONE FACT EACH. Every other entry in this column is a single word, and the
  // row you are in was the only one carrying two — "NOW · 4H", where the hours
  // are already on the row in the line under the title.
  check('and the one you are in says only that',
    /textContent = 'NOW';/.test(code) && !/NOW · /.test(code));

  // A row states its WHOLE SPAN. Both ends, from the block's own start and
  // length — not the day's arithmetic restated.
  check('a row states a span, not one time',
    /time\.textContent = `\$\{clock\(b\.start\)\} – \$\{clock\(b\.start \+ b\.duration\)\}`;/.test(code));
  check('and the day still says where it ends', /id="end-time"/.test(body));
}

console.log('\n4. sections are separated by space, not by boxes');
{
  const section = rule('.section');
  check('36px between sections', /margin-bottom: var\(--gap\)/.test(section));
  check('and the gap is 22px', /--gap:\s*22px/.test(rule(':root')));
  check('a section has no border', !/border/.test(section), section);
  check('nor a background', !/background/.test(section), section);

  // Two, not three. Yesterday is gone: the question it asked is asked in place
  // now, on today's own blocks as they pass.
  check('two sections, and only two', (body.match(/<section/g) || []).length === 2,
    String((body.match(/<section/g) || []).length));
  // THE DAY IS FIRST. Things led for as long as this was a page you read
  // before you planned — the list argued for what tomorrow should hold and the
  // builder was where you answered. Once a day is confirmed that reverses: the
  // answer is what you open the page to see, and scrolling the whole list to
  // reach it is a toll paid every time to save one that was paid once.
  check('the day is first', body.indexOf('dayswitch') < body.indexOf('Things'),
    `dayswitch at ${body.indexOf('dayswitch')}, Things at ${body.indexOf('Things')}`);
  check('and there is no Yesterday', !/Yesterday/.test(body));
}

console.log('\n5. two text sizes in a row, with real space between them');
{
  check('the title is 16px', /font-size: 16px/.test(rule('.row .title')));
  check('and in ink, because it is what you are reading for',
    /color: var\(--text\)/.test(rule('.row .title')));

  const meta = rule('.row .meta');
  check('the meta is 12px', /font-size: 12px/.test(meta));
  check('and muted, under a title in ink', /color: var\(--muted\)/.test(meta));
  // Mono, because half of it is a figure — "4 days since scheduled" — and the
  // column of them reads down the page beside the times above.
  check('in the mono face, because half of it is a figure',
    /font-family: var\(--mono\)/.test(meta));
  check('tabular with them', /font-variant-numeric: tabular-nums/.test(meta));
  check('on its own line, with space above it', /margin-top: \d+px/.test(meta));
}

console.log('\n6. blue is actionable, and nothing else is blue');
{
  const blue = selectorsUsing('var(--accent)').filter((s) => !/^:root/.test(s));

  // THE RULE WIDENED, THEN NARROWED AGAIN. It used to be "blue is actionable,
  // and nothing else is blue" — the steppers and Confirm, full stop. The day
  // switch brought two exceptions; one of them, the "in today's plan" badge,
  // has since gone. What is left is:
  //
  //   .now   the divider marking where the day has got to
  //
  // It says "here is where you are", which is the nearest thing to an action
  // that is not one. It is listed by name so a second has to be argued for
  // here rather than added quietly.
  //
  // THE GATE ADDS TWO, and both are the same idea as the rest. `.gate-swap` is
  // the other door — the one press on that screen that is not the seal — and a
  // focused field is where the caret is, which is the orienting job the divider
  // does for the day. Named here so a third has to be argued for.
  //
  // AND THE SETUP SHEET ADDS TWO, both the same idea again. `.row-actions
  // .minor` is that sheet's own buttons, and `.said.good` is a check that came
  // back working — which is the one thing on that screen you can act on the
  // strength of.
  //
  // It added four. `#paste:focus` and `.pline.good` were the paste pipeline's,
  // which was deleted without its stylesheet — see section 7, and the
  // dead-class check that now catches this.
  //
  // `.back` is the fifth, and the plainest of them: it is the way out of the
  // setup screen, and leaving a place is an action.
  //
  // `.thingnote:focus` is the sixth and is not a new idea at all: it is a
  // focused field, the same job `.gate-field input:focus` already has. The
  // mark that says a row HAS a note is deliberately not on this list — it is
  // muted, because there is nothing to press on it.
  //
  // `.tzpick:focus` was a seventh and went with the panel it sat in. The
  // timezone picker is an invisible select laid over its whole row now, so
  // there is no field for a caret to be in and nothing to give a colour to.
  const acts =
    // `.addfield:focus` is the same idiom as the two fields already here: the
    // rule under a caret goes blue to say which line is being typed on.
    //
    // `.fillnow` was on this list and came off it. The rule holds — blue is for
    // what can be acted on — but it is a rule about a page, and that mark sits
    // inside a row whose whole content is the lightest grey on the screen
    // saying there is nothing here yet. The one saturated thing in it drew the
    // eye to the emptiest part of the page. Off the list rather than left on it
    // dead, so putting the accent back has to be argued for here again.
    /\.step|\.dur|\.undo button|\.addblock|\.label \.act|\.sheet-actions \.save|\.gate-swap|\.gate-field input:focus|\.row-actions \.minor|\.said\.good|\.back|\.thingnote:focus|\.addfield:focus|\.confirm|\.running|\.block\.live::before/;
  // The divider: the knot and the line it fastens. Both are indigo now, where
  // the dark build tinted the line with a separate near-blue that belonged to
  // nothing — one fewer colour on the page, and the two halves of one object
  // finally the same colour.
  //
  // It says "here is where you are", which is the nearest thing to an action
  // that is not one. Listed by name so a third has to be argued for here.
  // The divider, and the two marks on the block you are in: the bar at its
  // edge and the word beside its name. Both say "this one, now", which is what
  // orienting is — neither can be pressed. The block you are in used to be
  // marked by a three-strand cord in indigo, persimmon and tan, and its label
  // was muted grey; one colour that already means "here" replaces both.
  // THE ROW YOU ARE IN, marked four ways and with no badge: a bar in the
  // gutter, a tinted ground, a heavier name, and its figures in blue. Four
  // quiet marks read as one state; one loud mark reads as an alarm. None of
  // them can be pressed, which is what makes them orienting rather than acting.
  //
  // The ticked checkbox is here too. It fills with the accent — the one place
  // on the page where blue reports rather than offers, and it is reporting
  // something you did with a press half a second ago.
  const orients = /\.running|\.block\.live|\.arow\.did \.atick/;
  check('blue appears only on the controls that act, or the one that orients',
    blue.every((s) => acts.test(s) || orients.test(s)), blue.join(' | '));
  // WHOLE CLASS NAMES. `\b` is not a class boundary in CSS: a hyphen ends a
  // word, so `\.row\b` matched `.row-actions`, and the setup sheet's buttons
  // were reported as a decorative element wearing the action colour. The
  // lookahead refuses a following letter, digit or hyphen, which is what
  // "this class and not one that merely starts with it" actually means.
  const whole = (name) => new RegExp(`\\.${name}(?![\\w-])`);
  // Measured against what is left after the orienting marks are taken out. The
  // bar on the block you are in is drawn on `.block.live::before`, which
  // contains `.block` and so reads as decoration to a name-based sweep — while
  // being the exact thing named as orienting two lines above.
  const decorative = blue.filter((s) => !orients.test(s));
  check('and nothing decorative has it',
    !decorative.some((s) => ['cal', 'backing', 'block', 'row'].some((n) => whole(n).test(s))),
    decorative.join(' | '));

  check('the start steppers are blue', /color: var\(--accent\)/.test(rule('.step')));
  // THE CHIP IS A FIGURE IN A COLUMN, and it stopped being blue when it moved
  // into one. It was the one control on a block, so it wore the action colour —
  // in the status column it sits under DONE and beside NOW, and a blue
  // figure there was the loudest thing on the row you are NOT in.
  //
  // It is still pressed to cycle the length; what says so is that it is the
  // only thing in that column on a block still to come.
  check('the duration chip is a figure, not a shout',
    /color: var\(--muted\)/.test(rule('.dur')), rule('.dur'));
  check('set in the mono face with the rest of the column',
    /font-family: var\(--mono\)/.test(rule('.dur')));
  check('and in the column, at its width',
    /width: 64px/.test(rule('.dur')), rule('.dur'));
  // CONFIRM IS BLUE, and it is the one filled control on the page.
  //
  // It was the hanko: a persimmon seal drawn on a layer beneath the word, with
  // a turbulence filter giving it an uneven bite. That cost two composited
  // layers and two separate bugs — a word painted outside its own raster and
  // coming back as ONFIRME, and a filter swap on the day switch that made the
  // whole face invisible. A filled rectangle in the colour that already means
  // "this can be pressed" says the same thing with one layer.
  const confirm = rule('.confirm');
  check('confirm is filled in the accent', /background: var\(--accent\)/.test(confirm), confirm);
  check('and its word is the page colour, for contrast the other way',
    /color: #fff/.test(confirm), confirm);
  check('nothing is drawn beneath it any more', !/\.confirm::after/.test(css));
  check('and nothing about it is filtered', !/filter/.test(confirm), confirm);

  // CONFIRMED IS SETTLED, NOT REMOVED. It went to paper and grey once, which
  // read as the button having been taken away rather than the day having been
  // agreed to.
  // AN OUTLINE, NOT A FILL. A day you have agreed to should still show its
  // button — going to a grey slab reads as the control having been taken away —
  // and it should stop being the loudest thing on a screen you are now reading
  // rather than deciding on.
  const done = rule('.confirm:disabled');
  check('a confirmed day shows an outline, not a fill',
    /background: none/.test(done) && /border-color: var\(--line\)/.test(done), done);
  check('quieter, but not invisible', /color: var\(--muted\)/.test(done), done);

  // BEING PRESSED. The save is a round trip, and a control that answers a
  // second late reads as one that missed.
  check('the press is answered at once', /background/.test(rule('.confirm.pressing')),
    rule('.confirm.pressing'));
  check('and it is the button itself that darkens, not a layer under it',
    !/\.confirm\.pressing::after/.test(css));

  // The keyboard keeps its ring; the pointer does not.
  check('a pointer press leaves no outline', /outline: none/.test(rule('.confirm:focus')));
  check('but a keyboard keeps one', /outline: 2px solid/.test(rule('.confirm:focus-visible')));
}

console.log('\n7. the warn colour warns; it does not narrate');
{
  // It marks a deadline running out, a day running past midnight, a feed that
  // failed, and Delete. It had two other jobs and has lost both: a missed
  // block, which is a concept that no longer exists, and the BLOCK swipe
  // backing, which filled the whole card while a finger was on it.
  //
  // THE THING SWIPE'S BACKING TAKES IT BACK, on the removing side only and as
  // one word rather than a fill — and it is the same job it has always had,
  // which is Delete. It is deliberately unlike the block swipe: a block
  // carries a six-second undo, so colour there would be shouting about
  // something already caught. Deleting a thing asks first and then writes for
  // good, and the colour is what says which of the two swipes you are in
  // before your finger comes off.
  const warn = selectorsUsing('var(--warn)').filter((s) => !/^:root/.test(s));
  // THE HANKO JOINS THE LIST, and it is the only addition this theme makes.
  // A seal is stamped in persimmon; it is the one warm thing on the page and
  // the one press that commits a day. Listed by name so a second addition has
  // to be argued for here rather than added quietly.
  // `.gate-problem` is the same job as `.problem` in the add sheet: a form
  // saying why it will not accept what it was given. Not a new use of the
  // colour, the same one on a second form.
  //
  // The setup sheet's two. `.said.bad` is a check that came back broken, which
  // is the job `.failed` already does for a feed on the day screen.
  // `.row-actions .go` is the button that commits a row of setup — ink, like
  // the seal, because it is the same kind of act.
  //
  // There were three. `.pline.bad` belonged to the paste pipeline, and the
  // pipeline was deleted while its stylesheet was not: four orphan rules, two
  // of them coloured, counted by this list as live uses of both inks. The
  // dead-class check in section 19 is what would have said so.
  //
  // And two in the setup drawings. `.fig-mark` and `.fig-note` are the one
  // warm thing in each sketch: the arrow and the word pointing at the row you
  // are meant to copy. Everything else in those figures is line and paper, so
  // the only colour in them is doing the only job they have.
  const allowed =
    /\.mark|\.ends\.late|\.failed|\.danger|\.problem|\.confirm|\.gate-problem|\.said\.bad|\.row-actions \.go|\.fig-mark|\.fig-note|\.thing \.backing\.left/;
  check('used only on marks, failures, Delete and the seal',
    warn.every((s) => allowed.test(s)), warn.join(' | '));
  check('and nothing is left claiming a miss', !/askmiss|wasmissed/.test(css));

  // ONE SURFACE FOR BOTH SWIPES. The removing side used to be the warn colour
  // across the whole card. A removal carries a six-second undo, so the colour
  // was not what made it safe — it was just loud, and loudest on a past block,
  // where taking the block out is how the day is recorded rather than damage.
  const backing = rule('.backing');
  // A flat surface, on the backing itself. It used to be a second sheet of torn
  // paper drawn on a layer beneath — which a block needed, because a block was
  // a slip and something has to be under one. A row is part of the page, and
  // what shows when it slides is simply the surface colour.
  check('the backing is the tint, the one other ground on the page',
    /background: var\(--tint\)/.test(backing), backing);
  check('drawn on itself, with no layer beneath it',
    !/\.backing::after/.test(css));
  check('not the warn colour', !/--warn/.test(backing), backing);
  check('nor blue', !/--accent/.test(backing), backing);
  check('and the loud variant is gone, not merely unused',
    !rule('.backing.hot') && !/backing\.hot/.test(css));
  check('with no tone left in the markup it writes', !/backing \$\{side\} \$\{tone\}/.test(code));
  check('side is the only thing that varies',
    !/background/.test(rule('.backing.left')) && !/background/.test(rule('.backing.right')));
  check('and it is which edge the label sits at',
    /justify-content: flex-end/.test(rule('.backing.left')) &&
      /justify-content: flex-start/.test(rule('.backing.right')));

  check('the warning mark carries it', /color: var\(--warn\)/.test(rule('.mark')));

  // AND WEIGHT, which is the one place on this page weight says something
  // rather than ranking a heading. The marks sit at the meta line's size
  // because they belong in the margin rather than in the text, and at 12px the
  // colour alone was doing all the work — bold is what makes three of them read
  // as louder than one without making them any bigger.
  // WEIGHT, PLAINLY, now that the glyph is one every font has.
  //
  // It was ✱ — U+2731, in the Dingbats block, carried by no font in the stack —
  // so every platform fell back for that one character to a single-weight
  // symbol font, and `font-weight: 700` depended on the browser faking a bold
  // that did not exist. Chrome fakes one; iOS Safari does not. It read bold on
  // a laptop and thin on the phone it is actually used on, and the fix was a
  // stroke painted on the glyph's own outline.
  //
  // An exclamation mark is in every font at every weight, so 700 is simply 700
  // and the stroke went with the glyph that needed it.
  check('the mark is the one the server computed',
    /mark\.textContent = item\.mark;/.test(code));
  check('and no glyph is substituted for it', !/✱/.test(code));
  check('it is set bold, which now means something', /font-weight: 700/.test(rule('.mark')),
    rule('.mark'));
  check('and needs no stroke to fake one', !/-webkit-text-stroke/.test(rule('.mark')),
    rule('.mark'));

  check('an ordinary row does not', !/--warn/.test(rule('.row')));
  check('nor an ordinary meta line', !/--warn/.test(rule('.row .meta')));
  check('nor the block you are in — it is running, not failing',
    !/--warn/.test(rule('.running')));
}

console.log('\n7a. the wait before the first day is on screen');
{
  // Without it you land on the static markup: the switch with no date, "Day
  // ends —", an empty builder and an empty list. That is the real screen with
  // every value missing, which reads as a day with nothing in it rather than a
  // day that has not arrived — and then it pops into place.
  const cover = rule('#booting');
  check('there is a cover', cover.length > 0);
  check('it is the page, not a panel over it',
    /background: var\(--bg\)/.test(cover), cover);
  check('and it covers the whole page', /position: fixed/.test(cover) && /inset: 0/.test(cover));

  // A quarter of a circle's outline, turning. Transparent on three sides, so
  // what shows is an arc rather than a full ring with one bright quarter — a
  // ring reads as a shape, and this has to read as motion.
  const dot = rule('#booting span');
  check('a circle outline', /border-radius: 50%/.test(dot));
  // AN ENSŌ: a circle left open where the brush lifted, which is what the
  // turning arc already was. Ink rather than faint — a brushstroke is the one
  // thing on this page allowed to be dark, because it IS ink.
  check('and only a fraction of it is drawn',
    /border: 2\.6px solid var\(--text\)/.test(dot) &&
      /border-right-color: transparent/.test(dot), dot);
  check('not indigo: there is nothing to act on yet', !/--accent/.test(dot), dot);
  check('it turns', /animation: spin/.test(dot));
  check('and no word, because this system would not say "Loading"',
    !/Loading|loading/.test(body));

  // `start`, not `load`. What settles is now the whole opening: read the
  // config, then either the day or the gate. The cover has to come off either
  // way — a page stuck under it because nobody was signed in would be the same
  // failure as one stuck because a fetch died.
  check('it lifts when the opening settles, not only when it succeeds',
    /start\(\)\.finally\(\(\) => \{\s*settled = true;\s*uncover\(\);/.test(code), 'start().finally');
  check('and leaves the layout rather than sitting invisible over it',
    /style\.display = 'none'/.test(code));

  // AND ON A DEADLINE OF ITS OWN. Settling covers a load that fails; it does
  // not cover one that never settles, which is a blank screen that comes back
  // when you touch it — a real report, not a hypothetical.
  check('and after a bound, whatever the load is doing',
    /BOOT_PATIENCE\s*=\s*\d+/.test(code) && /\}, BOOT_PATIENCE\)/.test(code));
  check('which is a deadline for the cover, not for the network',
    /if \(settled\) return;/.test(code));
  check('what shows under it says what it is, rather than an empty day',
    /if \(session\) showWaiting\(\);\s*else showGate\(\);/.test(code));

  // Motion is the default, stillness is the setting — not a lesser version. A
  // quarter arc held still reads as something half-drawn, so it closes into
  // the whole outline: a complete shape, plainly deliberate.
  const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce'));
  check('reduced motion stops the turn',
    /#booting span,\s*\.waiting span \{\s*animation: none/.test(reduced),
    reduced.slice(0, 120));
  check('and closes the arc into a whole circle rather than freezing it',
    /animation: none;\s*border-color: var\(--text\)/.test(reduced));

  // The seal needs no exception here any more. It answered a press by seating
  // into the paper AND deepening its ink; the seating is gone — it was cutting
  // the word in half — and what is left is not movement, so there is nothing
  // for this setting to still.
  //
  // Asserted as the two exact rules being absent rather than as ".confirm does
  // not appear in `reduced`" — `reduced` is a slice to the END of the
  // stylesheet, so it contains every rule written after the first
  // reduced-motion block, the seal's own among them.
  check('the seal needs no stillness rule, having no movement',
    !/\.confirm\.pressing \{\s*transform: none/.test(css) &&
      !/\.confirm \{\s*transition: none/.test(css));
}

console.log('\nan empty day is empty, and says so by being it');
{
  // A BLOCK'S WORTH OF ROOM used to be held open on a day with none — a real
  // block card, hidden with `visibility` so it kept its space, because
  // collapsing the builder to nothing put Starts hard against + Block.
  //
  // The table has its own structure now: a column head with a rule under it,
  // and a rule above whatever comes next. An empty day reads as an empty day
  // between those two lines, and the held-open room read as a gap somebody had
  // forgotten to fill.
  check('nothing holds room open on an empty day', !/emptySpace/.test(code));
  check('and no spacer is styled', !/\.ghost(?![\w-])/.test(css));
  check('the column head still frames it',
    /border-bottom: 1\.5px solid var\(--heavy\)/.test(rule('.colhead')));
}

console.log('\n7a-ii. and the same dot when the day switch is fetching');
{
  // Tapping Tomorrow left today's blocks on screen under the word Tomorrow
  // until two fetches came back. On a phone that is long enough to read the
  // wrong day and believe it.
  const wait = rule('.waiting');
  check('the day gets a waiting state', wait.length > 0);
  check('centred', /justify-content: center/.test(wait));
  check('and holding height, so the page does not jump', /padding: 30px 0/.test(wait));

  // Declared once for both. Two copies of a turning arc would drift the first
  // time either was adjusted.
  check('it is the same mark as the boot cover, declared once',
    /#booting span,\s*\.waiting span \{[^}]*border-right-color: transparent/.test(css));

  check('the switch shows it before it fetches',
    /showWaiting\(\);\s*\n\s*await loadCalendar/.test(code));
  check('and the end time goes back to a dash with it',
    /showWaiting[\s\S]{0,400}\$\('end-time'\)\.textContent = '—'/.test(code));
}

console.log('\n7b. the right edge of a block says one thing per state');
{
  // Three states, and only one of them puts anything here now. Upcoming gets
  // the chip, in progress gets the word, and a block that is over gets
  // nothing at all — it used to ask "didn't happen?", and there is no such
  // question any more.
  const act = rule('.running');
  check('the block in progress has a label', act.length > 0);
  // It sits IN the status column, so it takes that column's size and the live
  // row's colour rather than setting either itself. One place decides how the
  // row you are in looks, and it is the row.
  check('it sets no colour of its own', !/color:/.test(act), act);
  check('the row it is on sets one',
    /\.block\.live \.time,[\s\S]{0,90}color: var\(--accent\)/.test(css));
  check('and it wears the status column', /className = 'st running'/.test(code));
  check('it does not wrap', /white-space: nowrap/.test(act));

  // Not a control: no border, no background, nothing to press.
  check('it has no pill border, unlike the chip it replaces', !/border/.test(act), act);
  check('and no background', !/background/.test(act), act);

  // It used to borrow the chip's padding, because a bare label sat 15px nearer
  // the card edge than chip text did and "active" crowded it. There is no card
  // edge now — a row runs to the margin — so the label needs no box of its own,
  // only to keep out of the title's way.
  check('it takes no more room than its word', /white-space: nowrap/.test(act), act);

  check('it says NOW, and only NOW', /textContent = 'NOW';/.test(code));
  // The length went with the argument that carried it, so a call still passing
  // a block would be a call passing something nothing reads.
  check('and needs nothing about the block to say it',
    /function activeLabel\(\) \{/.test(code));
  check('a block that has begun gets it',
    /\} else if \(begun\) \{\s*row\.append\(idx, left, activeLabel\(\)\);/.test(code));
  check('and one that is over says DONE in the same column',
    /if \(past\) \{\s*row\.append\(idx, left, doneLabel\(\)\);/.test(code));
}

console.log('\n8. the calendar aside is a left rule, not a card');
{
  // NOT A CARD, AND NOT A BAR EITHER. It was a left rule and indented text,
  // which was right on a page made of paper — and on a page made of horizontal
  // rules it was the only vertical line, so it read as the one section that had
  // been boxed off.
  //
  // It is a heading and some quiet text now, in the same mono capitals every
  // other section head uses. What separates it is space, which is what
  // separates everything here.
  const cal = rule('.cal');
  // IT KEEPS ITS LEFT RULE. Everything else on the page is a row of a table or
  // a heading over one; this is the one thing that is neither, and the bar down
  // its side is what says so. Taking it away made the aside read as another
  // section of the ledger.
  check('a left rule', /border-left: 2px solid/.test(cal), cal);
  check('and only a left rule',
    !/border-top|border-right|border-bottom|border:/.test(cal), cal);
  check('no background', !/background/.test(cal), cal);
  check('no radius', !/border-radius/.test(cal), cal);
  check('the text is indented from it', /padding: [^;]*13px/.test(cal), cal);

  const head = rule('.cal h4');
  check('its heading is a mono capital, like every other section head',
    /font-family: var\(--mono\)/.test(head) && /text-transform: uppercase/.test(head), head);
  check('and quiet without being unreadable', /color: var[(]--muted[)]/.test(head), head);
  // Ghost rather than muted: "Nothing on it." is the absence of a fact, not a
  // quiet one.
  check('its empty line is ghost', /color: var[(]--ghost[)]/.test(rule('.cal p')));
  // PRESSABLE NOW, and still not a card. What changed is what a row does, not
  // what it is: a line of text under a rule, with the affordance out at the
  // edge where it can be ignored.
  const row = rule('.calrow');
  check('an event row is a button with nothing drawn on it',
    /background: none/.test(row) && /border: 0/.test(row), row);
  check('and no fill of its own', !/background(-color)?:\s*(#|var\(|rgb)/.test(row), row);
  check('it says it can be pressed', /cursor: pointer/.test(row), row);
  check('and it inherits the aside\'s colour', /color: var\(--cal-text\)/.test(row), row);
  check('not the accent: pressing it is not the day\'s main move',
    !/--accent/.test(row), row);

  // NEVER GREYED, however many times it is pressed. A Things row goes grey
  // because the list is claiming to say where a thing stands; a meeting you
  // have built the day around is still a meeting at two o'clock.
  check('there is no greyed state for an event row', !/\.calrow\.locked|\.calrow:disabled/.test(css));
  check('nor an opacity it settles at', !/^\s*opacity/m.test(row), row);
  check('the only press feedback lasts as long as the touch',
    /\.calrow:active\s*\{[^}]*opacity/.test(css));

  // NO INDICATOR AT ALL. It carried a muted + at the edge, and a mark on every
  // row to describe a gesture is a toll paid on every reading of the list to
  // explain something once.
  check('no + affordance is styled', !/\.cadd/.test(css));
  check('nor any other mark at the row\'s edge',
    !/\.calrow\s*(::after|::before)/.test(css));
  check('so the row is a time and a title',
    /\.ctime/.test(css) && /\.ctitle/.test(css) && !/\.cadd/.test(css));

  // THE TITLE IS THE TARGET, and with the + gone it is most of the row: it
  // stretches to fill whatever the time column leaves.
  // ONE LINE, NOT TWO COLUMNS. There are one or two events on a day, and a
  // column of two is a table with nothing to compare down it. The hour runs
  // inline ahead of the name, in mono, so it still reads as a figure.
  check('the hour runs inline ahead of the name',
    /padding-right: 7px/.test(rule('.ctime')), rule('.ctime'));
  check('and it is a figure, in the figure face',
    /font-family: var\(--mono\)/.test(rule('.ctime')) && /tabular-nums/.test(rule('.ctime')),
    rule('.ctime'));

  const root = rule(':root');
  check('which is the same grey the rest of the page is quiet in',
    /--cal-head:\s*#97a3b4/i.test(root));
  check('and neither of the two colours that mean something',
    !/--cal-head:\s*(#1e4fd8|#dc2626)/i.test(root));
}

console.log('\n9. tabular figures on every time');
{
  for (const [what, selector] of [
    ['the start time', '.num'],
    ['a block time', '.block .time'],
    ['a block duration', '.dur'],
    ['the day end', '.ends b'],
    ['an event time', '.ctime'],
  ]) {
    check(`${what} is tabular`, /font-variant-numeric: tabular-nums/.test(rule(selector)));
  }
}

console.log('\n10. the money tab is gone, and so is the tab bar');
{
  check('no tab bar in the markup', !/class="tabs"|role="tablist"/.test(body));
  check('no tab styling left behind', !/\.tabs/.test(css));
  check('no money view', !/money/i.test(body));
  check('nothing in the script switches tabs', !/showTab|tab-money|tab-plan/.test(code));
  check('and nothing fetches the finance routes', !/\/money|\/finance/.test(code));
}

console.log('\n11. everything cut is really cut');
{
  // Matched against identifiers and endpoints rather than English words. "why"
  // and "place" both appear legitimately — a placeholder asking why something
  // was missed, and replaceChildren — and a check that cannot tell those from
  // the removed field is a check that will be silenced rather than fixed.
  for (const [what, pattern] of [
    ['summarize', /summari[sz]e/i],
    // `plan-intent` alone now. It used to also forbid `setup-prompt` and
    // `/import`, and both of those names have since come back meaning
    // something else: a text box holding a prompt you copy into your own AI
    // chat, and the endpoint that saves what you paste back. Neither is the
    // removed interview — that was a conversation this system conducted
    // itself, through the model, over several endpoints.
    //
    // `plan-intent` is the identifier that actually named it, and
    // step1-verify.js still proves /plan-intent/setup-prompt answers 404,
    // which is the guarantee this line is standing in for.
    ['the setup interview', /plan-intent/i],
    ['pause and unpause', /\/pause|paused_at|\bpaused\b/i],
    ['the why field', /f-why|\.why\b|why:/i],
    ['where it stands', /f-state|\.state\b|state:/i],
    ['the free-text size field', /f-size-text|state_captured|state_days_old/i],
    ['the temperature bar', /temperature|stale-bar|interpolat/i],
    ['cold flags and reasons', /\bcold\b|cold_reason/i],
    // The Things list's hand-ordering. Not the builder's reorder gesture,
    // which is a different thing that happens to share the word.
    ['hand-ordering the list', /sort_order|draggable|ondragstart|\.sortable/i],
    // The BLOCK flag: one that held its start_time and never moved when the
    // chain above it shifted. A pinned ENTRY is a live feature that happens to
    // share the word, so this cannot look for the word.
    //
    // `\bb\.pinned\b` was the first attempt and is worse than useless: `b` is
    // the second argument of every comparator on this page, so it matched the
    // Things list's own sort. What the retired feature looked like on the page
    // is a boolean written into a block payload, and that is what this looks
    // for now.
    ['pinned blocks', /pinned:\s*(true|false)/i],
    ['auto-placement', /to_place|\/place\b|autoPlace/i],
  ]) {
    check(`${what}: gone from the markup`, !pattern.test(body), what);
    check(`${what}: gone from the script`, !pattern.test(code), what);
  }
}

console.log('\n12. the add form asks for exactly the five fields');
{
  check('a type chooser', /id="type-seg"/.test(body));
  check('with three types', (body.match(/data-type="/g) || []).length === 3);
  check('a title', /id="f-title"/.test(body));
  check('a due date', /id="f-due"/.test(body));
  check('a size', /id="f-size-field"/.test(body));
  check('a frequency', /id="f-freq-field"/.test(body));

  // The five buckets, spelled the way the server spells them. A mismatch here
  // is a form that offers a value the server will refuse.
  for (const size of ['a day', 'a few days', 'a week', 'a few weeks', 'months']) {
    check(`the size "${size}" is offered`, code.includes(`'${size}'`));
  }

  check('it is a sheet', /class="sheet"/.test(body));
  // Inside the Things label, rather than merely before the day switch. It was
  // the second of those, which was a proxy for the first and stopped being one
  // the moment the day moved above Things on the screen.
  const thingsLabel = body.slice(body.indexOf('Things'), body.indexOf('</div>', body.indexOf('Things')));
  check('opened from the Things label',
    /id="add-open"/.test(body) && /id="add-open"/.test(thingsLabel), thingsLabel.trim());
}

console.log('\n13. a row says it has more actions, rather than hiding them');
{
  // THE TIMEZONE ROW IS ITS OWN CONTROL, and the way that works is a select
  // laid over the whole row and made transparent. Pressing anywhere on the row
  // is therefore pressing the select, and what opens is the phone's own wheel.
  //
  // OPACITY, NOT visibility OR display. Both of those take an element out of
  // the hit test as well as out of sight, which would leave a row that looks
  // exactly as pressable as it does now and does nothing at all — a change
  // that breaks the only control on the row while breaking no test, which is
  // what this file is for.
  const picker = rule('.tzpick');
  check('the timezone picker covers its whole row',
    /position: absolute/.test(picker) && /inset: 0/.test(picker), picker);
  check('and is transparent rather than hidden, so it can still be pressed',
    /opacity: 0/.test(picker) && !/visibility: hidden/.test(picker) && !/display: none/.test(picker),
    picker);
  check('the row it covers is what positions it',
    /position: relative/.test(rule('.tzrow')), rule('.tzrow'));

  // REACHABLE WITHOUT BEING BIGGER. A finger is about 9mm and several of these
  // marks are 13 to 20px tall — sized to be read, which is right: the ··· must
  // not compete with the title beside it. So the target grows and the mark does
  // not, in a pseudo-element that takes part in no layout.
  //
  // Checked as a pair. A hit area on something that is not positioned lands
  // against the nearest positioned ancestor instead — which is a whole row, or
  // the page — and that failure is invisible until a tap opens the wrong thing.
  for (const small of ['.hint', '.atick', '.step']) {
    check(`${small} carries a hit area`, /inset: -\d+px/.test(rule(`${small}::after`)),
      rule(`${small}::after`));
    check(`and is positioned, so it lands on itself`,
      /position: relative/.test(rule(small)) ||
        new RegExp(`\\${small}[,\\s][^{]*\\{[^}]*position: relative`).test(css),
      small);
  }
  check('and none of them draws anything',
    !/\.hint::after[^}]*background:|\.atick::after[^}]*background:/.test(css));

  // A held element and a phone that raises its own menu over the hold. Both
  // suppressions, on both things that are held: neither substitutes for the
  // other, and the failure is a drag dying under a menu nobody asked for.
  for (const held of ['.block', '.row']) {
    check(`${held} refuses the callout`, /-webkit-touch-callout: none/.test(rule(held)),
      rule(held).slice(0, 60));
    check(`and text selection under the hold`, /-webkit-user-select: none/.test(rule(held)));
  }

  const hint = rule('.hint');
  check('there is a hint', hint.length > 0);
  // The lightest thing on the row: it is an affordance, not a fact about the
  // thing, and it sits inside a title it must not compete with.
  // A CONTROL, and it was 1.6:1 — fainter than the hairlines around it.
  // "Quieter than the title" is what muted means here; faint is "barely there",
  // and ghost was below even that.
  check('it is muted, so it does not compete with the title',
    /color: var\(--muted\)/.test(hint), hint.match(/color[^;]*/) || '');
  check('and never the accent, because it does not commit to anything',
    !/--accent/.test(hint));
  check('nor the miss colour', !/--warn/.test(hint));

  check('every row gets one', /className = 'hint'/.test(code));
  check('it is labelled for a screen reader', /aria-label/.test(code));

  // The three actions behind it. Edit had no route into it at all before
  // this: the update endpoint existed and nothing on the page called it.
  check('it reveals Done', /textContent = 'Done'/.test(code));
  check('it reveals Edit', /textContent = 'Edit'/.test(code));
  check('it reveals Delete', /textContent = 'Delete'/.test(code));
  check('Edit opens the sheet on that row', /openSheet\(item\)/.test(code));
  check('and the sheet posts to the update route', /\/entries\/\$\{editingId\}\/update/.test(code));

  // The whole point of replacing the long press.
  check('no long press left on a row in Things',
    !/onpointerdown[\s\S]{0,400}acts\.classList\.remove/.test(code));

  check('tapping the row still schedules it', /addBlock\(\{ title: item\.title/.test(code));
  check('and the hint does not', /e\.stopPropagation\(\);\s*\n\s*acts\.classList\.toggle/.test(code));

  // One sheet, not two. Two copies of this form would be two places for the
  // date-and-size rule to drift apart.
  check('add and edit share one sheet', (code.match(/function openSheet/g) || []).length === 1);
  check('the type cannot be changed on an edit', /b\.disabled = editingId !== null/.test(code));
}

console.log('\n13a. the saved list sits back from the one you read down');
{
  // TWO LISTS THAT LOOKED ALIKE. Space was the whole separation, and a row set
  // down on purpose reading like a row you still owe is the one way this
  // section can do harm.
  const saved = rule('.saved');
  check('there is a saved section', saved.length > 0);
  check('it is separated by space', /margin-top: \d+px/.test(saved), saved);

  const dim = /opacity: (0?\.\d+)/.exec(saved);
  check('and it is dimmer than the list above it', Boolean(dim), saved);
  check('far enough back to read as a different list',
    dim && Number(dim[1]) <= 0.75, dim && dim[1]);
  check('but not so far that it reads as unavailable',
    dim && Number(dim[1]) >= 0.45, dim && dim[1]);

  // THE MAIN LIST IS THE FULL-STRENGTH ONE. Dimming is only a comparison, and
  // it says nothing at all if both sides move.
  check('the list it is compared against is not dimmed itself',
    !/opacity/.test(rule('#things')) && !/opacity/.test(rule('.thing')),
    rule('.thing'));

  // NOTHING HERE IS UNAVAILABLE. Dimming is the whole effect: every row still
  // swipes, opens and schedules, so there must be no rule that takes one out of
  // the hit test or stops it being pressed.
  check('and nothing in it is switched off',
    !/pointer-events:\s*none/.test(saved) && !/user-select:\s*none/.test(saved), saved);
}

console.log('\n14. a block is worked by gesture, and the gestures are arbitrated');
{
  // No `···` on a block. The card itself is the target now.
  check('a block carries no hint', !/block[\s\S]{0,900}className = 'hint'/.test(code));

  console.log('   the duration');
  check('no steppers on a block', !/durationStepper/.test(code));
  check('the chip is a real button, so a keyboard reaches it',
    /dur = document\.createElement\('button'\)/.test(code));
  check('and the tap is on click, not on pointerup', /dur\.onclick = /.test(code));
  check('it cycles', /cycleDuration\(i\)/.test(code));
  check('wrapping at the ceiling', /next > MAX_DURATION \? STEP : next/.test(code));
  check('which is four hours', /MAX_DURATION = 4 \* 60/.test(code));
  check('new blocks start at one step', /duration = STEP/.test(code));

  console.log('   the swipes');
  check('a real distance is required', /SWIPE_COMMIT = \d\d/.test(code));
  check('left removes a block, whatever the clock says',
    /dx <= -SWIPE_COMMIT\) return removeBlock\(index\);/.test(code));
  check('and the time never enters into it',
    !/toggleMissed/.test(code) && !/begun \?.*removeBlock/.test(code));
  check('right opens a note', /dx >= SWIPE_COMMIT\) \{[\s\S]{0,220}return openNote\(index\);/.test(code));

  // AND PUTS THE CARD BACK FIRST. The note is asked for in the browser's own
  // prompt, and cancelling one writes nothing and renders nothing — so a card
  // left at its swiped transform stayed there until something else redrew the
  // day. It settled by accident, on the render a saved note happened to cause.
  // Reported from a phone as having to swipe the block a second time.
  // A BOUNDED WINDOW BEFORE EACH CALL, rather than a lazy match from an opening
  // brace. The two handlers are identically shaped and two thousand lines
  // apart, so `\{[\s\S]*?return openNote` starts at the Things row's brace and
  // runs all the way to the block's call, swallowing both — and then every
  // assertion about either one passes by finding it in the other. This checker
  // has been fooled by a lookup spanning two rules four times; that is five.
  const just = (before) => {
    const at = code.indexOf(before);
    return at === -1 ? '' : code.slice(Math.max(0, at - 220), at);
  };

  {
    const right = just('return openNote(index);');
    check('  and settles the card before the dialog, not after it',
      /card\.style\.transform = '';/.test(right) && /backing\.style\.opacity = '0';/.test(right),
      right.replace(/\s+/g, ' ').slice(-90));
    check('  without a transition, which a blocking prompt would never paint',
      /card\.style\.transition = '';/.test(right));
    check('  and it is the card being settled, not some other row',
      !/row\.style\.transform/.test(right));
  }

  // The same on a Things row, which had the same bug and the same cause.
  {
    const right = just('return openThingNote(item);');
    check('a things row settles before its note dialog too',
      /row\.style\.transform = '';/.test(right) && /backing\.style\.opacity = '0';/.test(right),
      right.replace(/\s+/g, ' ').slice(-90));
    check('  and it is the row, not the card', !/card\.style\.transform/.test(right));
  }
  check('the card follows the finger', /translateX\(\$\{dx\}px\)/.test(code));
  // Two meanings on one gesture, and the direction is which — so the backing
  // names it before the finger comes off, and there is no third label left.
  check('the backing names the direction, and only that',
    /'Remove'/.test(code) && /'Note'/.test(code) &&
      !/didn't happen"/.test(code) && !/'happened'/.test(code));
  check('removal offers an undo rather than a confirm', /offerUndo\('Removed'/.test(code));
  check('and nothing asks first', !/confirm\(`Remove/.test(code));

  // THE DAY CLOSES OVER IT. Splicing and re-rendering in one breath destroyed
  // the row outright, so everything below jumped a block's height with nothing
  // connecting where they had been to where they now were.
  check('the card goes at once', /child\.style\.visibility = 'hidden'/.test(code));
  check('and the space it held closes', /closeOver\(slot, \(\) => dropBlock\(gone\)\)/.test(code));
  check('the height is pinned before it is animated, or there is nothing to animate',
    /slot\.style\.height = `\$\{height\}px`[\s\S]{0,400}slot\.style\.height = '0px'/.test(code));
  check('with a read between them to make the first take',
    /void slot\.offsetHeight/.test(code));
  check('the removal waits for it', /setTimeout\(onDone, CLOSE_MS\)/.test(code));

  // A slot already at zero height fires no transition, so transitionend would
  // never come and the removal would never happen.
  check('on a timer rather than transitionend', !/transitionend/.test(code));

  // The index is a frame old by the time the gap has closed.
  check('and the block is found by identity, not by the index it had',
    /const at = blocks\.indexOf\(gone\)/.test(code));

  check('stillness skips it entirely', /if \(!slot \|\| reduceMotion\(\)\) return dropBlock/.test(code));

  // The clamp survives the simplification, pointing the other way. It used to
  // stop a delivered block being swiped away; removal is one rule now, and it
  // is the NOTE swipe that has nowhere to go on a block already under way.
  check('a fixed block clamps the note swipe',
    /isFixed\(\) \? Math\.min\(0, raw\) : raw/.test(code));
  check('and shows no backing when it does', /if \(!dx\) \{/.test(code));
  check('the screen keeps the sent flag', /sent: Boolean\(b\.sent\)/.test(code));

  // The buffer insert is gone. Buffer is a title you type into + Block.
  check('nothing inserts a buffer on a swipe', !/insertBuffer/.test(code));
  check('and there is no buffer constant left', !/BUFFER_TITLE/.test(code));

  console.log('   the note');
  // THE BROWSER'S OWN DIALOG, for the same reason the add controls use it: it
  // arrives centred with the keyboard already up and the field already
  // focused. The inline textarea opened a rule somewhere in a list and left
  // you to find it — and on a block near the foot of the day, the keyboard
  // then covered the very thing you were writing about.
  check('it opens whether or not there is one, so a swipe edits',
    /openNote\(index\)/.test(code));
  check('and asks in the browser rather than in the page',
    /prompt\('What is this block for\?', b\.note \|\| ''\)/.test(code));

  // SEEDED WITH WHAT IS THERE, so swiping a block that already has a note is
  // how the note is edited rather than replaced.
  check('seeded with the note it already has', /b\.note \|\| ''/.test(code));

  // CANCEL IS NOT AN EMPTY NOTE. Clearing the field is how a note is removed
  // and backing out has to leave it alone; the two arrive as '' and null.
  check('backing out leaves the note alone',
    /if \(next === null\) return;/.test(code));

  // And no mode is left behind. `noting` held which block was being written
  // in, the builder re-rendered to draw the field, and the pointer handler had
  // to refuse gestures on that one block so placing a cursor did not pick the
  // card up. A dialog is open or it is not.
  check('no inline editor is left', !/noteEditor|noteedit/.test(code));
  check('nor the mode it needed', !/\bnoting\b/.test(code));
  check('and a things note asks the same way',
    /prompt\(`Note for \$\{item\.title\}`, item\.note \|\| ''\)/.test(code));

  console.log('   the reorder');
  check('held, not dragged from a handle', /setTimeout\(startReorder, HOLD_MS\)/.test(code));
  check('for 400ms', /HOLD_MS = 400/.test(code));
  check('it lifts', /lift\(true\)/.test(code));
  check('haptic if there is one', /navigator\.vibrate/.test(code));
  check('the others part to show the gap', /part\(gesture\.from, to, gesture\.step\)/.test(code));
  check('and the drop is animated, not snapped',
    /transform \$\{SETTLE_MS\}ms ease-out/.test(code) && /SETTLE_MS = 180/.test(code));

  console.log('   arbitration');
  check('one gesture at a time', /if \(gesture\) return;/.test(code));
  check('a move past the slop decides it', /Math\.abs\(raw\) < SLOP && Math\.abs\(dy\) < SLOP/.test(code));
  // On the raw movement, never the clamped one. A finger dragging left on a
  // delivered block has moved, and reading that as stillness would leave the
  // hold timer running and turn a refused swipe into a pick-up.
  check('and it is decided on raw movement, not clamped',
    /Math\.abs\(dy\) >= Math\.abs\(raw\)/.test(code));
  check('vertical is the page scrolling and nothing else',
    /gesture\.mode = 'scroll';/.test(code));
  check('and movement cancels the hold', /clearTimeout\(gesture\.hold\)/.test(code));
  check('a committed gesture swallows its trailing click', /swallowClick = true/.test(code));
  check('so a swipe cannot also cycle a duration',
    /if \(swallowClick\) \{[\s\S]{0,60}return;/.test(code));

  // The one line that keeps a scroll from ever becoming a swipe, whatever
  // the script does.
  check('the browser keeps vertical panning', /touch-action: pan-y/.test(css));
  check('on the card', /touch-action: pan-y/.test(rule('.block')));
  // The chip inherits the row's own pan-y rather than declaring one: it is a
  // child of the block, and the block is what the browser is arbitrating with.
  check('and the chip does not take the gesture back',
    !/touch-action: (none|auto)/.test(rule('.dur')), rule('.dur'));

  console.log('   and a carried block takes it back');
  // The reorder died here once: pan-y let the browser claim the drag as a
  // scroll, and claiming it fires pointercancel, which tore the drag down.
  check('a non-passive touchmove listener holds the page',
    /addEventListener\('touchmove', blockScroll, \{ passive: false \}\)/.test(code));
  check('and it is removed again',
    /removeEventListener\('touchmove', blockScroll/.test(code));
  check('installed when the hold fires', /holdPage\(true\)/.test(code));
  check('released on drop', /releasePage\(\);/.test(code));
  check('and released if the browser takes the gesture anyway',
    /onpointercancel[\s\S]{0,200}releasePage\(\)/.test(code));

  // Each of these looks like the fix and is not. If one ever comes back as
  // the only thing holding the page, the reorder is broken again.
  check('preventDefault is not called on a pointermove, where it does nothing',
    !/pointermove[\s\S]{0,400}e\.preventDefault\(\)/.test(code));
  check('touch-action is still set on the element, but is not the mechanism',
    /card\.style\.touchAction = 'none'/.test(code));

  check('the drag corrects for the page moving under it',
    /pageY\(\) - gesture\.scroll0/.test(code));
}

console.log('\n15. reduced motion keeps the function and drops the movement');
{
  check('the preference is read', /prefers-reduced-motion: reduce/.test(code));
  check('and read live rather than cached', /const reduceMotion = \(\) =>/.test(code));
  check('there is a stylesheet rule too', /prefers-reduced-motion: reduce/.test(css));

  check('no growing when it is set', /reduceMotion\(\) \? '' : ' scale\(1\.03\)'/.test(code));
  check('no transitions', /on && !still \? `transform/.test(code));
  check('the drop commits straight away', /if \(reduceMotion\(\)\) return settle\(\);/.test(code));
  // The move itself, in the settle both paths run. It was a pair of splices on
  // `blocks` straight from the drag's own indexes, which is the bug that made a
  // drag move a block other than the one being carried on any day with an
  // anytime item in it: the rows on screen and the places in that array are not
  // the same list. `moveTimed` is the one conversion between them.
  check('but the reorder still happens', /moveTimed\(from, to\);/.test(code));
  check('and it goes through the one thing that knows rows from places',
    /function moveTimed\(/.test(code) && !/blocks\.splice\(to, 0, moved\)/.test(code));
}

console.log('\n16. the shape of the day');
{
  check('a Starts control', /id="wake-time"/.test(body));
  check('with steppers', /id="wake-minus"/.test(body) && /id="wake-plus"/.test(body));
  check('a + Block control', /id="add-block"/.test(body));

  // TWO WAYS IN, one with an hour and one without, sitting together so the
  // choice is legible.
  check('and a + Anytime beside it', /id="add-anytime"/.test(body));
  check('they are one pair', /class="adds"/.test(body));

  // THE LENGTHS, THREE AND TWO. Five pills of five different widths wrapped
  // wherever they ran out of room, which put four on one line and stranded one
  // on the next. A three-column grid decides the break instead of leaving it to
  // the text, and equal columns line the pills up down the sheet as well as
  // along it. Only this chooser: the others are two, three and four options
  // wide and sit on one line, where a grid would stretch them well past the
  // words they carry.
  check('the lengths are laid out three and two',
    /grid-template-columns: repeat\(3, 1fr\)/.test(rule('#size-seg')), rule('#size-seg'));
  check('and the other choosers are left to wrap',
    /flex-wrap: wrap/.test(rule('.choices')) && !/grid/.test(rule('.choices')), rule('.choices'));

  // THE ONE-OFF OFFER IS WITHDRAWN WHEN THE LENGTH CONTRADICTS IT. A task
  // declared as taking a week is not over after one day in the day.
  check('a length past a day takes the one-off choice away',
    /const canBeOnce = formType === 'task' && \(!length \|\| length === 'a day'\)/.test(code));
  check('and clears the flag with it, so a stale one cannot be saved',
    /if \(!canBeOnce\) formOnce = false;/.test(code));

  // AND A THIRD, WHICH BUILDS THE DAY RATHER THAN ADDING TO IT.
  {
    // AT THE FOOT OF THE DAY, ABOVE CONFIRM, which is the order it is used in:
    // build the day, look at it, commit it. It sat beside + Block first, where
    // it read as a third way to add one thing; then inside the empty row, where
    // it cost no room but went away with the first block, so a half-built day
    // could never be topped up.
    // IN THE ROW IT FILLS, as a mark. It is not in the markup at all: it lives
    // and dies with the empty row, so a control sitting in the page waiting for
    // a class would be a control that is usually furniture.
    check('the fill is not a standing control in the markup',
      !/id="fill-day"/.test(body) && !/class="fillrow/.test(body));
    check('it is drawn into the empty row', /empty\.append\(fillNow\(\)\)/.test(code));
    check('and only when there is something to fill with',
      /if \(fillable\(\)\.length\) empty\.append/.test(code));

    // BUILT WITH THE ROW, on every render. A handler wired once at startup
    // would be a handler on an element the next render throws away.
    const btn = (code.match(/function fillNow\(\)[\s\S]*?\n      \}/) || [''])[0];
    check('the press is built with the row it lives in',
      /b\.onclick = /.test(btn) && /fillDay\(\)/.test(btn), btn.slice(0, 60));

    // A MARK, NOT A WORD — which is the whole reason it is here rather than at
    // the foot of the page. A word under a column of figures had to argue for
    // its own face and its own alignment; a mark in the row it fills does not.
    check('it is a drawn mark rather than a label', /<svg /.test(btn) && !/Fill day/.test(btn));
    // AN ARROW ONTO A RULE: the drafting mark for putting something into a
    // table. It was three stacked bars, which is a hamburger — a menu
    // everywhere else on a phone — and made of the heaviest kind of mark there
    // is on a page built from hairlines.
    check('drawn as strokes, like every line on this page',
      (btn.match(/<path /g) || []).length === 3 && !/<rect /.test(btn),
      `${(btn.match(/<path /g) || []).length} paths`);
    check('and it carries a name for anything that cannot see it',
      /aria-label', 'Fill the day from your list'/.test(btn));

    // THE STATUS COLUMN'S WIDTH, so its right edge lands on the 372 every
    // figure on this page ends at.
    check('it takes the column the status would hold',
      /width: 64px/.test(rule('.fillnow')) && /justify-content: flex-end/.test(rule('.fillnow')),
      rule('.fillnow').replace(/\s+/g, ' ').slice(0, 90));
    // QUIET. One step darker than the row's own words and no more: the mark had
    // the accent and 2px bars, and the one saturated thing on the screen was
    // pointing at the emptiest part of it.
    check('the mark is grey rather than the accent',
      /color: var\(--faint\)/.test(rule('.fillnow')) &&
        !/var\(--accent\)/.test(rule('.fillnow')), rule('.fillnow').replace(/\s+/g, ' ').slice(0, 70));
    check('a step darker than the words beside it, which are the lightest grey',
      /color: var\(--ghost\)/.test(rule('.freenm')));
    check('and drawn in whatever the button carries, so the colour is stated once',
      /stroke: currentColor/.test(rule('.fillnow svg')));

    // STROKED AT THE FINE LINE, not filled. Every line on this page is a
    // hairline — the rules between rows, the dashed edge of the placeholder it
    // sits in, the box around the tick — and a mark made of filled shapes sits
    // on top of that ruling rather than in it.
    const ink = rule('.fillnow svg');
    check('the mark is stroked rather than filled',
      /fill: none/.test(ink) && !/fill: currentColor/.test(ink), ink.replace(/\s+/g, ' ').slice(0, 80));
    check('at the weight of the tick\'s border, which is this design\'s fine line',
      /stroke-width: 1\.25/.test(ink) && /border: 1\.25px/.test(rule('.atick')));

    // ITS OWN ANCHOR. `.atime` was missing exactly this once, and its invisible
    // full-bleed child lay over the whole screen and killed every gesture.
    check('the press anchors its own hit area',
      /position: relative/.test(rule('.fillnow')), rule('.fillnow').slice(0, 60));
    check('which it needs, because that area is absolute',
      /position: absolute/.test(rule('.fillnow::after')));

    // IT INVENTS NO ORDER OF ITS OWN. The list is already sorted pinned first,
    // then whatever is running out of room, and a second opinion about that
    // living in the fill is how the screen and the list start disagreeing about
    // which thing is most urgent. Same comparator, asked for by name.
    const fill = (code.match(/function fillDay\(\)[\s\S]*?\n      \}/) || [''])[0];
    check('the fill sorts by the screen\'s own comparator',
      /sortThings\(\);/.test(fill), fill.slice(0, 80));
    check('and holds no comparator of its own',
      !/\.sort\(/.test(fill) && !/localeCompare/.test(fill));

    const able = (code.match(/function fillable\(\)[\s\S]*?\n      \}/) || [''])[0];
    // TWO HALVES WITH A SHARE EACH. Read straight out of the list's order a pin
    // outranks everything, including a deadline that has already run out, so
    // four pins filled half the day before the arithmetic got a word in.
    check('the pins get slots of their own', /free\.filter\(\(t\) => t\.pinned\)\.slice\(0, BY_PIN\)/.test(able),
      able.slice(0, 140));
    check('and are capped at that many, not merely floored',
      /const BY_PIN = 3;/.test(code));
    // A pinned thing must not sit in both halves and take two slots for one row.
    check('what is urgent excludes what is pinned', /!t\.pinned && t\.mark/.test(able), able.slice(0, 200));
    // "If there isn't enough pins then it goes to another priority" — an empty
    // held-back slot would be the fill deciding to do less because nothing was
    // pinned, which is not a reason.
    check('unused pin slots go back to the order', /FILL_TO - pins\.length/.test(able), able.slice(0, 220));

    // WHICH THINGS AND IN WHAT ORDER ARE TWO QUESTIONS. The choosing is on the
    // merits; the running order is not part of that judgement, because a day
    // built by deadline puts the same thing at 9am every morning.
    check('the order is thrown away on the way into the day',
      /shuffled\(fillable\(\)\)/.test(fill), fill.slice(0, 90));
    // Only there. `fillable` also answers the render's question of whether to
    // draw the mark, which is about how many there are and not their order — a
    // shuffle in it would restir the day on every redraw.
    check('and not on every render', !/shuffled/.test(able), able.slice(0, 80));

    const stir = (code.match(/function shuffled\(list\)[\s\S]*?\n      \}/) || [''])[0];
    // NOT `sort(() => chance() - 0.5)`, which is how this usually gets written
    // and is not a shuffle: a comparison sort assumes a consistent comparator,
    // and given an inconsistent one it returns something that merely looks
    // stirred, with some positions far likelier than others.
    check('it is a real shuffle rather than a sort with a coin in it',
      /for \(let i = out\.length - 1/.test(stir) && !/\.sort\(/.test(stir), stir.slice(0, 80));
    check('and chance is behind a name, so a test can hold it still',
      /function chance\(\)/.test(code) && /chance\(\)/.test(stir));

    check('never a thing already in the day, so a second press is safe',
      /!inShownPlan\(t\.id\)/.test(able));
    check('and fills to a total rather than by a batch',
      /FILL_TO - timedBlocks\(\)\.length/.test(able));

    // NOTHING IS WRITTEN. It fills the builder and stops; Confirm still commits
    // the day, which is also the undo.
    check('the fill writes nothing to the server',
      !/api\(/.test(fill) && !/fetch\(/.test(fill), fill.slice(0, 80));
  }
  check('separated by space rather than a rule',
    /gap: \d+px/.test(rule('.adds')) && !/border/.test(rule('.adds')), rule('.adds'));

  // ABOVE THE SECTION IT FILLS, and this is the one that cannot be checked by
  // driving the page: the suite reaches controls by id wherever they sit, so a
  // button nested inside the Anytime section would answer a press in every case
  // and be unreachable on a real screen. The section is hidden until something
  // is in it, and a way in you cannot use until you have already used it is not
  // a way in.
  // IT SITS AT THE FOOT OF THE SECTION IT FILLS, which it could not do while
  // that section was hidden until something was in it. The heading and the way
  // in stay whatever the list holds now — a section you can only add to once it
  // is not empty is not a way in — so the rows have somewhere to arrive.
  check('the way in is inside the section it fills',
    body.indexOf('id="add-anytime"') > body.indexOf('id="anytime"'),
    `${body.indexOf('id="add-anytime"')} vs ${body.indexOf('id="anytime"')}`);
  check('and the section is always there to be added to',
    /class="anytime" id="anytime"/.test(body));

  // NOTHING ON THE THINGS LIST BEHIND IT. The whole point of the control: a
  // reminder is not something you are carrying, so it never becomes an entry.
  check('a one-off is added with no entry',
    /if \(kind === 'anytime'\) addAnytime\(\{ title: title\.trim\(\) \}\);/.test(code));

  // TYPED IN THE PAGE, NOT OVER IT. Both controls asked through the browser's
  // own prompt: a system dialog that covers the app and has to be dismissed
  // before anything can be seen again, one per block, on a day built several at
  // a time.
  // THE BROWSER'S OWN DIALOG. It was an inline field for a while, on the
  // argument that a system dialog covers the app and has to be dismissed before
  // anything can be seen again. All true, and not what matters: the dialog
  // arrives centred with the keyboard already up and the field already focused,
  // and it is the one every other app on the phone uses. The inline field asked
  // you to find a line at the foot of a list.
  check('the name is asked for in the browser\'s own dialog', /\bprompt\(/.test(code));
  check('and no field is left in the page', !/addfield/.test(body) && !/addfield/.test(css));
  check('a running day end', /id="end-time"/.test(body));
  check('and one Confirm', (body.match(/id="confirm"/g) || []).length === 1);

  check('the step is thirty minutes', /const STEP = 30;/.test(code));

  // The whole builder is one cursor walking down the list. If a second
  // starting point ever appears, blocks have stopped flowing in sequence.
  check('blocks flow from one cursor', /let cursor = wake;/.test(code));
  check('and each starts where the last ended', /cursor = b\.start \+ b\.duration;/.test(code));
}

console.log('\n17. today and tomorrow');
{
  console.log('   the switch is the label');
  check('there is no separate control', !/id="day-toggle"|class="tabs"/.test(body));
  check('the heading is the switch', /class="dayswitch"/.test(body));
  check('with both words', /id="pick-today"/.test(body) && /id="pick-tomorrow"/.test(body));
  check('and the date beside them', /class="date" id="plan-date"/.test(body));

  // THE ONE SENTENCE ON THE SCREEN. It was set as a label — small letterspaced
  // capitals, the same as every section head — which made the line naming the
  // day you are looking at read as a heading over the table rather than as the
  // title of the page.
  const sw = rule('.dayswitch');
  check('the day is a title, not a label',
    /font-size: 16px/.test(sw) && !/text-transform: uppercase/.test(sw), sw);
  check('set in the name face, with the names', !/var\(--mono\)/.test(sw), sw);
  check('and given room under it', /margin-bottom: \d+px/.test(sw), sw);
  // Lighter than the paper's own ink rather than darker than it — on paper the
  // way to recede is toward the page, not away from it.
  // It is the way back to the other day, so it is a control before it is a
  // shade — and at ghost it read as disabled text rather than as a way back.
  check('the inactive word recedes without going out',
    /color: var[(]--muted[)]/.test(rule('.dayswitch .opt')), rule('.dayswitch .opt'));
  check('the active one is full text', /color: var\(--text\)/.test(rule('.dayswitch .opt.on')));

  console.log('   today');
  // STILL PAPER, handled rather than withdrawn. It settles nearer the page and
  // its edge is displaced further and softened, which is what an edge does
  // after a day of being carried around. The dark build drew an outline; an
  // outline is a drawing of a thing, and this theme lays things down and takes
  // them away rather than drawing them.
  // A SPENT ROW IS GREYED, and that is all. It was a second paper colour with a
  // softer torn edge — an outline was refused then for the right reason, that
  // an outline draws a thing rather than laying it down, and the reason is gone
  // with the paper. What is left is the cheapest true statement: the same row,
  // quieter, on a faintly different ground.
  // OVER: every part of the row steps back a shade. Nothing is drawn
  // differently, nothing is taken away, and the status column says DONE.
  // Quieter, not unreadable. The hierarchy still holds — ink for a title still
  // to come, muted for one that is over — and both are legible.
  check('a finished block goes muted', /color: var\(--muted\)/.test(rule('.block.past .t')),
    rule('.block.past .t'));
  check('its figures go lighter still',
    /\.block\.past \.time,[\s\S]{0,80}color: var\(--faint\)/.test(css));
  check('and it is still a row, not an outline or a fill',
    !/border:/.test(rule('.block.past .t')));
  // Not just a past one. A block you are in the middle of kept its chip, and
  // shrinking it below the time already elapsed moved it into the past — an
  // action the server refuses on a delivered block anyway.
  check('a block that has begun gets no chip', /\} else if \(begun\) \{/.test(code));
  check('and one that is over carries no chip either',
    /if \(past\) \{\s*row\.append\(idx, left, doneLabel\(\)\);/.test(code));
  check('begun is read off the stored start, the same as the reflow',
    /const blockBegun = \(b\) => onToday\(\) && hasBegun\(b, nowMinutes\(\)\)/.test(code));
  check('and there is one definition of it', (code.match(/hasBegun\(/g) || []).length === 2,
    `${(code.match(/hasBegun\(/g) || []).length} uses`);
  check('and a fixed block cannot be picked up', /if \(isFixed\(\)\) return;/.test(code));

  // WHAT A PRESS MAY DO IS ASKED OF THE CLOCK, NOT OF THE LAST RENDER.
  //
  // The lock was a boolean captured when the card was drawn. Nothing
  // re-renders on a clock tick, so a page left open across a block's start
  // time went on offering the chip, the hold and the note swipe on a block
  // that had begun — and the chip only grows, wrapping 4h back to 30m, so one
  // press could end a running block before the current time.
  check('the gesture handlers read it live',
    /const isFixed = \(\) => blockFixed\(blocks\[index\]\)/.test(code));
  check('and none of them keep a captured copy',
    !/function attach\(\{[^}]*begun/.test(code),
    (code.match(/function attach\(\{[^}]*\}/) || [''])[0]);
  check('the chip refuses at the press, not only at the draw',
    /if \(blockBegun\(blocks\[i\]\)\) return renderBuilder\(\);/.test(code));
  check('and answers by redrawing, so a dead control does not sit there',
    /blockBegun\(blocks\[i\]\)\) return renderBuilder/.test(code));

  // THE MISS MECHANISM IS GONE, not hidden. Nothing asks whether a block
  // happened, nothing records that it did not, and there is no route left to
  // post it to. Taking the block out of the day is the whole of it.
  check('nothing asks whether it happened', !/didn't happen/.test(code));
  check('nothing posts a miss', !/\/miss/.test(code));
  check('and no block carries a missed flag', !/\bmissed\b/.test(code));

  // NO DIVIDER AT ALL. A line was drawn across the day where the past ended —
  // a knot and a rule, with no word, because every word tried there was a claim
  // about one side of it.
  //
  // The row you are in is marked four ways now: a bar in the gutter, a tinted
  // ground, a heavier name, and blue figures. A line above it is a fifth mark
  // for the same fact, and it was the only thing on the screen that was neither
  // a row nor a rule between two of them.
  check('nothing draws a line across the day', !/className = 'ln'/.test(code));
  check('nor the knot that fastened it', !/className = 'dot'/.test(code));
  check('and nothing is left counting one', !/markedNow/.test(code));
  check('nor styling one', !/\.now(?![\w-])/.test(css));
  check('the Starts control is hidden', /\$\('starts'\)\.classList\.toggle\('hidden', onToday\(\)\)/.test(code));

  console.log('   the past does not flow');
  check('a block that has begun keeps its hour',
    /hasBegun\(b, now\) || b\.sent/.test(code));
  // AND ONE WHOSE MESSAGE HAS ONLY GONE OUT. The scheduler delivers up to
  // fifteen minutes early, so the server locks a block before the clock says
  // it has begun — and reflow moving it produced a day the confirm refused
  // whole, over a block nobody had knowingly touched.
  check('and one whose message has gone out keeps it too',
    /const fixed = live && \(hasBegun\(b, now\) || b\.sent\)/.test(code));
  check('what is left starts at the next half hour', /Math\.max\(cursor, floor\)/.test(code));
  check('which is the boundary after now', /Math\.ceil\(nowMinutes\(\) \/ STEP\) \* STEP/.test(code));
  check('and a drifted day is not called confirmed', /if \(saved && drifted\(\)\) saved = false/.test(code));

  console.log('   which day opens');
  // TODAY THROUGH THE DAY, TOMORROW ONCE THE EVENING TURNS. Almost every visit
  // is a glance at what is on now, which is why it lands on today — but by the
  // nudge hour today is spent and the question worth opening the page for has
  // become tomorrow.
  //
  // It followed plans_in once, so an evening planner landed on tomorrow at any
  // hour. That is what this is not: who you are does not decide it, the clock
  // does.
  check('the day it opens on is decided by the hour',
    /showDay\(nowMinutes\(\) >= tomorrowFrom \* 60 \? 'tomorrow' : 'today'\)/.test(code));
  check('and the hour comes from the profile, not a constant on the page',
    /tomorrowFrom = Number\.isInteger\(data\.nudge_hour\)/.test(code));
  check('which is the same hour the nudge uses', /data\.nudge_hour/.test(code));
  check('the preference does not decide it',
    !/plans_in/.test(code), (code.match(/.*plans_in.*/) || [''])[0].trim());
  check('nor is there a settings UI for either', !/plans_in|nudge_hour/.test(body));

  console.log('   a thing already in the day');
  // Greying is the whole signal. It used to also say "in today's plan" beside
  // the row, which was a second way of saying what the colour already said.
  check('there is no badge left', !/inplan/.test(code) && !/inplan/.test(css));
  check('nor the words it carried', !/today's\} plan|tomorrow's\} plan/.test(code));

  // A TAP ALWAYS ADDS ONE, greyed or not, so the same thing can be scheduled
  // twice in a day — two sessions of one project is an ordinary way to plan.
  //
  // It used to take the thing back OUT when the row was grey, which made one
  // gesture mean opposite things depending on a state you had to read the
  // colour to know. Removal belongs to the block now, where what you are
  // pointing at is the thing being removed.
  check('a tap on a greyed row adds another', !/if \(locked\) return/.test(code));
  check('there is one branch, not two',
    /addBlock\(\{ title: item\.title, entryId: item\.id, note: item\.note \|\| null \}\);/.test(code));

  // AND IT BRINGS THE NOTE WITH IT, which is the point of being able to write
  // on a thing before it is scheduled. The anytime list always did this; a
  // timed block did not, so a note written in advance was invisible until the
  // day was confirmed — and the confirm was also the moment it was taken off
  // the thing, so it appeared in one place and vanished from the other at once.
  check('a tapped thing brings its note onto the block at once',
    /addBlock\(\{[^}]*note: item\.note \|\| null/.test(code));
  check('and the anytime list still does the same',
    /addAnytime\(\{[^}]*note: item\.note \|\| null/.test(code));
  check('addBlock can carry one at all', /function addBlock\(\{[^}]*note = null/.test(code));
  check('and nothing is left that takes a thing back out of the day',
    !/unschedule/.test(code) && !/lastBlockFor/.test(code));

  check('read off the blocks on screen, so removing one unlocks it',
    /blocks\.some\(\(b\) => b\.entryId === entryId\)/.test(code));
  check('a greyed row holds its warning mark back', /if \(!locked && item\.mark\)/.test(code));
  check('and the row is dimmed', /color: var[(]--muted[)]/.test(rule('.row.locked .title')));
  check('the menu is not locked with it', !/if \(locked\)[\s\S]{0,200}acts\.classList/.test(code));
}

console.log('\n18. every time on the page is twelve hour');
{
  check('one formatter, and it wraps at midnight', /const at = \(\(mins % 1440\) \+ 1440\) % 1440;/.test(code));
  check('midnight and noon are both 12', /h % 12 === 0 \? 12 : h % 12/.test(code));
  check('and it says which', /h < 12 \? 'AM' : 'PM'/.test(code));
  check('nothing renders a 24 hour clock beside it',
    !/pad\(Math\.floor\(\(mins % 1440\) \/ 60\)\)/.test(code));

  // The message path has its own copy, because it runs on the server.
  const msg = fs.readFileSync(ROOT + '/messages.js', 'utf8');
  check('Telegram gets the same', /'AM' : 'PM'/.test(msg));

  // Storage is untouched. The page still sends minutes and the row is still a
  // 24 hour `time`; only the reading of it changed.
  check('the page still sends minutes',
    /start_minutes: untimed\(b\) \? null : b\.start/.test(code));
  check('and still reads them', /toMinutes/.test(code));

  console.log('   the hours a day may start at, in two places');
  {
    // THE PAGE CANNOT IMPORT clock.js. It is a browser script inside one html
    // file, so the three numbers exist twice — and they have to agree about
    // more than taste. The route refuses a default outside the window; the
    // stepper is what a person has to reach it with. A window on the server
    // wider than the one on the screen leaves values nothing can step back
    // from; narrower, and the screen offers a press that always fails.
    const clockSrc = fs.readFileSync(ROOT + '/clock.js', 'utf8');
    const num = (src, name) => {
      const m = new RegExp(`${name} = ([^;]+);`).exec(src);
      if (!m) return null;
      // `4 * 60` on both sides, evaluated rather than string-matched, so the
      // check is about the value and not about how it is spelled.
      return /^[\d\s*+]+$/.test(m[1]) ? Function(`return (${m[1]})`)() : null;
    };

    for (const name of ['WAKE_MIN', 'WAKE_MAX']) {
      const onServer = num(clockSrc, name);
      const onPage = num(code, name);
      check(`${name} is the same number in clock.js and on the page`,
        onServer !== null && onServer === onPage, `${onServer} vs ${onPage}`);
    }

    // The page calls its step STEP, because everything on that screen moves in
    // it: durations, block starts, the wake time. The server names the one
    // this window is measured in.
    check('and they step by the same half hour',
      num(clockSrc, 'WAKE_STEP') === num(code, 'STEP'),
      `${num(clockSrc, 'WAKE_STEP')} vs ${num(code, 'STEP')}`);
  }
}

console.log('\n19. a sheet is inside its scrim');
{
  // THE BUG THIS EXISTS FOR, and it was visible on the first tap.
  //
  // The settings sheet was written as a SIBLING of its scrim, wrapped in a
  // class — `.sheet-wrap` — that had no rule anywhere behind it. So the scrim
  // did its job, greying the screen and covering it, while the sheet itself
  // laid out in ordinary document flow at the foot of the page: you had to
  // scroll past the whole planner to find it, and every tap on it landed on
  // the fixed scrim in front and closed the thing you were reaching for.
  //
  // `.scrim` is not a backdrop, it is the flex box that HOLDS the sheet
  // against the bottom of the window. A sheet outside one has no position at
  // all.
  const sheets = [...body.matchAll(/<div class="scrim[^"]*"[^>]*>([\s\S]*?)<div class="sheet"/g)];
  const allSheets = (body.match(/<div class="sheet"/g) || []).length;

  check('there are sheets to check', allSheets > 0, String(allSheets));
  check('and every one of them sits inside a scrim', sheets.length === allSheets,
    `${sheets.length} of ${allSheets}`);

  // No class may be used in the markup that the stylesheet never defines. That
  // is what made the above survive being looked at: `.sheet-wrap` read as
  // deliberate.
  const used = new Set();
  for (const m of body.matchAll(/class="([^"]+)"/g)) {
    for (const name of m[1].split(/\s+/)) if (name) used.add(name);
  }
  const undefinedClasses = [...used].filter((name) => !new RegExp(`\\.${name}[\\s,:.{>]`).test(css));
  check('no class is used that the stylesheet does not define',
    undefinedClasses.length === 0, undefinedClasses.join(', '));

  // AND THE SAME QUESTION THE OTHER WAY ROUND, which is the half that was
  // missing. A class defined and never worn is not a broken screen, so nothing
  // ever went red for one — the paste pipeline was deleted and left `.preview`
  // and `.pline` behind, four rules of styling for a feature that no longer
  // exists. Two of them were coloured, so the page had ink spent on nothing,
  // and the colour rules below counted them as live uses.
  //
  // Every word outside the stylesheet counts as wearing it, however it got
  // there — a class attribute, a className, a classList call. Bluntly, because
  // a false "dead" costs more than a false "alive": one of them deletes
  // something that renders.
  //
  // THE KNOWN GAP, and it is the price of that choice rather than an oversight:
  // a class named after a common English word hides in prose. `.bar` outlived
  // the section that used it because the comments elsewhere say "undo bar" and
  // "address bar", and this read those as somebody wearing it. Erring the other
  // way would mean this check occasionally proposing to delete live styling,
  // which is worse — so short generic class names are the thing to avoid rather
  // than the check being the thing to loosen.
  // BOTH, and the script is the half that matters. `body` is the markup alone,
  // and most of this page's classes are set from script — every block, every
  // row, every bar. Asking the markup only reported forty-eight live classes
  // as dead on the first run.
  const worn = new Set();
  for (const m of (body + code).matchAll(/[a-zA-Z][\w-]*/g)) worn.add(m[0]);

  const defined = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);

  // `.w3` and `.org` are not classes. They are the middle of `www.w3.org` in
  // an inline SVG data uri that lives inside the stylesheet, which is the one
  // place a dot-word appears in this file without being a selector.
  const notSelectors = new Set(['w3', 'org']);

  const unworn = [...defined].filter((c) => !worn.has(c) && !notSelectors.has(c));
  check('nor does the stylesheet define one that nothing wears',
    unworn.length === 0, unworn.map((c) => '.' + c).join(', '));

  // A tap inside a sheet must not close it: a scrim guards on the target
  // being the scrim itself, or every tap on the sheet bubbles up and dismisses
  // the thing being reached for.
  //
  // ONE GUARD PER SCRIM, counted rather than fixed at a number. It was `>= 2`,
  // which went red the day setup stopped being a sheet — correctly, in that
  // something had changed, but for the wrong reason: nothing had lost a guard,
  // there was simply one fewer scrim. Setup is a full page now and has no
  // outside to tap.
  const scrims = (body.match(/class="scrim[^"]*"/g) || []).length;
  const guards = (code.match(/if \(e\.target === \$\('[a-z-]+'\)\) close/g) || []).length;
  check('every scrim guards against a tap inside it', guards >= scrims,
    `${guards} guard(s) for ${scrims} scrim(s)`);

  // And the page has no such handler, deliberately: every pixel belongs to it,
  // so a stray tap on the background would close a screen someone was reading.
  check('the full-screen page has no tap-outside to close',
    !/\$\('settings-scrim'\)\.onclick/.test(code));

  // NOBODY IS SENT TO SETUP. A new account opened on it for one release, on
  // the reasoning that an empty day cannot explain itself. Watching an actual
  // new person meet it settled that the other way: the first thing between you
  // and what you signed up for should be what you signed up for.
  //
  // So the way out is Back and only Back — there is always a day behind it —
  // and nothing decides on your behalf that you should be looking at this.
  // A CLOSE, NOT A BACK, and the rule survives the change: what matters is
  // that the way out is never a word for having been SENT here. "Close" is
  // truer than "back" for a page laid over the day rather than a place further
  // into it.
  check('the way out of setup closes it',
    /id="settings-close"[^>]*>×</.test(body));
  // Top right, which is where a screen laid over another one is closed.
  check('and it sits at the far edge, with the title taking the room',
    /justify-content: space-between/.test(rule('.page-top')), rule('.page-top'));
  // AND IT IS STILL NAMED. Stripped to one glyph, this button is punctuation:
  // a screen reader announces "multiplication sign", or nothing. The label is
  // the only thing left saying what it does.
  // A GLYPH BESIDE A LABEL IS CENTRED, NOT BASELINED. It was baselined while
  // the way out read '‹ Back' at 13px: two pieces of text sharing a line. One
  // 22px glyph beside a 9.5px label is not that, and a baseline aligns letters
  // — which one of these is not.
  check('the setup header centres its control against its title',
    /align-items: center/.test(rule('.page-top')), rule('.page-top'));
  // Even top and bottom, and the inset on the side it does NOT sit against —
  // the × is at the right edge now, so the padding that keeps the glyph on the
  // page's own margin moved with it.
  check('and the button is padded evenly, so centring is not skewed by it',
    /padding: 6px 0 6px 12px/.test(rule('.back')), rule('.back'));
  check('and it says so to anything that cannot see it',
    /id="settings-close"[^>]*aria-label="Close"/.test(body), 'aria-label is the whole name');
  check('and never a word for having been sent there',
    !/Skip for now/.test(body) && !/Skip for now/.test(code));
  check('opening setup takes no argument, so nothing can force it',
    /function openSettings\(\) \{/.test(code), 'a parameter here is a way to be sent');
  check('and the opening sequence does not decide for you',
    !/needsSetup|firstRun|forcedSetup/.test(code));
}

console.log('\n20. an empty list shows where its first row would go');
{
  // A day with nothing in it drew three 1.5px rules inside 350px with nothing
  // between them, and read as a pile of empty boxes. What fills the voids is the
  // reference's own vocabulary for an empty region.
  //
  // Which rows appear when is driven and proved in builder-test. What cannot be
  // driven is what they LOOK like — the hatching, the dashed weight, and the
  // bleed to both edges are exactly the sort of thing that can be deleted while
  // every behavioural check keeps passing.
  const free = rule('.free');

  // HATCHED. The drafting convention for an empty region, at the reference's
  // angle: -45deg, in 5px bands.
  check('the empty space is hatched',
    /repeating-linear-gradient\(-45deg/.test(free), free.replace(/\s+/g, ' ').slice(0, 110));

  // DASHED, which is this design's third rule weight and the one that means
  // "not a row at all". A hairline here would claim it is one.
  check('and closed by the weight that means it is not a row',
    /border-bottom: 1px dashed/.test(free), free.replace(/\s+/g, ' ').slice(0, 110));
  check('which is a different weight from the one between two real rows',
    /border-bottom: 1px solid var\(--line\)/.test(rule('.block')) &&
      !/dashed/.test(rule('.block')));
  check('and from the one that ends a section',
    /border-top: 1\.5px solid var\(--heavy\)/.test(rule('.ends')));

  // FULL BLEED, LIKE EVERY ROW. Hatching that stopped at the gutter would draw a
  // box on the page instead of a band across it.
  check('it reaches both edges the way a row does',
    /margin-left: -18px/.test(free) && /margin-right: -18px/.test(free));
  check('and puts its words back on the gutter',
    /padding-left: 18px/.test(free) && /padding-right: 18px/.test(free));

  // SHORTER THAN A REAL ROW, so an empty day does not look like a full one. A
  // block is 68px; this carries one word.
  check('and stands shorter than the row it stands in for',
    !/min-height/.test(free) && /padding-top: 13px/.test(free), free.replace(/\s+/g, ' '));
  check('which is worth saying because a real block is not short',
    /min-height: 68px/.test(rule('.block')));

  // EACH LIST'S OWN COLUMNS. The words start where that list's words start —
  // the table leads with a 22px index, the anytime list with a 15px tick — so
  // the space where a row would be lines up with the rows around it.
  check('the anytime list keeps its own gap', /gap: 12px/.test(rule('.free-anytime')));
  check('and its own leading column', /width: 15px/.test(rule('.freebox')));
  check('which is the width of the tick it stands in for',
    /width: 15px/.test(rule('.atick')));
  check('while the table reuses the real index column',
    /freeRow\('block'/.test(code) && /lead\.className = kind === 'block' \? 'idx' : 'freebox'/.test(code));

  // AND NO STATUS COLUMN. It held an em dash, on the reasoning that the space
  // where a row would be should carry that row's columns. A status is a fact
  // about a block — over, running, still to come — and there is no block here to
  // be in any of them, so the dash was a value in a column reporting on nothing.
  {
    const fr = (code.match(/function freeRow\(kind, label\) \{[\s\S]*?\n      \}/) || [''])[0];
    check('the space where a row would be carries no status',
      Boolean(fr) && !/'st'/.test(fr) && !/—/.test(fr), fr.slice(0, 100));
    check('and no rule is left styling one', !/\.free \.st/.test(css));
  }

  // IN THE GREY THAT CARRIES NO WORDS AT A BODY SIZE, which is what this is for:
  // it is the lightest thing on the page and it is not meant to be read twice.
  check('the words are the lightest grey', /color: var\(--ghost\)/.test(rule('.freenm')));
  check('at a size below the body', /font-size: 12px/.test(rule('.freenm')));

  // NOT A ROW, and this is the one that matters. Everything that acts on a block
  // finds it by `.slot` and by its place in `blocks`; a placeholder carrying
  // either would be draggable, swipeable, and countable as part of the day.
  const freeRow = (code.match(/function freeRow\(kind, label\) \{[\s\S]*?\n      \}/) || [''])[0];
  check('the space where a row would be is not one', Boolean(freeRow) &&
    !/'slot'/.test(freeRow) && !/dataset/.test(freeRow), freeRow.slice(0, 80));

  // AND THE BLANK CARD DID NOT COME BACK. Held-open room that says nothing is
  // what this replaced, twice over.
  check('nothing holds room open without saying why',
    !/visibility: hidden/.test(css) && !/ghostCard|spacerCard/.test(code));
}

console.log('\n17. the mockup still describes the page');
{
  // A reference artifact that no longer matches is worse than none: it is a
  // second answer to "what should this look like", and the wrong one.
  //
  // Not a pixel comparison — it is a static file with no script and cannot
  // show a live day. What is checked is that the two agree on the palette,
  // and that every element the page grew has a counterpart there.
  const mock = fs.readFileSync(ROOT + '/public/mockup.html', 'utf8');

  // Read from the palette the page actually declares rather than written out
  // again here. Listed twice, the two lists drift — and this one drifted the
  // moment the theme changed, reporting eight failures about inks neither file
  // still contained.
  for (const value of Object.values(want)) {
    check(`${value} is in both`,
      new RegExp(value, 'i').test(mock) && new RegExp(value, 'i').test(css));
  }

  for (const [what, klass] of [
    ['the row hint', 'hint'],
    ['the revealed actions', 'rowacts'],
    ['the swipe backing', 'backing'],
    ['a note', 'note'],
    ['the note editor', 'noteedit'],
    ['the duration chip', 'dur'],
    ['a lifted block', 'lifted'],
    ['the dimmed others', 'dimmed'],
    ['the undo bar', 'undo'],
    ['the calendar aside', 'cal'],
    ['a pressable event', 'calrow'],
    ['its title, which is what you tap', 'ctitle'],
    ['the saved list', 'saved'],
    ['block cards', 'block'],
    ['the add sheet', 'sheet'],
    ['the day switch', 'dayswitch'],
    ['a past block', 'past'],
    ['the empty day spacer', 'ghost'],
    ['the block in progress', 'running'],
    ['the NOW divider', 'now'],
    ['a locked row', 'locked'],
  ]) {
    check(`${what} is drawn in the mockup`, new RegExp(`class="[^"]*\\b${klass}\\b`).test(mock), klass);
  }

  check('both swipe directions are shown',
    /backing left/.test(mock) && /backing right/.test(mock));
  check('and the left one means one thing',
    /left">Remove/.test(mock) && !/didn't happen<\/div>/.test(mock) &&
      !/left calm">happened/.test(mock));
  check('including on a block that is over',
    /left">Remove[\s\S]{0,200}block past/.test(mock));
  check('one surface there too, with no tone classes left',
    !/backing[^"]*\b(hot|calm)\b/.test(mock), (mock.match(/class="backing[^"]*"/g) || []).join(' | '));
  check('and side is still only the edge',
    /\.backing\.left\{justify-content:flex-end\}/.test(mock.replace(/\s/g, '')));
  check('it shows all three row actions',
    /Done/.test(mock) && /Edit/.test(mock) && /Delete/.test(mock));

  // The switch has a reference of its own, which is where it came from.
  const sw = fs.readFileSync(ROOT + '/public/switch.html', 'utf8');
  check('switch.html is kept as the reference for the day switch',
    /class="dayswitch"/.test(sw));
  check('it shows both states', /opt on">Today/.test(sw) && /opt on">Tomorrow/.test(sw));
  // The reference was drawn in the washi palette and its tan is not a colour
  // this page has any more. What still has to hold is the RELATION: the day you
  // are not looking at recedes toward the page rather than away from it.
  check('and the page recedes it the same way',
    /color: var[(]--muted[)]/.test(rule('.dayswitch .opt')));

  // What was replaced must not survive in the reference either.
  check('no tab bar', !/class="tabs"/.test(mock));
  check('no Money', !/Money/.test(mock));
  check('and no Yesterday section', !/>Yesterday</.test(mock));
  check('no steppers on a block',
    !/class="block"[\s\S]{0,200}class="stepper"/.test(mock));
  check('no keep/remove confirm', !/confirming/.test(mock));
  check('and no script, because it is a drawing', !/<script/.test(mock));
}

console.log(bad === 0 ? '\nLayout clean' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
