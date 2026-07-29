// Boots the real server on a spare port and drives the endpoints the add form
// uses. Every row it creates is deleted again at the end.
//
// The form asks for five things now — type, title, due date, size, frequency —
// and the rules between them are the whole of this suite. There is no why, no
// note about where anything stands, and no pause.
const H = require('./harness');
const U = H.TEST_USER_ID;
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

const day = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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
  check('and no paused array, because there is no pause', feed.data.paused === undefined);
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

  // The one that changed. A project used to be refused without a stated reason.
  const bareProject = await call('/entries', { type: 'project', title: '__probe project' });
  check('a project needs nothing but a title now', bareProject.status === 200,
    `${bareProject.status} ${bareProject.data.error || ''}`);
  if (bareProject.data.entry) made.push(bareProject.data.entry.id);

  console.log('\ncreate');
  const t = await call('/entries', { type: 'task', title: '__probe task' });
  check('task created', t.status === 200 && t.data.entry.type === 'task');
  if (t.data.entry) made.push(t.data.entry.id);

  const h = await call('/entries', { type: 'habit', title: '__probe habit', frequency: 'weekly' });
  check('habit created with frequency', h.data.entry && h.data.entry.frequency === 'weekly');
  if (h.data.entry) made.push(h.data.entry.id);

  const dated = await call('/entries', {
    type: 'project', title: '__probe dated', due: day(20), size: 'a few weeks',
  });
  check('project created with a date and a size',
    dated.data.entry && dated.data.entry.due === day(20) && dated.data.entry.size === 'a few weeks',
    JSON.stringify(dated.data).slice(0, 120));
  if (dated.data.entry) made.push(dated.data.entry.id);

  console.log('\nfields are kept to their type');
  check('task carries no frequency', t.data.entry && t.data.entry.frequency === null);
  check('habit carries no due date', h.data.entry && h.data.entry.due === null);
  check('habit carries no size', h.data.entry && h.data.entry.size === null);

  // Every column the strip retired. Nothing writes them even when a caller
  // sends one, because they are off the whitelist in tools.js.
  const stuffed = await call('/entries', {
    type: 'task', title: '__probe stuffed',
    why: 'should not land', body: 'nor this', priority: 3, sort_order: 9,
    cold: true, cold_reason: 'nope', paused_at: new Date().toISOString(),
  });
  check('a stuffed payload is still accepted', stuffed.status === 200, stuffed.data.error || '');
  if (stuffed.data.entry) made.push(stuffed.data.entry.id);

  const e = stuffed.data.entry || {};
  for (const column of ['why', 'body', 'priority', 'sort_order', 'cold_reason', 'paused_at']) {
    check(`${column} is never written`, e[column] === null || e[column] === undefined,
      `${column}=${JSON.stringify(e[column])}`);
  }
  check('cold stays false', e.cold === false || e.cold === undefined, `cold=${JSON.stringify(e.cold)}`);

  console.log('\nthe endpoints that were removed are gone');
  {
    const id = t.data.entry.id;
    const paused = await fetch(`${BASE}/entries/${id}/pause`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused: true }),
    });
    check('pause is gone', paused.status === 404, `${paused.status}`);

    const prompt = await fetch(`${BASE}/plan-intent/setup-prompt`);
    check('the setup interview is gone', prompt.status === 404, `${prompt.status}`);

    const summarize = await fetch(`${BASE}/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    check('summarize is gone', summarize.status === 404, `${summarize.status}`);
  }

  console.log('\nedit');
  const id = t.data.entry.id;
  const up = await call(`/entries/${id}/update`, { title: '__probe renamed' });
  check('title updates', up.data.entry && up.data.entry.title === '__probe renamed');
  check('rejects blank title', (await call(`/entries/${id}/update`, { title: ' ' })).status === 400);
  check('rejects bad frequency',
    (await call(`/entries/${h.data.entry.id}/update`, { frequency: 'sometimes' })).status === 400);

  // The type is fixed once set: changing it would leave a frequency on
  // something that is no longer a habit.
  const retyped = await call(`/entries/${id}/update`, { type: 'habit', frequency: 'daily' });
  check('the type cannot be changed',
    retyped.status !== 200 || retyped.data.entry.type === 'task',
    JSON.stringify(retyped.data).slice(0, 90));

  console.log('\ntwo projects are simply two rows');
  // There is no position to collide over and nothing enforces uniqueness.
  const dup = await call('/entries', { type: 'project', title: '__probe second' });
  check('a second project is simply accepted', dup.status === 200, dup.data.error || '');
  if (dup.data.entry) made.push(dup.data.entry.id);

  // Where it lands is decided by how long it has been left, not by being new.
  const listed = (await call('/entries')).data.items;
  check('and it is in the list', listed.some((i) => i.title === '__probe second'), `${listed.length} items`);
  check('carrying no position', listed.every((i) => i.sort_order === undefined));
  check('and no cold flag', listed.every((i) => i.cold === undefined));

  console.log('\nfinishing and deleting');
  {
    const habitDone = await call(`/entries/${h.data.entry.id}/done`, {});
    check('a habit cannot be finished', habitDone.status === 400, habitDone.data.error);

    const projectDone = await call(`/entries/${bareProject.data.entry.id}/done`, {});
    check('nor a project', projectDone.status === 400, projectDone.data.error);

    const taskDone = await call(`/entries/${id}/done`, {});
    check('a task can be', taskDone.status === 200, JSON.stringify(taskDone.data));

    const after = (await call('/entries')).data;
    check('and it leaves the list', !after.items.some((i) => i.id === id));
  }

  console.log('\ndelete is soft');
  const victim = dup.data.entry.id;
  await call(`/entries/${victim}/delete`, {});
  const after = (await call('/entries')).data;
  check('deleted item leaves the feed', !after.items.some((i) => i.id === victim));

  const supabase = H.db;
  const { data: tomb } = await supabase.from('entries').select('id, status').eq('id', victim).maybeSingle();
  check('row survives as a tombstone', tomb && tomb.status === 'deleted');

  console.log('\ncleanup');
  for (const rid of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', rid);
  const final = (await call('/entries')).data;
  check('back to the rows it started with', final.items.length === baseline, `${final.items.length}`);

  console.log(bad === 0 ? '\nEntries clean' : `\n${bad} FAILURE(S)`);
  server.kill();
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error('harness error:', err.message);
  server.kill();
  process.exit(1);
});
