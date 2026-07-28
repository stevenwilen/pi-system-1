// Boots the real server on a spare port and drives the endpoints the form
// uses. Every row it creates is deleted again at the end.
const H = require('./harness');
const U = H.TEST_USER_ID;
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
let bad = 0;
const made = [];

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

async function call(path, body) {
  const res = await fetch(BASE + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const server = H.spawnServer(PORT);

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  // Wait for the port rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  console.log('feed');
  const feed = await call('/entries');
  check('GET /entries 200', feed.status === 200, JSON.stringify(feed.data).slice(0, 60));
  check('has items array', Array.isArray(feed.data.items));
  check('has paused array', Array.isArray(feed.data.paused));
  check('reports timezone', feed.data.timezone === 'America/New_York', feed.data.timezone);
  // No count is asserted. The notebook can be reset deliberately, and a
  // hardcoded number only records how many rows existed on the day it was
  // written. What must hold is the ordering and the shape.
  const baseline = feed.data.items.length;
  console.log(`    notebook currently holds ${baseline} item(s)`);
  check('sorted coldest first', feed.data.items.every((it, i, a) => i === 0 || a[i - 1].days >= it.days));

  console.log('\nvalidation');
  check('rejects bad type', (await call('/entries', { type: 'idea', title: 'x' })).status === 400);
  check('rejects empty title', (await call('/entries', { type: 'task', title: '   ' })).status === 400);
  const noFreq = await call('/entries', { type: 'habit', title: '__probe habit' });
  check('habit needs frequency', noFreq.status === 400, noFreq.data.error);
  const badFreq = await call('/entries', { type: 'habit', title: '__probe', frequency: 'often' });
  check('habit frequency must be one of four', badFreq.status === 400);
  const noWhy = await call('/entries', { type: 'project', title: '__probe project' });
  check('project needs why', noWhy.status === 400, noWhy.data.error);

  console.log('\ncreate');
  const t = await call('/entries', { type: 'task', title: '__probe task' });
  check('task created', t.status === 200 && t.data.entry.type === 'task');
  if (t.data.entry) made.push(t.data.entry.id);

  const h = await call('/entries', { type: 'habit', title: '__probe habit', frequency: 'weekly' });
  check('habit created with frequency', h.data.entry && h.data.entry.frequency === 'weekly');
  if (h.data.entry) made.push(h.data.entry.id);

  const p = await call('/entries', { type: 'project', title: '__probe project', why: 'to prove it saves' });
  check('project created with its why', p.data.entry && p.data.entry.why === 'to prove it saves');
  if (p.data.entry) made.push(p.data.entry.id);

  console.log('\nfields are kept to their type');
  check('task carries no frequency', t.data.entry && t.data.entry.frequency === null);
  check('task carries no why', t.data.entry && t.data.entry.why === null);
  check('habit carries no why', h.data.entry && h.data.entry.why === null);
  // Priority is retired. The list position replaced it, so nothing writes it
  // even when a caller sends one.
  check('priority is never written', [t, h, p].every((r) => !r.data.entry || r.data.entry.priority === null));

  console.log('\npause');
  const id = t.data.entry.id;
  const paused = await call(`/entries/${id}/pause`, { paused: true });
  check('pause returns paused:true', paused.data.paused === true);
  let after = (await call('/entries')).data;
  check('paused item leaves the main list', !after.items.some((i) => i.id === id));
  check('paused item appears in paused', after.paused.some((i) => i.id === id));

  await call(`/entries/${id}/pause`, { paused: false });
  after = (await call('/entries')).data;
  check('resume puts it back', after.items.some((i) => i.id === id));

  console.log('\nedit');
  const up = await call(`/entries/${id}/update`, { title: '__probe renamed' });
  check('title updates', up.data.entry && up.data.entry.title === '__probe renamed');
  check('rejects blank title', (await call(`/entries/${id}/update`, { title: ' ' })).status === 400);
  check('rejects bad frequency', (await call(`/entries/${h.data.entry.id}/update`, { frequency: 'sometimes' })).status === 400);

  console.log('\ntwo projects can now sit anywhere in the list');
  // There is no rank to collide over. The order is the person's, held in
  // sort_order, and nothing enforces uniqueness on anything.
  const dup = await call('/entries', { type: 'project', title: '__probe second', why: 'x' });
  check('a second project is simply accepted', dup.status === 200, dup.data.error || '');
  if (dup.data.entry) made.push(dup.data.entry.id);
  check('and it went to the top', (await call('/entries')).data.items[0].title === '__probe second');

  console.log('\ndelete is soft');
  await call(`/entries/${id}/delete`, {});
  after = (await call('/entries')).data;
  check('deleted item leaves the feed', !after.items.some((i) => i.id === id));

  const supabase = H.db;
  const { data: tomb } = await supabase.from('entries').select('id, status').eq('id', id).maybeSingle();
  check('row survives as a tombstone', tomb && tomb.status === 'deleted');

  console.log('\ncleanup');
  for (const rid of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', rid);
  const final = (await call('/entries')).data;
  check('back to the original 12 rows', final.items.length === baseline, `${final.items.length}`);

  console.log(bad === 0 ? '\nStep 1 clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('harness error:', err.message);
  server.kill();
  process.exit(1);
});
