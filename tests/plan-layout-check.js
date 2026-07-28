// The Plan screen's structure, checked against the stylesheet and markup.
//
// Thirteen concrete problems, each pinned so it cannot come back quietly. No
// database and no network: this reads the page as shipped.
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
const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// One rule's declarations, by exact selector.
const rule = (selector) => {
  const at = css.indexOf(`\n      ${selector} {`);
  if (at === -1) return '';
  return css.slice(at, css.indexOf('\n      }', at));
};
const px = (selector, prop) => {
  const m = rule(selector).match(new RegExp(`${prop}:\\s*([\\d.]+)px`));
  return m ? Number(m[1]) : null;
};

console.log('1. one label style, and optional is inline');
{
  const label = rule('label');
  check('11px', /font-size: 11px/.test(label));
  check('uppercase', /text-transform: uppercase/.test(label));
  check('0.1em tracking', /letter-spacing: 0\.1em/.test(label));
  check('weight 500', /font-weight: 500/.test(label));
  check('muted', /color: var\(--muted\)/.test(label));

  // A flex column made the label text and its aside two separate rows.
  check('not a flex column, so the aside stays on the line', !/display: flex/.test(label), label.replace(/\s+/g, ' ').slice(0, 60));

  const aside = rule('label .none');
  check('optional is 10px', /font-size: 10px/.test(aside));
  check('lowercase, never uppercase', /text-transform: lowercase/.test(aside));
  check('dimmer than the label', /color: var\(--dim\)/.test(aside));
  check('and not bold', /font-weight: 400/.test(aside));

  // Every label in the form, so none of them keeps a different treatment.
  const labels = [...body.matchAll(/<label[^>]*>\s*([A-Za-z][^<]*)/g)].map((m) => m[1].trim());
  check('every field uses it', labels.length >= 5, labels.join(' | '));
}

console.log('\n2. placeholders read as placeholders');
{
  const ph = rule('input::placeholder,\n      textarea::placeholder');
  check('textareas covered too, not just inputs', /textarea::placeholder/.test(css));
  check('dim, not near text brightness', /color: var\(--dim\)/.test(ph), ph.replace(/\s+/g, ' ').slice(0, 70));
  check('normal weight', /font-weight: 400/.test(ph));
  check('and Firefox is stopped dimming it twice', /opacity: 1/.test(ph));
}

