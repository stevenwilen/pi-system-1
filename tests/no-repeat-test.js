// Storage and no-repeat. Two real model calls on the same day's figures: the
// second must have read the first and said something else.
const H = require('./harness');
const U = H.TEST_USER_ID;
process.env.SCHEDULER_DISABLED = '1';

// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const supabase = H.db;
const insight = require(ROOT + '/finance-insight.js');


let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const made = [];

async function addIntent(title, body) {
  const { data, error } = await supabase
    .from('entries').insert({ user_id: U, type: 'finance_intent', title, body }).select('id').single();
  if (error) throw new Error(error.message);
  made.push(data.id);
}

// Content words only, so two lines about the same subject overlap and two
// about different subjects do not.
const STOP = new Set('the a an and or but is was are were be been being to of in on at for with from that this it its as by so if than then there here you your has have had not no yet still just about into over under more most less least any all some'.split(' '));
const words = (s) =>
  new Set(
    String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  const today = new Date().toISOString().slice(0, 10);

  console.log('storage is available');
  const probe = await supabase
    .from('entries').insert({ user_id: U, type: 'finance_insight', title: '__probe', body: 'x' }).select('id').maybeSingle();
  if (probe.error) {
    console.log('  FAIL  finance_insight rejected: run migration-finance-insight.sql first');
    process.exit(1);
  }
  await supabase.from('entries').delete().eq('user_id', U).eq('id', probe.data.id);
  check('finance_insight accepted', true);

  await addIntent('situation: Between jobs until 16 August', 'No income arriving before then. Spending down savings.');
  await addIntent('declared: Spanish tutoring', 'Chosen deliberately. Not a leak, and not to be raised.');
  await addIntent('slip: Takeaway coffee', 'Already known about. Only worth mentioning if it grows.');

  console.log('\nfirst call');
  const one = await insight.generateDaily(U, today);
  console.log(`    ${one.text || '(nothing: ' + one.skipped + ')'}`);
  check('produced a line', Boolean(one.text));

  const { data: after1 } = await supabase
    .from('entries').select('id, title, body').eq('user_id', U).eq('type', 'finance_insight');
  for (const r of after1 || []) made.push(r.id);
  check('stored', after1.length === 1, `${after1.length} row(s)`);
  check('the body is the line', after1[0] && after1[0].body === one.text);
  check('titled with the date', after1[0] && after1[0].title === `finance: ${today}`);

  console.log('\nthe second call can see the first');
  const briefing = await insight.buildBriefing(U, today);
  const rendered = insight.render(briefing);
  check("the first line is in the second call's briefing", rendered.includes(one.text));
  check('and is labelled as already said', /WHAT YOU HAVE ALREADY SAID[\s\S]*?do not repeat/i.test(rendered));

  console.log('\nsecond call');
  const two = await insight.generateDaily(U, today);
  console.log(`    ${two.text || '(nothing: ' + two.skipped + ')'}`);
  check('produced a line', Boolean(two.text));

  console.log('\ncomparison');
  check('not the same sentence', one.text !== two.text);

  const a = words(one.text);
  const b = words(two.text);
  const shared = [...a].filter((w) => b.has(w));
  const overlap = shared.length / Math.min(a.size, b.size);
  console.log(`    shared content words: ${shared.join(', ') || 'none'}`);
  console.log(`    overlap: ${Math.round(overlap * 100)}%`);
  check('not a restatement', overlap < 0.6, `${Math.round(overlap * 100)}% of the shorter line's content words`);

  const { data: after2 } = await supabase
    .from('entries').select('id, body').eq('user_id', U).eq('type', 'finance_insight');
  for (const r of after2 || []) if (!made.includes(r.id)) made.push(r.id);
  check('both stored', after2.length === 2, `${after2.length}`);

  console.log('\nwhat is stored is the insight, not the transactions');
  // A merchant named inside the sentence is the insight: naming recurring
  // charges is the job. What must never be stored is a transaction, so the
  // test is that each row is one sentence rather than a record of anything.
  const dump = JSON.stringify(after2);
  check('one row per call, no more', after2.length === 2);
  check('each body is a single sentence', after2.every((r) => r.body.split('\n').length === 1));
  check('no transaction row shape stored', !/\d{4}-\d{2}-\d{2}\s*[,|]\s*-?[\d.]+/.test(dump));
  check('no category breakdown stored', !/Food.*Gas.*Work|Work.*Entertainment.*Food/is.test(dump));
  check('nothing but insights was written', after2.every((r) => r.body.length < 250));

  const { count: strayTypes } = await supabase
    .from('entries').select('*', { count: 'exact', head: true })
    .eq('user_id', U).not('type', 'in', '(habit,project,task,finance_intent,finance_insight)');
  check('no other row type appeared', strayTypes === 0, `${strayTypes}`);

  console.log('\ncleanup');
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  const { count: left } = await supabase
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U).in('type', ['finance_intent', 'finance_insight']);
  check('probe rows removed', left === 0, `${left}`);

  console.log(bad === 0 ? '\nNo-repeat clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  process.exit(1);
});
