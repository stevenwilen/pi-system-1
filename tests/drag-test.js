// Drag maths, lifted from the shipped page, driven in both directions.
const H = require('./harness');
const U = H.TEST_USER_ID;
const fs = require('fs');
const vm = require('vm');
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// dropIndex is the page's own. It is the function under test: it turns a
// pointer position into the index the row should land at.
const found = script.match(/function dropIndex[\s\S]*?\n      \}/);
if (!found) throw new Error('dropIndex is no longer in index.html, or its indentation changed');
const ctx = vm.createContext({});
vm.runInContext(found[0], ctx);

// moveInList used to be lifted from the page too, which meant the page was
// being checked against itself. It has since been deleted there — reordering
// moves the DOM nodes directly rather than rebuilding from a reordered array —
// so it is written here instead, as the independent statement of what a move
// is meant to produce. That is what dropIndex and the server are checked
// against below.
ctx.moveInList = (list, from, to) => {
  const out = list.slice();
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
};

// Five rows, 60px tall, stacked from y=100. Midpoints at 130,190,250,310,370.
const ROW = 60;
const TOP = 100;
const boxesWithout = (n, dragged) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === dragged) continue;
    out.push({ top: TOP + out.length * ROW, height: ROW });
  }
  return out;
};

console.log('dropIndex is symmetric');
{
  // Dragging row 2 of 5. The other four sit at 100,160,220,280.
  const boxes = boxesWithout(5, 2);
  const cases = [
    ['far above everything', 0, 0],
    ['above the first midpoint', 120, 0],
    ['just past the first midpoint', 140, 1],
    ['past the second', 200, 2],
    ['past the third', 260, 3],
    ['below everything', 999, 4],
  ];
  for (const [label, y, expected] of cases) {
    const got = ctx.dropIndex(boxes, y);
    check(`${label} -> ${expected}`, got === expected, `got ${got}`);
  }
}

console.log('\nupward drags produce a lower index, which the old code could not');
{
  const boxes = boxesWithout(5, 4); // dragging the last row
  check('last row lifted to the very top', ctx.dropIndex(boxes, 90) === 0, `${ctx.dropIndex(boxes, 90)}`);
  check('last row to second place', ctx.dropIndex(boxes, 140) === 1, `${ctx.dropIndex(boxes, 140)}`);
}

console.log('\nmoveInList, both directions');
const L = ['a', 'b', 'c', 'd', 'e'];
const cases = [
  ['top to bottom', 0, 4, 'b,c,d,e,a'],
  ['bottom to top', 4, 0, 'e,a,b,c,d'],
  ['middle down one', 2, 3, 'a,b,d,c,e'],
  ['middle up one', 2, 1, 'a,c,b,d,e'],
  ['middle to top', 2, 0, 'c,a,b,d,e'],
  ['middle to bottom', 2, 4, 'a,b,d,e,c'],
  ['no move', 2, 2, 'a,b,c,d,e'],
];
for (const [label, from, to, expected] of cases) {
  const got = ctx.moveInList(L, from, to).join(',');
  check(label, got === expected, got);
}

console.log('\nthe two composed: a drag of each row to each position');
{
  // For every from/to, the index dropIndex yields must reproduce the move.
  let wrong = 0;
  for (let from = 0; from < 5; from++) {
    const boxes = boxesWithout(5, from);
    for (let target = 0; target <= 4; target++) {
      // Pointer just past the midpoint of the target slot.
      const y = target === 0 ? TOP - 10 : TOP + (target - 1) * ROW + ROW / 2 + 1;
      const to = ctx.dropIndex(boxes, y);
      if (to !== target) wrong++;
    }
  }
  check('every from/to pair resolves to the intended slot', wrong === 0, `${wrong} wrong`);
}

// --- and against the real database ------------------------------------------

const PORT = 3974;
const BASE = `http://127.0.0.1:${PORT}`;

const server = H.spawnServer(PORT);
const made = [];

async function call(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const supabase = H.db;

  console.log('\nthe persisted order matches the visual order');
  for (const t of ['__d A', '__d B', '__d C', '__d D', '__d E']) {
    const r = await call('/entries', { type: 'task', title: t });
    made.push(r.data.entry.id);
  }

  const titles = async () => (await call('/entries')).data.items.map((i) => i.title);
  // No count is asserted: the notebook is the person's and may hold anything.
  // What matters is that the five probes went to the top, newest first.
  let visible = await titles();
  check('the five probes are at the top, newest first',
    visible.slice(0, 5).join(',') === '__d E,__d D,__d C,__d B,__d A', visible.join(','));

  // Each move: apply moveInList to what is on screen, send it, read it back.
  const moves = [
    ['top to bottom', 0, 4],
    ['bottom to top', 4, 0],
    ['middle down one', 2, 3],
    ['middle up one', 2, 1],
  ];

  for (const [label, from, to] of moves) {
    const ids = (await call('/entries')).data.items.map((i) => i.id);
    const expected = ctx.moveInList(await titles(), from, to);
    const sent = ctx.moveInList(ids, from, to);

    await call('/entries/reorder', { ids: sent });
    const after = await titles();
    check(label, after.join(',') === expected.join(','), `${after.join(',')} (wanted ${expected.join(',')})`);

    const { data: rows } = await supabase
      .from('entries').select('title, sort_order').in('id', sent).order('sort_order');
    check(`  ${label}: database agrees`, rows.map((r) => r.title).join(',') === after.join(','),
      rows.map((r) => `${r.sort_order}:${r.title}`).join(' '));
  }

  console.log('\ncleanup');
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  const { count } = await supabase.from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U).like('title', '__d%');
  check('probe rows removed', count === 0, `${count}`);

  console.log(bad === 0 ? '\nDrag clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  server.on('exit', () => process.exit(bad === 0 ? 0 : 1));
  setTimeout(() => process.exit(bad === 0 ? 0 : 1), 2000);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  const supabase = H.db;
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  server.kill();
  process.exit(1);
});