console.log('\n3. no nested cards');
{
  check('the add form is not a card', /<form id="add-form" class="formcard">/.test(body));
  check('nor the block form', /<div class="formcard hidden" id="block-card">/.test(body));
  check('a formcard has no background', /background: none/.test(rule('.formcard')));

  check('empty states are plain text', /\.empty \{/.test(css));
  check('with no background of their own', !/background:/.test(rule('.empty')));
  check('and dim', /color: var\(--dim\)/.test(rule('.empty')));

  // The three the brief named, plus review, all stop being cards.
  check('"Nothing here yet" is not a card', /el\('div', 'empty', 'Nothing here yet/.test(script));
  check('"Tap something in Stale" is not a card', /el\('div', 'empty', 'Tap something in Stale/.test(script));
  check('nothing on the plan screen still builds a card for an absence',
    !/const empty = el\('div', 'card'\);[\s\S]{0,200}(Nothing here|Tap something|Nothing planned)/.test(script));
}

console.log('\n4. the two ends of the day are rows, not cards');
{
  check('neither is a card in the markup', /<div id="starts">/.test(body) && /<div id="ends">/.test(body));
  check('and neither draws a panel', /background: none/.test(rule('#ends,\n      #starts')));

  const row = rule('.ends-row');
  check('about 44px tall', px('.ends-row', 'min-height') === 44, String(px('.ends-row', 'min-height')));
  check('label left, control right', /justify-content: space-between/.test(row));

  check('stepper buttons are 32px', px('.stepper button', 'width') === 32, String(px('.stepper button', 'width')));
  check('and keep the sage border', /rgba\(143, 160, 122/.test(rule('.stepper button')));
  check('the gap between them is tight', px('.stepper', 'gap') <= 2, String(px('.stepper', 'gap')));
}

console.log('\n5. Confirm is its own action');
{
  check('it sits outside the ends box', /<\/div>\s*<button id="confirm"/.test(body.replace(/\n\s*/g, '\n')) || /id="ends">[\s\S]*?<\/div>\s*<button id="confirm"/.test(body));
  check('full width', /width: 100%/.test(rule('#confirm')));
  check('with real space above it', px('#confirm', 'margin-top') >= 16, String(px('#confirm', 'margin-top')));
  check('and no hairline tying it to a readout', !/border-top: 1px solid var\(--line\)/.test(rule('#confirm')));
}

console.log('\n6. a placeholder value is not shouting');
{
  const ph = rule('.ends-row strong.placeholder');
  check('normal weight', /font-weight: 400/.test(ph));
  check('and muted', /color: var\(--dim\)/.test(ph));
  check('a real end time keeps its emphasis', /font-weight: 600/.test(rule('.ends-row strong')));
  check('the class is applied only when there is nothing to show',
    /classList\.toggle\('placeholder', !blocks\.length\)/.test(script));
  check('and it starts out as one', /id="end-time" class="placeholder"/.test(body));
}

console.log('\n7. the segmented control is a mode switch');
{
  check('30px buttons inside 3px padding is a 36px control',
    px('.seg button', 'height') === 30 && px('.seg', 'padding') === 3,
    `${px('.seg button', 'height')} + ${px('.seg', 'padding')}`);
  check('smaller text', px('.seg button', 'font-size') <= 12, String(px('.seg button', 'font-size')));
}

console.log('\n8. textareas start at two rows and grow');
{
  check('why starts at two', /<textarea id="f-why" rows="2"/.test(body));
  check('where it stands too', /<textarea id="f-state" rows="2"/.test(body));
  // Searched across the stylesheet: `textarea` appears both as the tail of the
  // shared input group and as its own rule, and rule() finds the first.
  check('no tall minimum forcing them open', /textarea \{[^}]*min-height: 0/.test(css));
  check('and no drag handle to fight the growing', /textarea \{[^}]*resize: none/.test(css));
  check('they grow to fit what is typed', /box\.style\.height = `\$\{box\.scrollHeight\}px`/.test(script));
  check('and on both, when a row is opened for editing', /grow\(\$\('f-why'\)\);[\s\S]{0,60}grow\(\$\('f-state'\)\)/.test(script));
}

console.log('\n9. Clear only when there is a date');
{
  check('hidden when the field is empty', /classList\.toggle\('hidden', !\$\('f-due'\)\.value\)/.test(script));
  check('kept in step as it is typed', /\$\('f-due'\)\.oninput = paintDueClear/.test(script));
  check('and re-checked when the form opens', /paintDueClear\(\);\s*\n\s*grow/.test(script));
}

console.log('\n10. a pair shares a row, a lone action takes the width');
{
  // The Plan screen's button pairs, all of them. The Money tab is out of scope
  // and keeps its own treatment.
  const plan = body.slice(body.indexOf('id="plan-view"'), body.indexOf('id="money-view"'));
  check('no full-width button in a pair on this screen', !/class="primary grow"/.test(plan),
    (plan.match(/class="primary grow"[^>]*/g) || []).join(' | '));
  check('the block form still pairs Save with Cancel',
    /<button class="primary" type="submit">Add block<\/button>[\s\S]{0,120}id="b-cancel"/.test(body));
  check('with spacing between them', px('.row', 'gap') >= 12, String(px('.row', 'gap')));

  // The sheet is one screen doing one thing, so Save is not one of two
  // choices. The X in its header is the way out.
  check('the sheet offers no Cancel', !/id="f-cancel"/.test(body));
  check('and its Save takes the width', /width: 100%/.test(rule('#f-save')));
}

console.log('\n11. the header does not waste a row');
{
  check('the tabs are inside the header', /<header>[\s\S]*?<nav class="tabs"[\s\S]*?<\/header>/.test(body));
  check('laid out as one row', /display: flex/.test(rule('header')));
  check('with the tabs pushed to the end', /margin-left: auto/.test(rule('.tabs')));
  check('and the title quieter than the content below it', /color: var\(--dim\)/.test(rule('header')));
}

console.log('\n12. one spacing scale');
{
  const scale = [8, 12, 16, 24, 32];
  const spacings = {
    'between sections': px('main', 'gap'),
    'between rows of a section': px('.group', 'gap'),
    'between list rows': px('#stale,\n      #paused', 'gap'),
    'inside a card': px('.card', 'padding'),
    'inside a row': px('.item', 'padding'),
    'between form fields': px('form', 'gap'),
  };

  for (const [what, value] of Object.entries(spacings)) {
    check(`${what} is on the scale`, scale.includes(value), String(value));
  }
  check('sections are furthest apart', spacings['between sections'] === 32);

  // The inversion the brief named: it was 12-14px inside against a 3px gap.
  check('a row is no looser inside than the space between rows',
    spacings['inside a row'] <= spacings['between list rows'],
    `${spacings['inside a row']} inside, ${spacings['between list rows']} between`);
}

console.log('\n13. section headers lead, their buttons do not');
{
  const head = rule('.group-head h2');
  const btn = rule('.addbtn');
  const weight = (r) => Number((r.match(/font-weight: (\d+)/) || [])[1] || 400);
  const size = (r) => Number((r.match(/font-size: ([\d.]+)px/) || [])[1] || 0);

  check('they share a baseline', /align-items: baseline/.test(rule('.group-head')));
  check('the button is no heavier than the label', weight(btn) <= weight(head), `${weight(btn)} against ${weight(head)}`);
  check('nor larger', size(btn) <= size(head), `${size(btn)} against ${size(head)}`);
  check('and it is dimmer', /color: var\(--dim\)/.test(btn));
  check('its pill border is gone', /border: 0/.test(btn));
}

console.log('\n14. the add form is a sheet over the app, never in the list');
{
  const plan = body.slice(body.indexOf('id="plan-view"'), body.indexOf('id="money-view"'));
  check('no form left inside the plan view', !/id="add-form"/.test(plan));
  check('the priorities section is the list and nothing else',
    /<h2>Priorities<\/h2>[\s\S]{0,200}?<div id="stale"><\/div>/.test(body));

  check('the sheet is fixed over the page', /position: fixed/.test(rule('.sheet-scrim')));
  check('and dims what is behind it', /background: rgba\(/.test(rule('.sheet-scrim')));
  check('it has a header', /<div class="sheet-head">/.test(body));
  check('with a close control', /id="entry-close"/.test(body));
  check('the close target is a real hit area',
    px('.sheet-close', 'width') >= 40 && px('.sheet-close', 'height') >= 40,
    `${px('.sheet-close', 'width')}x${px('.sheet-close', 'height')}`);
  check('the fields scroll inside it', /overflow-y: auto/.test(rule('.sheet-body')));

  // Opening it must not leave the list scrolling underneath.
  check('the page behind is locked', /overflow: hidden/.test(rule('main.locked')));
  check('locked on open', /\$\('main'\)\.classList\.add\('locked'\)/.test(script));
  check('and released on close', /\$\('main'\)\.classList\.remove\('locked'\)/.test(script));

  // Nothing may expand in place any more.
  check('opening no longer scrolls a card into the list', !/scrollIntoView/.test(script.slice(script.indexOf('function openEntry'), script.indexOf('function closeEntry'))));

  // Discarding asks, but only when there is something to lose.
  check('the X compares against what it opened with', /sheetState\(\) !== openedWith/.test(script));
  check('and only then confirms', /openedWith &&\s*\n?\s*!confirm\(/.test(script));
  check('saving closes it', /closeEntry\(\);\s*\n\s*await load\(\)/.test(script));
}

console.log('\nthe palette is untouched');
{
  for (const [name, value] of Object.entries({
    '--bg': '#16130f', '--surface': '#211d18', '--text': '#ede7de',
    '--muted': '#8b8177', '--dim': '#6b6459', '--warn': '#c4694a',
    '--accent': '#8fa07a', '--accent-press': '#7d8b6a',
  })) {
    check(`${name} still ${value}`, new RegExp(`${name}: ${value};`).test(css));
  }
  check('no webfont was added', !/fonts\.googleapis|@font-face/.test(html));
}

console.log(bad === 0 ? '\nPlan layout clean' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
