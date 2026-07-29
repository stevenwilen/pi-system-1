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
  // you manipulate — plus the disabled Confirm, and the undo bar, which is a
  // surface floating over the page rather than a row in it.
  const carded = selectorsUsing('var(--card)').filter((s) => !/^:root/.test(s));
  check('nothing else uses the card background',
    carded.every((s) => /\.block|\.confirm:disabled|\.undo/.test(s)), carded.join(' | '));
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
  check('things is first', body.indexOf('Things') < body.indexOf('dayswitch'));
  check('and there is no Yesterday', !/Yesterday/.test(body));
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

  // THE RULE WIDENED. It used to be "blue is actionable, and nothing else is
  // blue" — the steppers and Confirm, full stop. Two things now carry it that
  // no press acts on:
  //
  //   .now      the divider marking where the day has got to
  //   .inplan   a thing that is already in the day on screen
  //
  // Both say "here is where you are", which is the nearest thing to an action
  // that is not one. They are listed by name so a third has to be argued for
  // here rather than added quietly, and so anyone reading this knows the
  // stricter rule was relaxed on purpose.
  const acts = /\.step|\.dur|\.undo button|\.confirm|\.sheet-actions \.save/;
  const orients = /\.now \.dot|\.now \.txt|\.inplan/;
  check('blue appears only on the controls that act, or the two that orient',
    blue.every((s) => acts.test(s) || orients.test(s)), blue.join(' | '));
  check('and nothing decorative has it',
    !blue.some((s) => /\.cal|\.backing|\.block\b|\.row\b/.test(s)), blue.join(' | '));

  check('the start steppers are blue', /color: var\(--accent\)/.test(rule('.step')));
  check('the duration chip is blue, because it is now the control',
    /color: var\(--accent\)/.test(rule('.dur')));
  check('confirm is blue', /background: var\(--accent\)/.test(rule('.confirm')));
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
}

