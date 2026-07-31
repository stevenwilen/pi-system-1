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
const css = html
  .slice(html.indexOf('<style>'), html.indexOf('</style>'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

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
const body = html
  .slice(html.indexOf('<body>'), html.indexOf('</body>'))
  .replace(/<script>[\s\S]*?<\/script>/, '')
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
const want = {
  '--bg': '#f5f1e8',
  '--card': '#e7e0d2',
  '--line': '#ded7c8',
  '--text': '#2b2a28',
  '--muted': '#5f5a52',
  '--faint': '#8a857c',
  '--accent': '#37516e',
  '--warn': '#b8492a',
};

console.log('1. the palette is exactly the one specified');
{
  const root = rule(':root');
  for (const [name, value] of Object.entries(want)) {
    check(`${name} is ${value}`, new RegExp(`${name}:\\s*${value}\\s*;`, 'i').test(root));
  }

  // CONTRAST, because this is the failure the theme is most prone to and the
  // one that cost the reference its legibility. Paper is the look; readable is
  // the requirement, and where they disagree the requirement wins.
  //
  // WCAG relative luminance, then the contrast ratio against the paper.
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const against = (hex, bg = '#f5f1e8') =>
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
    against(ink('--muted')) >= 4.5,
    `${ratio(ink('--muted'))}:1 (reference was #7C7871 at ${ratio('#7c7871')}:1)`);
  check('indigo clears it, because it carries words and not just lines',
    against(ink('--accent')) >= 4.5, `${ratio(ink('--accent'))}:1`);
  check('persimmon clears it as ink on the page',
    against(ink('--warn')) >= 4.5, `${ratio(ink('--warn'))}:1`);
  // The hanko is the other direction: paper-coloured text on a persimmon
  // ground. Same pair, and it has to clear the bar both ways round.
  check('and the hanko clears it the other way, paper on persimmon',
    against(ink('--bg'), ink('--warn')) >= 4.5,
    `${Math.round(against(ink('--bg'), ink('--warn')) * 10) / 10}:1`);
  check('the faint ink clears 3:1, which is all it is asked to carry',
    against(ink('--faint')) >= 3, `${ratio(ink('--faint'))}:1`);

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
  check('9.5px', /font-size: 9\.5px/.test(label));
  check('uppercase', /text-transform: uppercase/.test(label));
  check('0.26em tracking', /letter-spacing: 0\.26em/.test(label));
  check('and set at 400, because 300 disappears at this size',
    /font-weight: 400/.test(label));
  check('muted', /color: var\(--muted\)/.test(label));

  // Baseline, so the action sits on the label's line rather than centred
  // against a taller box.
  check('the action shares its baseline', /align-items: baseline/.test(label));

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

console.log('\n3. rows are rows; only builder blocks are cards');
{
  const row = rule('.row');
  const divider = rule('.row + .row');

  check('a row has no background', !/background/.test(row), row);
  check('nor a radius', !/border-radius/.test(row), row);
  check('rows are separated by a hairline', /border-top: 1px solid var\(--line\)/.test(divider));
  check('and only between them, never around them',
    !/border:/.test(row) && css.indexOf('.row + .row') > -1);

  const block = rule('.block');
  // The paper sits on the layer behind the text, so that is where to look for
  // it. See the deckle checks below for why it is not on the slip itself.
  check('a block IS a card', /background: var\(--card\)/.test(rule('.block::after')));
  // NO RADIUS. The edge is torn rather than cut — the deckle filter displaces
  // the whole shape through turbulence, so no two slips share an edge. A
  // rounded rectangle behind a torn edge is two different ideas about one
  // object.
  check('but not a radius: paper is torn, not cut', !/border-radius/.test(block), block);
  check('its edge is displaced rather than drawn',
    /filter: url\(#deckle\)/.test(rule('.block::after')));

  // THE DECKLE NEVER TOUCHES TEXT, and this is the check that matters most in
  // this theme.
  //
  // A CSS filter applies to an element and everything inside it. Put the
  // deckle on the slip and feDisplacementMap pushes the title and the time
  // through the same turbulence as the edge — every glyph bent, reading as a
  // strange handwritten typeface. It is close to untraceable from the symptom:
  // the property is named for an edge and the damage is to the words.
  //
  // So every filtered thing is a pseudo-element holding a background and
  // nothing else. Any rule that carries a deckle must be a ::before or an
  // ::after.
  for (const m of css.matchAll(/\n {6,8}([^{@\n][^{]*?)\{([^}]*)\}/g)) {
    if (!/url\(#deckle/.test(m[2])) continue;
    const selector = m[1].trim().replace(/\s+/g, ' ');
    check(`the deckle on ${selector} is on a layer, not on the text`,
      /::(before|after)\s*$/.test(selector), selector);
  }

  check('and the slip itself carries none of it',
    !/filter/.test(rule('.block')), rule('.block'));
  check('nor does the undo bar, which had the same fault',
    !/filter/.test(rule('.undo')), rule('.undo'));
  check('and the filter really exists in the markup',
    /<filter id="deckle">/.test(body) && /feDisplacementMap/.test(body));
  check('the slot does not clip it flat',
    !/overflow: hidden/.test(rule('.slot')), rule('.slot'));

  // Nothing else may take the card background. It is the mark of an object you
  // manipulate. The disabled Confirm was on this list and has come off it: a
  // sealed day is still ink, not paper.
  const carded = selectorsUsing('var(--card)').filter((s) => !/^:root/.test(s));
  check('nothing else uses the card background',
    carded.every((s) => /\.block|\.undo/.test(s)), carded.join(' | '));
}

console.log('\n4. sections are separated by space, not by boxes');
{
  const section = rule('.section');
  check('36px between sections', /margin-bottom: var\(--gap\)/.test(section));
  check('and the gap is 36px', /--gap:\s*36px/.test(rule(':root')));
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
  check('the title is 15px', /font-size: 15px/.test(rule('.row .title')));

  const meta = rule('.row .meta');
  check('the meta is 12px', /font-size: 12px/.test(meta));
  check('and muted', /color: var\(--muted\)/.test(meta));
  check('on its own line, with space above it', /margin-top: 7px/.test(meta));
  check('and letterspaced, the way a catalogue sets its particulars',
    /letter-spacing: 0\.08em/.test(meta));
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
  const acts =
    /\.step|\.dur|\.undo button|\.addblock|\.label \.act|\.sheet-actions \.save|\.gate-swap|\.gate-field input:focus/;
  // The divider: the knot and the line it fastens. Both are indigo now, where
  // the dark build tinted the line with a separate near-blue that belonged to
  // nothing — one fewer colour on the page, and the two halves of one object
  // finally the same colour.
  //
  // It says "here is where you are", which is the nearest thing to an action
  // that is not one. Listed by name so a third has to be argued for here.
  const orients = /\.now \.dot|\.now \.ln/;
  check('blue appears only on the controls that act, or the one that orients',
    blue.every((s) => acts.test(s) || orients.test(s)), blue.join(' | '));
  check('and nothing decorative has it',
    !blue.some((s) => /\.cal|\.backing|\.block\b|\.row\b/.test(s)), blue.join(' | '));

  check('the start steppers are blue', /color: var\(--accent\)/.test(rule('.step')));
  check('the duration chip is blue, because it is now the control',
    /color: var\(--accent\)/.test(rule('.dur')));
  // Confirm is NOT indigo any more — it is the hanko, and a seal is stamped in
  // persimmon. That moves it under the warn colour's list, which is the one
  // deliberate widening this theme asks for: see section 7.
  check('confirm is not indigo, because it is a seal',
    !/var\(--accent\)/.test(rule('.confirm')), rule('.confirm'));

  // THE SEAL HAS NO RING. A real hanko is carved in relief, so its border
  // stands and prints while the cut stays paper — which is what the reference
  // drew. On screen that reads as a line drawn around a button, and drawing is
  // the one thing this theme does not do. What makes it a stamp is the edge:
  // pressed by hand, ink does not land square.
  check('no ring is drawn around it', !/box-shadow/.test(rule('.confirm')), rule('.confirm'));
  check('its edge is pressed rather than cut',
    /filter: url\(#deckle\)/.test(rule('.confirm::after')));

  // AND NOTHING ACROSS THE MIDDLE. It carried four pale flecks, meant as ink
  // not taking evenly. At this size and softness they did not read as texture —
  // they read as bubbles trapped under a sticker, which is a defect rather than
  // a mark. The uneven edge is what says stamp; the middle is solid ink.
  check('the ink is solid, with no flecks in it',
    !/gradient/.test(rule('.confirm::after')), rule('.confirm::after'));

  // A SEALED DAY IS STILL INK. It used to go paper-and-grey when confirmed,
  // which read as the button being taken away rather than the day being
  // agreed to. Same persimmon, so the contrast holds both ways round; what
  // changes is that the ink has settled into a softer bite.
  check('confirmed stays persimmon rather than going to paper',
    !/background/.test(rule('.confirm:disabled')), rule('.confirm:disabled'));
  check('and keeps its full contrast',
    /color: var\(--bg\)/.test(rule('.confirm:disabled')));
  check('the sealed day settles into a softer edge',
    /filter: url\(#deckle-soft\)/.test(rule('.confirm:disabled::after')),
    rule('.confirm:disabled::after'));
  // UNDER THE HAND. Saving is a round trip, so the seal used to say nothing
  // for about a second after the tap, which reads as a tap that missed.
  // Leaning on a real stamp drives more ink in and seats it, and that is the
  // whole of the feedback.
  // Read once and asserted non-empty first, because "no second red in it" is
  // true of a rule that is not there at all.
  const pressed = rule('.confirm.pressing::after');
  check('the pressed seal is styled at all', pressed !== '');
  check('it deepens its ink', /brightness\(/.test(pressed), pressed);
  check('deepened rather than given a second red',
    !/#[0-9a-f]{6}/i.test(pressed), pressed);
  check('and it is still the same torn edge',
    /url\(#deckle\)/.test(pressed), pressed);
  check('the stamp seats a hair into the paper',
    /transform: scale\(0\.9/.test(rule('.confirm.pressing')), rule('.confirm.pressing'));

  // Source order is what decides here: `.confirm.pressing::after` and
  // `.confirm:disabled::after` carry the same weight, and the seal has to stay
  // pressed until the answer is in rather than lighten the moment the word
  // changes to Confirmed. Both indexes checked, or a missing settled rule
  // would read as the pressed one winning.
  const atPressed = css.indexOf('.confirm.pressing::after');
  const atSettled = css.indexOf('.confirm:disabled::after');
  check('the pressed seal outranks the settled one',
    atSettled !== -1 && atPressed > atSettled, `${atSettled} then ${atPressed}`);

  check('undo is blue, because undoing is an action',
    /color: var\(--accent\)/.test(rule('.undo button')));

  // The specific traps: the calendar aside and the type chooser both look
  // like places a designer would reach for an accent, and neither is one.
  check('the calendar aside is not blue', !/--accent/.test(rule('.cal')));
  check('nor its rule', !/--accent/.test(rule('.cal h4')));
  check('the type chooser is not blue', !/--accent/.test(rule('.choices button')));
  check('nor when chosen', !/--accent/.test(rule('.choices button[aria-pressed="true"]')));
  check('a disabled stepper goes faint, not pale blue',
    /color: var\(--faint\)/.test(rule('.step:disabled')));

  // The near miss. "active" sits in the slot the duration chip vacates, and
  // the NOW divider right above it is blue for saying the same thing — so
  // blue is the obvious reach. It is wrong here: that slot has held a
  // tappable pill on every block above this one, and a blue word in it is an
  // invitation to press something that does nothing.
  check('the active label is not blue', !/--accent/.test(rule('.running')));
}

console.log('\n7. the warn colour warns; it does not narrate');
{
  // It marks a deadline running out, a day running past midnight, a feed that
  // failed, and Delete in the row menu. It had two other jobs and has lost
  // both: a missed block, which is a concept that no longer exists, and the
  // swipe backing, which filled the whole card while a finger was on it.
  const warn = selectorsUsing('var(--warn)').filter((s) => !/^:root/.test(s));
  // THE HANKO JOINS THE LIST, and it is the only addition this theme makes.
  // A seal is stamped in persimmon; it is the one warm thing on the page and
  // the one press that commits a day. Listed by name so a second addition has
  // to be argued for here rather than added quietly.
  // `.gate-problem` is the same job as `.problem` in the add sheet: a form
  // saying why it will not accept what it was given. Not a new use of the
  // colour, the same one on a second form.
  const allowed = /\.mark|\.ends\.late|\.failed|\.danger|\.problem|\.confirm|\.gate-problem/;
  check('used only on marks, failures, Delete and the seal',
    warn.every((s) => allowed.test(s)), warn.join(' | '));
  check('and nothing is left claiming a miss', !/askmiss|wasmissed/.test(css));

  // ONE SURFACE FOR BOTH SWIPES. The removing side used to be the warn colour
  // across the whole card. A removal carries a six-second undo, so the colour
  // was not what made it safe — it was just loud, and loudest on a past block,
  // where taking the block out is how the day is recorded rather than damage.
  const backing = rule('.backing');
  // On its layer, like every other sheet of paper here.
  check('the backing is the neutral surface',
    /background: var\(--line\)/.test(rule('.backing::after')));
  check('and it is torn like the slip that covers it, not a hard rectangle',
    /filter: url\(#deckle/.test(rule('.backing::after')));
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
    /start\(\)\.finally\(uncover\)/.test(code));
  check('and leaves the layout rather than sitting invisible over it',
    /style\.display = 'none'/.test(code));

  // Motion is the default, stillness is the setting — not a lesser version. A
  // quarter arc held still reads as something half-drawn, so it closes into
  // the whole outline: a complete shape, plainly deliberate.
  const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce'));
  check('reduced motion stops the turn',
    /#booting span,\s*\.waiting span \{\s*animation: none/.test(reduced),
    reduced.slice(0, 120));
  check('and closes the arc into a whole circle rather than freezing it',
    /animation: none;\s*border-color: var\(--text\)/.test(reduced));

  // The seal's answer survives the setting. Only the seating is movement; the
  // ink deepening is not, and dropping it would leave the press unanswered
  // for exactly the people least served by that.
  check('a still seal keeps its answer and loses only the seating',
    /\.confirm\.pressing \{\s*transform: none/.test(reduced), reduced.slice(-260));
}

console.log('\n7a-iii. an empty day keeps a block\'s worth of room');
{
  // Nothing scheduled collapsed the builder to nothing, putting Starts against
  // + Block. Built from a real block card rather than a min-height: the number
  // would have to be maintained against the card's padding, its two line
  // heights and the gap below it, and would go wrong the first time any of
  // those changed — silently, because nothing would fail.
  const ghost = rule('.block.ghost');
  check('there is a spacer', ghost.length > 0);
  check('it is hidden, not removed — the space is the point',
    /visibility: hidden/.test(ghost), ghost);
  check('and not display:none, which would take the space with it',
    !/display: none/.test(ghost), ghost);

  check('it is a block card, so it cannot drift from one',
    /ghost\.className = 'block ghost'/.test(code));
  check('shown only when the day is empty',
    /if \(!blocks\.length\) box\.append\(emptySpace\(\)\)/.test(code));
  check('and hidden from a screen reader',
    /setAttribute\('aria-hidden', 'true'\)/.test(code));
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
  check('it is muted, not faint', /color: var\(--muted\)/.test(act));
  check('it is 12px, like the chip it replaces', /font-size: 12px/.test(act));
  check('it does not wrap', /white-space: nowrap/.test(act));

  // Not a control: no border, no background, nothing to press.
  check('it has no pill border, unlike the chip it replaces', !/border/.test(act), act);
  check('and no background', !/background/.test(act), act);

  // But it does keep the chip's BOX. Without the padding a bare label sits
  // 15px closer to the card edge than chip text does, because the chip carries
  // that inset inside its border — so "active" crowded the edge while every
  // block above it looked comfortable. Matching it also keeps a begun block the
  // same height as its neighbours.
  const chip = rule('.dur');
  const pad = (r) => (r.match(/padding: ([^;]+);/) || [])[1];
  check('it borrows the chip\'s padding, so the word is not against the edge',
    pad(act) === pad(chip), `${pad(act)} vs chip ${pad(chip)}`);

  check('the word is "active"', /className = 'running';[\s\S]{0,120}textContent = 'active'/.test(code));
  check('a block that has begun gets it',
    /\} else if \(begun\) \{\s*row\.append\(left, activeLabel\(\)\);/.test(code));
  check('and a block that is over gets nothing beside it',
    /if \(past\) \{\s*row\.append\(left\);/.test(code));
}

console.log('\n8. the calendar aside is a left rule, not a card');
{
  const cal = rule('.cal');
  check('a left rule', /border-left: 2px solid/.test(cal));
  check('and only a left rule', !/border-top|border-right|border-bottom|border:/.test(cal), cal);
  check('no background', !/background/.test(cal), cal);
  check('no radius', !/border-radius/.test(cal), cal);
  check('the text is indented from the rule', /padding: [^;]*13px/.test(cal), cal);

  check('its heading is neutral warm grey', /color: var\(--cal-head\)/.test(rule('.cal h4')));
  check('and its body too', /color: var\(--cal-text\)/.test(rule('.cal p')));

  const root = rule(':root');
  check('which is a warm grey, not a blue', /--cal-head:\s*#5f5a52/i.test(root));
  check('and not persimmon either', !/--cal-head:\s*#b8492a/i.test(root));
}

console.log('\n9. tabular figures on every time');
{
  for (const [what, selector] of [
    ['the start time', '.num'],
    ['a block time', '.block .time'],
    ['a block duration', '.dur'],
    ['the day end', '.ends b'],
    ['the calendar aside', '.cal p'],
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
    ['the setup interview', /setup-prompt|plan-intent|\/import/i],
    ['pause and unpause', /\/pause|paused_at|\bpaused\b/i],
    ['the why field', /f-why|\.why\b|why:/i],
    ['where it stands', /f-state|\.state\b|state:/i],
    ['the free-text size field', /f-size-text|state_captured|state_days_old/i],
    ['the temperature bar', /temperature|stale-bar|interpolat/i],
    ['cold flags and reasons', /\bcold\b|cold_reason/i],
    // The Things list's hand-ordering. Not the builder's reorder gesture,
    // which is a different thing that happens to share the word.
    ['hand-ordering the list', /sort_order|draggable|ondragstart|\.sortable/i],
    ['pinned blocks', /\bpinned\b/i],
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
  const hint = rule('.hint');
  check('there is a hint', hint.length > 0);
  check('it is faint, so it does not compete with the title',
    /color: var\(--faint\)/.test(hint), hint.match(/color[^;]*/) || '');
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
  check('right opens a note', /dx >= SWIPE_COMMIT\) return openNote/.test(code));
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
  check('a begun block clamps the note swipe',
    /isBegun\(\) \? Math\.min\(0, raw\) : raw/.test(code));
  check('and shows no backing when it does', /if \(!dx\) \{/.test(code));
  check('the screen no longer keeps the sent flag', !/sent: Boolean\(b\.sent\)/.test(code));

  // The buffer insert is gone. Buffer is a title you type into + Block.
  check('nothing inserts a buffer on a swipe', !/insertBuffer/.test(code));
  check('and there is no buffer constant left', !/BUFFER_TITLE/.test(code));

  console.log('   the note');
  check('it opens whether or not there is one, so a swipe edits',
    /openNote\(index\)/.test(code));
  check('it is a textarea, for two lines', /createElement\('textarea'\)/.test(code));
  check('with the placeholder asked for',
    /What are you doing in this block\?/.test(code));
  check('capitalised by sentence for dictation',
    /'autocapitalize', 'sentences'/.test(code));
  check('and not autocompleted at', /'autocomplete', 'off'/.test(code));
  check('leaving the field saves it', /area\.onblur = \(\) => saveNote/.test(code));
  check('an empty one is no note', /blocks\[i\]\.note = clean \|\| null/.test(code));
  // On the block, never on the entry. "Finish the pricing page" is true of
  // Tuesday morning and not of the project, and putting it on the entry would
  // make it a claim that outlives the session it describes.
  check('the page never sends a note to /entries', !/body\.note/.test(code));
  check('nor to the update route',
    !/entries\/\$\{editingId\}\/update[\s\S]{0,400}note/.test(code));
  check('and the entries write path has no note in it', (() => {
    const entries = fs.readFileSync(ROOT + '/routes/entries.js', 'utf8');
    const tools = fs.readFileSync(ROOT + '/tools.js', 'utf8');
    return !/\bnote\b/.test(entries) && !/'note'/.test(tools);
  })());
  check('a block with one shows it under the title', /className = 'note'/.test(code));
  check('and it rides with the block through a confirm',
    /note: b\.note \|\| null/.test(code));

  // A press to place a cursor must not lift the card out from under the
  // keyboard, so a block being written in takes no gestures at all.
  check('a block being written in takes no gestures',
    /if \(noting === index\) return;/.test(code));

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
  check('and on the chip, so a swipe can start there too',
    /touch-action: pan-y/.test(rule('.dur')));

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
  check('but the reorder still happens', /blocks\.splice\(to, 0, moved\)/.test(code));
}

console.log('\n16. the shape of the day');
{
  check('a Starts control', /id="wake-time"/.test(body));
  check('with steppers', /id="wake-minus"/.test(body) && /id="wake-plus"/.test(body));
  check('a + Block control', /id="add-block"/.test(body));
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

  const sw = rule('.dayswitch');
  check('same type as any other label', /font-size: 10px/.test(sw) &&
    /letter-spacing: 0\.14em/.test(sw) && /text-transform: uppercase/.test(sw));
  check('and the same space under it', /margin-bottom: 14px/.test(sw));
  // Lighter than the paper's own ink rather than darker than it — on paper the
  // way to recede is toward the page, not away from it.
  check('the inactive word recedes toward the paper',
    /color: #b6ae9f/.test(rule('.dayswitch .opt')), rule('.dayswitch .opt'));
  check('the active one is full text', /color: var\(--text\)/.test(rule('.dayswitch .opt.on')));

  console.log('   today');
  // STILL PAPER, handled rather than withdrawn. It settles nearer the page and
  // its edge is displaced further and softened, which is what an edge does
  // after a day of being carried around. The dark build drew an outline; an
  // outline is a drawing of a thing, and this theme lays things down and takes
  // them away rather than drawing them.
  check('a finished slip settles toward the page rather than becoming an outline',
    /background: var\(--card-spent\)/.test(rule('.block.past::after')) &&
      !/border:/.test(rule('.block.past::after')), rule('.block.past::after'));
  check('its edge goes soft with handling',
    /filter: url\(#deckle-soft\)/.test(rule('.block.past::after')));
  check('with a lightened title', /color: #8e8a82/.test(rule('.block.past .t')));
  // Not just a past one. A block you are in the middle of kept its chip, and
  // shrinking it below the time already elapsed moved it into the past — an
  // action the server refuses on a delivered block anyway.
  check('a block that has begun gets no chip', /\} else if \(begun\) \{/.test(code));
  check('and one that is over gets nothing at all', /if \(past\) \{\s*row\.append\(left\);/.test(code));
  check('begun is read off the stored start, the same as the reflow',
    /const blockBegun = \(b\) => onToday\(\) && hasBegun\(b, nowMinutes\(\)\)/.test(code));
  check('and there is one definition of it', (code.match(/hasBegun\(/g) || []).length === 2,
    `${(code.match(/hasBegun\(/g) || []).length} uses`);
  check('and a begun block cannot be picked up', /if \(isBegun\(\)\) return;/.test(code));

  // WHAT A PRESS MAY DO IS ASKED OF THE CLOCK, NOT OF THE LAST RENDER.
  //
  // The lock was a boolean captured when the card was drawn. Nothing
  // re-renders on a clock tick, so a page left open across a block's start
  // time went on offering the chip, the hold and the note swipe on a block
  // that had begun — and the chip only grows, wrapping 4h back to 30m, so one
  // press could end a running block before the current time.
  check('the gesture handlers read it live',
    /const isBegun = \(\) => blockBegun\(blocks\[index\]\)/.test(code));
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

  check('a divider is drawn once', /markedNow = true/.test(code));
  check('with a dot and a rule', /className = 'dot'/.test(code) && /className = 'ln'/.test(code));
  check('the Starts control is hidden', /\$\('starts'\)\.classList\.toggle\('hidden', onToday\(\)\)/.test(code));

  console.log('   the past does not flow');
  check('a block that has begun keeps its hour', /hasBegun\(b, now\) \? b\.storedStart/.test(code));
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

  check('a tap on a greyed row takes it back out', /if \(locked\) return unschedule/.test(code));
  check('the last of its blocks, so twice in a day comes out one at a time',
    /const lastBlockFor = /.test(code));
  // The exception is gone with the server rule that justified it. A block that
  // had begun used to be exempt because the server refused to remove a
  // delivered one; it no longer does, and the row would otherwise be the last
  // place enforcing a rule nothing behind it holds.
  check('and one that has begun goes too', /at === -1\) return;/.test(code));
  check('nothing checks the clock on the way out',
    !/blockBegun\(blocks\[at\]\)/.test(code));
  check('it goes through the ordinary removal, so it is undoable',
    /removeBlock\(at\)/.test(code));

  check('read off the blocks on screen, so removing one unlocks it',
    /blocks\.some\(\(b\) => b\.entryId === entryId\)/.test(code));
  check('a greyed row holds its warning mark back', /if \(!locked && item\.mark\)/.test(code));
  check('and the row is dimmed', /color: var\(--faint\)/.test(rule('.row.locked .title')));
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
  check('the page still sends minutes', /start_minutes: b\.start/.test(code));
  check('and still reads them', /toMinutes/.test(code));
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
  check('and the page uses its inactive colour',
    /#B6AE9F/i.test(sw) && /#b6ae9f/i.test(rule('.dayswitch .opt')));

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
