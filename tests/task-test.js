// Tasks through the tool layer.
//
// This suite predated the test user and wrote to the real one, through db.js
// directly, so the guard never saw it. It also never cleaned up, so every run
// left two more rows in the real person's list. Rewritten to go through the
// harness like every other writer, and to remove what it makes.
const H = require('./harness');
// The test account, discovered rather than written down. It is a real auth
// user now, created by the harness, so its id is not knowable until it
// exists — which is why this is assigned inside the run rather than at the
// top of the file.
let U;
const ROOT = H.ROOT;
process.chdir(ROOT);

const tools = require(ROOT + '/tools.js');

// The tools take a client now, and this suite hands them the harness's guarded
// one. That is the service client underneath, so these cases exercise the tool
// logic rather than row level security — which is the right split: the policies
// are proved in isolation-accounts-test.js, against the client a route actually
// builds, and proving them here as well would mean proving them wherever a tool
// happens to be called. What the guarded handle still gives is the write guard,
// which is what keeps this suite off anybody else's rows.

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

(async () => {
  U = await H.userId();
  await H.assertGuarded();
  await H.ensureProfile();

  console.log('creating');
  const t = await tools.create_entry(H.db, U, {
    type: 'task',
    title: 'Return the router to the post office',
  });
  check('a task is created', !t.error && t.type === 'task', t.error || `${t.type} status=${t.status}`);
  check('it starts active', t.status === 'active', t.status);

  // Backdated, to prove an old task is still an open one.
  const old = new Date();
  old.setUTCDate(old.getUTCDate() - 40);
  const { data: o, error: oe } = await H.db
    .from('entries')
    .insert({
      user_id: U,
      type: 'task',
      title: 'Cancel the unused domain',
      created_at: old.toISOString(),
    })
    .select()
    .single();
  check('an old task is created', !oe, oe ? oe.message : `created ${o.created_at.slice(0, 10)}`);

  console.log('\nsearching');
  const open = await tools.search_entries(H.db, U, null, 'task', 50);
  check('both open tasks come back', Array.isArray(open) && open.length === 2, Array.isArray(open) ? `${open.length}` : open.error);

  console.log('\ncompleting');
  const done = await tools.update_entry(H.db, U, t.id, { status: 'done' });
  check('a task can be marked done', !done.error && done.status === 'done', done.error || done.status);

  const after = await tools.search_entries(H.db, U, null, 'task', 50);
  check('a done task drops out of the search', after.length === 1, `${after.length}`);
  check('and the one left is the old one', after[0].id === o.id);

  console.log('\nsent_log');
  const { error: se } = await H.db
    .from('sent_log')
    .insert({ user_id: U, job: 'tasks', sent_for_date: '1999-01-01' });
  check('sent_log accepts a tasks row', !se, se && se.message);

  console.log('\ncleanup');
  await H.cleanup();
  const { count } = await H.service
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('every row this made is gone', count === 0, `${count} left`);

  const { count: logs } = await H.service
    .from('sent_log').select('*', { count: 'exact', head: true }).eq('user_id', U);
  check('and the sent_log row too', logs === 0, `${logs} left`);

  console.log(bad === 0 ? '\nTasks clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  await H.cleanup();
  process.exit(1);
});