console.log('\n7. the miss colour is for misses, warnings and destruction only');
{
  // Three jobs, and they are the same job: this is the colour of something
  // having gone wrong, being about to, or being about to be thrown away. The
  // destructive-action use (Delete, Remove) is the one extension of "misses
  // and warnings", and it is listed rather than assumed so a fourth use has
  // to be argued for here before it can ship.
  const warn = selectorsUsing('var(--warn)').filter((s) => !/^:root/.test(s));
  const allowed = /\.mark|\.askmiss\.was|\.ends\.late|\.failed|\.danger|\.problem|\.backing\.left/;
  check('used only on marks, misses, failures and destructive actions',
    warn.every((s) => allowed.test(s)), warn.join(' | '));

  // The two swipes must not look alike. Left throws a block away and is the
  // miss colour; right adds thirty minutes of nothing and is neutral, because
  // the miss colour there would call an addition a warning.
  check('the removing swipe is the miss colour', /var\(--warn\)/.test(rule('.backing.left')));
  check('the buffer swipe is not', !/var\(--warn\)/.test(rule('.backing.right')));
  check('nor is it blue', !/var\(--accent\)/.test(rule('.backing.right')));

  check('the warning mark carries it', /color: var\(--warn\)/.test(rule('.mark')));
  check('a missed block carries it', /color: var\(--warn\)/.test(rule('.askmiss.was')));
  check('and the question that offers it does not',
    /color: var\(--faint\)/.test(rule('.askmiss')));
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
  check('left removes', /dx <= -SWIPE_COMMIT\) return removeBlock/.test(code));
  check('right opens a note', /dx >= SWIPE_COMMIT\) return openNote/.test(code));
  check('the card follows the finger', /translateX\(\$\{dx\}px\)/.test(code));
  check('and the backing says which it is',
    /dx < 0 \? 'Remove' : 'Note'/.test(code));
  check('removal offers an undo rather than a confirm', /offerUndo\(gone, i\)/.test(code));
  check('and nothing asks first', !/confirm\(`Remove/.test(code));

  // A block whose message has gone out is part of the day that happened. The
  // swipe that would remove it does not travel at all, rather than travelling
  // and then being refused on release.
  check('a delivered block clamps the removing swipe',
    /held && held\.sent \? Math\.max\(0, raw\) : raw/.test(code));
  check('and shows no backing when it does', /if \(!dx\) \{/.test(code));
  check('the sent flag comes from the server', /sent: Boolean\(b\.sent\)/.test(code));

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
  check('the inactive word is very faint',
    /color: #4a443c/.test(rule('.dayswitch .opt')), rule('.dayswitch .opt'));
  check('the active one is full text', /color: var\(--text\)/.test(rule('.dayswitch .opt.on')));

  console.log('   today');
  check('a finished block renders as an outline, not a card',
    /background: transparent/.test(rule('.block.past')) &&
      /border: 1px solid var\(--line\)/.test(rule('.block.past')));
  check('with a faint title', /color: var\(--faint\)/.test(rule('.block.past .t')));
  check('a past block gets no chip', /if \(past\) \{[\s\S]{0,80}missToggle/.test(code));
  check('it asks instead', /didn't happen\?/.test(code));
  check('and marking it posts to the miss route', /\/blocks\/\$\{b\.id\}\/miss/.test(code));
  check('a NOW divider is drawn once', /markedNow = true/.test(code));
  check('with a dot and a rule', /className = 'dot'/.test(code) && /className = 'ln'/.test(code));
  check('the Starts control is hidden', /\$\('starts'\)\.classList\.toggle\('hidden', onToday\(\)\)/.test(code));

  console.log('   the past does not flow');
  check('a block that has begun keeps its hour', /hasBegun\(b, now\) \? b\.storedStart/.test(code));
  check('what is left starts at the next half hour', /Math\.max\(cursor, floor\)/.test(code));
  check('which is the boundary after now', /Math\.ceil\(nowMinutes\(\) \/ STEP\) \* STEP/.test(code));
  check('and a drifted day is not called confirmed', /if \(saved && drifted\(\)\) saved = false/.test(code));

  console.log('   which day opens');
  check('the preference comes from the server', /data\.plans_in === 'morning'/.test(code));
  check('and there is no settings UI for it', !/plans_in/.test(body));

  console.log('   a thing already in the day');
  check('locked against being added twice', /if \(locked\) return;/.test(code));
  check('it says which day it is in',
    /in \$\{showing === 'today' \? "today's" : "tomorrow's"\} plan/.test(code));
  check('read off the blocks on screen, so removing one unlocks it',
    /blocks\.some\(\(b\) => b\.entryId === entryId\)/.test(code));
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

  for (const value of ['#16130F', '#211D18', '#2C2721', '#EDE7DE', '#8B8177', '#6B6459', '#6E8CB8', '#C4694A']) {
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
    ['the NOW divider', 'now'],
    ['a locked row', 'locked'],
  ]) {
    check(`${what} is drawn in the mockup`, new RegExp(`class="[^"]*\\b${klass}\\b`).test(mock), klass);
  }

  check('both swipe directions are shown',
    /backing left/.test(mock) && /backing right/.test(mock));
  check('and they are not the same colour',
    /\.backing\.left\{[^}]*--warn/.test(mock.replace(/\s/g, '')) ||
      /backing\.left\{background:var\(--warn\)/.test(mock.replace(/\s/g, '')));
  check('it shows all three row actions',
    /Done/.test(mock) && /Edit/.test(mock) && /Delete/.test(mock));

  // The switch has a reference of its own, which is where it came from.
  const sw = fs.readFileSync(ROOT + '/public/switch.html', 'utf8');
  check('switch.html is kept as the reference for the day switch',
    /class="dayswitch"/.test(sw));
  check('it shows both states', /opt on">Today/.test(sw) && /opt on">Tomorrow/.test(sw));
  check('and the page uses its inactive colour',
    /#4A443C/i.test(sw) && /#4a443c/i.test(rule('.dayswitch .opt')));

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
