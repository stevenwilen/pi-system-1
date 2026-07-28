// Finance step 4. Real sheet, real intent rows, one real model call.
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

(async () => {
  // Refuses to run at all if the guard is not live.
  await H.assertGuarded();
  await H.ensureProfile();

  const today = new Date().toISOString().slice(0, 10);

  console.log('parser');
  check('accepts a plain sentence', insight.parseLine('Google Cloud has charged five times this month.') !== null);
  check('strips wrapping quotes', insight.parseLine('"Steady month."') === 'Steady month.');
  check('rejects empty', insight.parseLine('   ') === null);
  check('rejects a report', insight.parseLine('Here:\n- Food 68\n- Gas 54') === null);
  check('rejects an overlong line', insight.parseLine('x'.repeat(250)) === null);
  check('rejects nothing at all', insight.parseLine(null) === null);

  console.log('\nintent rows the message must respect');
  await addIntent('situation: Between jobs until 16 August', 'No income arriving before then. Spending down savings.');
  await addIntent('declared: Spanish tutoring', 'Chosen deliberately. Not a leak, and not to be raised.');
  await addIntent('slip: Takeaway coffee', 'Already known about. Only worth mentioning if it grows.');
  await addIntent('reserve/wall: Brokerage account', 'Would have to be sold and transferred on purpose.');
  check('four intent rows in place', made.length === 4);

  console.log('\nbriefing');
  const briefing = await insight.buildBriefing(U, today);
  check('built', briefing !== null);

  const text = insight.render(briefing);
  console.log('\n' + text.split('\n').map((l) => '    ' + l).join('\n'));

  check('states the sheet age', /THE SHEET IS \d+ DAYS OLD|sheet is current/.test(text));
  check('transfers already excluded before the model sees anything', /transfers already excluded/.test(text));
  check('names the money moved separately', /moved between their own accounts/i.test(text));
  check('carries every intent row', ['situation:', 'declared:', 'slip:', 'reserve/wall:'].every((k) => text.includes(k)));
  check('tells it what it has already said', /WHAT YOU HAVE ALREADY SAID/.test(text));
  check('no raw transaction list', !/Pete's Bagels|Trader Joe/.test(text), 'individual purchases are not sent');

  console.log('\none real model call');
  const before = Date.now();
  const result = await insight.generateDaily(U, today);
  console.log(`    took ${Math.round((Date.now() - before) / 1000)}s`);

  console.log(`\n    LINE: ${result.text || '(nothing sent: ' + result.skipped + ')'}\n`);

  check('produced a line', Boolean(result.text), JSON.stringify(result));
  if (result.text) {
    check('one sentence', result.text.split('\n').length === 1);
    check('within the limit', result.text.length <= 200, `${result.text.length} chars`);
    check('asks nothing', !result.text.includes('?'));
    check('no em dash', !result.text.includes('\u2014'));
    check('does not raise the declared item', !/tutoring|spanish/i.test(result.text), 'declared rows are never flagged');
    check('does not announce the known slip exists', !/^you spend on coffee|coffee is a/i.test(result.text));
    check('mentions the sheet being stale', /stale|old|since|synced|\bdays\b/i.test(result.text), 'the sheet is 6 days behind');
  }

  console.log('\nit was stored, and only the line');
  const { data: stored } = await supabase
    .from('entries').select('id, type, title, body').eq('user_id', U).eq('type', 'finance_insight');
  if (stored && stored.length) {
    for (const s of stored) made.push(s.id);
    check('one row stored', stored.length === 1, `${stored.length}`);
    check('the body is the line', stored[0].body === result.text);
    // This used to forbid any merchant name in the stored row, and it was
    // wrong. The engine is told to name a repeated charge — "these arrive
    // without a decision being made, which is what makes them worth naming" —
    // and SPEC 7 says the daily line names recurring charges specifically. So
    // a merchant in the line is the feature working. The check passed for
    // months only because the model happened not to name one of five, and it
    // failed the first time the system did exactly what it was built to do.
    //
    // What the rule actually protects is that TRANSACTIONS are never stored.
    // The row must be the sentence and nothing else: no rows, no listing, no
    // second field carrying sheet data.
    const row = stored[0];
    check('the row carries nothing but the line and its label',
      Object.keys(row).sort().join(',') === 'body,id,title,type' &&
      row.type === 'finance_insight' &&
      /^finance: \d{4}-\d{2}-\d{2}$/.test(row.title),
      `${row.title}`);
    check('the stored body is one sentence, not a listing',
      row.body === result.text && !row.body.includes('\n') && row.body.length <= 200,
      `${row.body.length} chars`);
  } else {
    check('one row stored', false, 'nothing stored: has migration-finance-insight.sql been run?');
  }

  console.log('\nit will not repeat itself tomorrow');
  const second = await insight.buildBriefing(U, today);
  const secondText = insight.render(second);
  check('yesterday\'s line is fed back in', result.text ? secondText.includes(result.text) : false);

  console.log('\nno sheet data reaches the database');
  const { data: allRows } = await supabase.from('entries').select('title, body').eq('user_id', U);
  const dump = JSON.stringify(allRows);
  // One sentence may name the charge it is about. A transaction list may not
  // be stored, so the test is how MANY of the sheet's merchants appear: one is
  // the insight naming its subject, several would mean rows had been copied in.
  const MERCHANTS = /Google Cloud|Kalshi|Trader Joe|Pete's Bagels|Shell|Chase Credit Card|Fidelity/g;
  const named = [...new Set(dump.match(MERCHANTS) || [])];
  check('no transaction listing stored', named.length <= 1, named.join(',') || 'none named');
  check('no computed total stored', !/390\.6|1129\.4|290\.6/.test(dump));
  // Dates and amounts are what a transaction is. A stored row must not carry
  // both against the same merchant, which is what copying a row would look like.
  check('no dated amount stored', !/\d{4}-\d{2}-\d{2}[^"]{0,40}[$]\s?\d/.test(dump));

  console.log('\nengine purity');
  const fs = require('fs');
  const src = fs.readFileSync(ROOT + '/finance-insight.js', 'utf8');
  const brainSrc = fs.readFileSync(ROOT + '/brain.js', 'utf8');
  check('brain.js still knows nothing about money', !/finance|money|spend|runway|reserve/i.test(brainSrc));
  check('no amount written into the prompt', !/[$£€]\s*[\d.]|\b\d{2,}\.\d{2}\b/.test(src.match(/const TASK = `[\s\S]*?`;/)[0]));
  // Word boundaries: an unanchored "chase" matches inside "purchase", which
  // the prompt uses legitimately.
  check('no merchant or account named in the engine', !/\b(google cloud|kalshi|chase|fidelity|venmo|zelle)\b/i.test(src));

  console.log('\ncleanup');
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  const { count: left } = await supabase
    .from('entries').select('*', { count: 'exact', head: true }).eq('user_id', U).in('type', ['finance_intent', 'finance_insight']);
  check('probe rows removed', left === 0, `${left}`);

  console.log(bad === 0 ? '\nFinance step 4 clean' : `\n${bad} FAILURE(S)`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('harness error:', e.message);
  for (const id of made) await supabase.from('entries').delete().eq('user_id', U).eq('id', id);
  process.exit(1);
});
