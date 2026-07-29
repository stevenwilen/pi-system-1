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
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// The markup alone. The <script> lives inside <body>, so slicing to </body>
// and calling it markup meant every "gone from the markup" check was really
// reading the script as well — and passing or failing for the wrong reason.
const body = html
  .slice(html.indexOf('<body>'), html.indexOf('</body>'))
  .replace(/<script>[\s\S]*?<\/script>/, '');

// The script with its comments stripped. Several checks below assert that a
// removed feature is not mentioned, and this file explains at length which
// features were removed and why. Reading the raw text would fail precisely
// because the reasoning was written down.
const code = script
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// One rule's declarations, by exact selector.
const rule = (selector) => {
  const at = css.indexOf(`\n      ${selector} {`);
  if (at === -1) return '';
  return css.slice(at, css.indexOf('\n      }', at));
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

console.log('1. the palette is exactly the one specified');
{
  const root = rule(':root');
  const want = {
    '--bg': '#16130f',
    '--card': '#211d18',
    '--line': '#2c2721',
    '--text': '#ede7de',
    '--muted': '#8b8177',
    '--faint': '#6b6459',
    '--accent': '#6e8cb8',
    '--warn': '#c4694a',
  };
  for (const [name, value] of Object.entries(want)) {
    check(`${name} is ${value}`, new RegExp(`${name}:\\s*${value}\\s*;`, 'i').test(root));
  }
}

console.log('\n2. one label style, and the action is quieter than it');
{
  const label = rule('.label');
  check('10px', /font-size: 10px/.test(label));
  check('uppercase', /text-transform: uppercase/.test(label));
  check('0.14em tracking', /letter-spacing: 0\.14em/.test(label));
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
  check('a block IS a card', /background: var\(--card\)/.test(block));
  check('with a radius', /border-radius/.test(block));

  // Nothing else may take the card background. It is the mark of an object
  // you manipulate, and there is one of those.
  const carded = selectorsUsing('var(--card)').filter((s) => !/^:root/.test(s));
  check('nothing else uses the card background',
    carded.every((s) => /\.block|\.confirm:disabled/.test(s)), carded.join(' | '));
}

console.log('\n4. sections are separated by space, not by boxes');
{
  const section = rule('.section');
  check('36px between sections', /margin-bottom: var\(--gap\)/.test(section));
  check('and the gap is 36px', /--gap:\s*36px/.test(rule(':root')));
  check('a section has no border', !/border/.test(section), section);
  check('nor a background', !/background/.test(section), section);

  check('three sections, and only three', (body.match(/<section/g) || []).length === 3,
    String((body.match(/<section/g) || []).length));
  check('yesterday is first', body.indexOf('Yesterday') < body.indexOf('Things'));
  check('things is second', body.indexOf('Things') < body.indexOf('Tomorrow'));
}

console.log('\n5. two text sizes in a row, with real space between them');
{
  check('the title is 15px', /font-size: 15px/.test(rule('.row .title')));

  const meta = rule('.row .meta');
  check('the meta is 12px', /font-size: 12px/.test(meta));
  check('and muted', /color: var\(--muted\)/.test(meta));
  check('on its own line, with space above it', /margin-top: 5px/.test(meta));
}

console.log('\n6. blue is actionable, and nothing else is blue');
{
  const blue = selectorsUsing('var(--accent)').filter((s) => !/^:root/.test(s));

  // The steppers, Confirm, and the sheet's save button, which is the same
  // commit in a different place.
  const allowed = /\.step|\.confirm|\.sheet-actions \.save/;
  check('blue appears only on steppers and commits',
    blue.every((s) => allowed.test(s)), blue.join(' | '));

  check('the stepper buttons are blue', /color: var\(--accent\)/.test(rule('.step')));
  check('confirm is blue', /background: var\(--accent\)/.test(rule('.confirm')));

  // The specific traps: the calendar aside and the type chooser both look
  // like places a designer would reach for an accent, and neither is one.
  check('the calendar aside is not blue', !/--accent/.test(rule('.cal')));
  check('nor its rule', !/--accent/.test(rule('.cal h4')));
  check('the type chooser is not blue', !/--accent/.test(rule('.choices button')));
  check('nor when chosen', !/--accent/.test(rule('.choices button[aria-pressed="true"]')));
  check('a disabled stepper goes faint, not pale blue',
    /color: var\(--faint\)/.test(rule('.step:disabled')));
}

console.log('\n7. the miss colour is for misses and warnings only');
{
  const warn = selectorsUsing('var(--warn)').filter((s) => !/^:root/.test(s));
  const allowed = /\.mark|\.missed|\.ends\.late|\.failed|\.danger|\.problem/;
  check('used only on marks, misses and failures',
    warn.every((s) => allowed.test(s)), warn.join(' | '));

  check('the warning mark carries it', /color: var\(--warn\)/.test(rule('.mark')));
  check('a missed block carries it', /color: var\(--warn\)/.test(rule('.missed')));
  check('an ordinary row does not', !/--warn/.test(rule('.row')));
  check('nor an ordinary meta line', !/--warn/.test(rule('.row .meta')));
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
  check('which is a warm grey, not a blue', /--cal-head:\s*#9a8f80/i.test(root));
  check('and not the miss colour either', !/--cal-head:\s*#c4694a/i.test(root));
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
    ['reordering', /reorder|sort_order|draggable|ondrag/i],
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
  check('opened from the Things label', /id="add-open"/.test(body) &&
    body.indexOf('add-open') < body.indexOf('Tomorrow'));
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

console.log('\n14. the shape of the day');
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
  check('and each starts where the last ended', /cursor \+= b\.duration/.test(code));
}

console.log(bad === 0 ? '\nLayout clean' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
