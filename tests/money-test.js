// Finance step 3. Arithmetic on fixtures, then the endpoint against the real
// sheet. No model call anywhere in the path.
const { spawn } = require('child_process');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

const { summarise, findTransfers } = require(ROOT + '/money.js');

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const t = (date, description, amountValue, category = '') => ({ date, description, amount: amountValue, category });

(async () => {
  console.log('transfer pairing');
  {
    // Both halves of a card payment, uncategorised, two days apart.
    const rows = [
      t('2026-07-17', 'Payment', 323.18),
      t('2026-07-17', 'Chase Credit Card', -323.18),
      t('2026-07-18', 'Groceries', -40.0, 'Groceries'),
    ];
    const idx = findTransfers(rows);
    check('an exact offsetting pair is a transfer', idx.has(0) && idx.has(1));
    check('an ordinary charge is not', !idx.has(2));
  }
  {
    const rows = [
      t('2026-07-01', 'Refund', 15.0, 'Food'),
      t('2026-07-20', 'Dinner', -15.0, 'Food'),
    ];
    check('same amount far apart is not paired', findTransfers(rows).size === 0, 'nineteen days apart');
  }
  {
    const rows = [
      t('2026-07-01', 'Uber', -15.09, 'Shopping'),
      t('2026-07-03', 'Transfer from Venmo', 14.9, 'Shopping'),
    ];
    check('a near miss is not paired', findTransfers(rows).size === 0, '15.09 against 14.90');
  }
  {
    // One positive, two candidate negatives: only one may be consumed.
    const rows = [
      t('2026-07-01', 'A', -20.0),
      t('2026-07-02', 'B', -20.0),
      t('2026-07-02', 'Payment', 20.0),
    ];
    const idx = findTransfers(rows);
    check('a pair consumes one partner, not both', idx.size === 2, `${idx.size} marked`);
  }
  {
    const rows = [t('2026-07-13', 'Fidelity Brokerage Services', 499.6, 'Transfer')];
    check('a lone half the sheet calls Transfer is still a transfer', findTransfers(rows).has(0),
      'pairing alone would have read this as income');
  }

  console.log('\ntotals');
  {
    const rows = [
      t('2026-07-01', 'Dinner', -120.0, 'Food'),
      t('2026-07-02', 'Friend paid me back', 80.0, 'Food'),
      t('2026-07-03', 'Shell', -54.78, 'Gas'),
      t('2026-07-04', 'Payment', 300.0),
      t('2026-07-04', 'Chase Credit Card', -300.0),
      t('2026-07-05', 'Fidelity', 499.6, 'Transfer'),
      t('2026-07-06', 'Venmo', -25.0),
    ];
    const s = summarise(rows, '2026-07-08');

    // Food nets 40 (120 out, 80 back), Gas 54.78, the uncategorised Venmo 25.
    // The 300 pair and the 499.60 brokerage row are in neither total.
    check('transfers excluded from spend', s.total_spend === 119.78, `${s.total_spend}`);
    check('a reimbursement nets against its category', s.categories.find((c) => c.category === 'Food').amount === 40);
    check('transfers counted separately', s.transfers.count === 3, `${s.transfers.count}`);
    check('moved is the inbound side', s.transfers.moved === 799.6, `${s.transfers.moved}`);
    check('uncategorised reported apart from the named categories', s.uncategorised.count === 1 && s.uncategorised.amount === 25);
    check('uncategorised is not in the category list', !s.categories.some((c) => c.category === ''));
    check('categories sorted biggest first', s.categories.map((c) => c.category).join(',') === 'Gas,Food', s.categories.map((c) => c.category).join(','));
  }
  {
    // A refund inside the window whose charge is outside it.
    const rows = [t('2026-07-06', 'Zelle', 43.0, 'Groceries'), t('2026-07-06', 'Publix', -2.97, 'Groceries')];
    const s = summarise(rows, '2026-07-08');
    check('a category may net negative', s.categories[0].amount === -40.03, `${s.categories[0].amount}`);
    check('and the total follows it', s.total_spend === -40.03, `${s.total_spend}`);
  }

  console.log('\nsync age');
  for (const [newest, today, days, stale] of [
    ['2026-07-27', '2026-07-27', 0, false],
    ['2026-07-26', '2026-07-27', 1, false],
    ['2026-07-24', '2026-07-27', 3, false],
    ['2026-07-23', '2026-07-27', 4, true],
    ['2026-07-21', '2026-07-27', 6, true],
  ]) {
    const s = summarise([t(newest, 'x', -1, 'Food')], today);
    check(`${days} day(s) old -> ${stale ? 'stale' : 'fresh'}`, s.sync.days_ago === days && s.sync.stale === stale,
      `days_ago ${s.sync.days_ago}, stale ${s.sync.stale}`);
  }
  check('an empty window reports no date rather than guessing', (() => {
    const s = summarise([], '2026-07-27');
    return s.sync.newest === null && s.sync.days_ago === null && s.sync.stale === false;
  })());

  console.log('\npurity');
  const fs = require('fs');
  const src = fs.readFileSync(ROOT + '/money.js', 'utf8');
  check('no database', !/supabase|require\('\.\/db'\)/.test(src));
  check('no model', !/anthropic|runBrain|messages/i.test(src));
  check('no fetch', !/fetch\(/.test(src));
  check('no clock read, today is passed in', !/new Date\(\)/.test(src));

  console.log('\nthe endpoint, against the real sheet');

  // Everything above is fixtures and runs anywhere. What follows needs the
  // sheet, which lives in the environment and not in this repository, so say
  // so plainly rather than failing on an assertion that looks like a bug.
  if (!process.env.FINANCE_TRANSACTIONS_CSV_URL) {
    console.log('  SKIPPED: FINANCE_TRANSACTIONS_CSV_URL is not set in this environment');
    console.log(bad === 0 ? '\nFinance arithmetic clean (endpoint skipped)' : `\n${bad} FAILURE(S)`);
    process.exit(bad === 0 ? 0 : 1);
  }

  const PORT = 3981;
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // Pointed at the throwaway user even though this suite only reads. The
      // sheet is not per-user, so nothing here needs the real one, and a
      // server started as the real person is a loaded gun sitting in a test.
      PI_USER_ID: '00000000-0000-0000-0000-00000000fee1',
      SCHEDULER_DISABLED: '1',
      // Inherited from the environment rather than written down here. The URL
      // was inline until this file moved into the repository, where a link to
      // someone's bank export does not belong.
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/entries'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  const res = await fetch(`${BASE}/finance-summary?days=60`);
  const data = await res.json();

  check('200', res.status === 200);
  check('connected', data.connected === true);
  check('window reported', Boolean(data.window.from && data.window.to), `${data.window.from} to ${data.window.to}`);

  console.log(`\n    ${data.transactions} transactions, ${data.window.from} to ${data.window.to}`);
  console.log(`    last synced ${data.sync.days_ago} days ago (${data.sync.newest})${data.sync.stale ? '  STALE' : ''}`);
  console.log(`    total spend ${data.total_spend.toFixed(2)}`);
  for (const c of data.categories) console.log(`      ${c.category.padEnd(16)} ${c.amount.toFixed(2).padStart(9)}  ${c.count}`);
  if (data.uncategorised.count) console.log(`      ${'(uncategorised)'.padEnd(16)} ${data.uncategorised.amount.toFixed(2).padStart(9)}  ${data.uncategorised.count}`);
  console.log(`    moved between accounts ${data.transfers.moved.toFixed(2)} across ${data.transfers.count} rows`);

  // These were once three frozen figures — a total of 390.60, five transfer
  // rows, and Groceries at -40.03 — cross-checked against what the deleted
  // implementation produced for the same sheet. That agreement was worth
  // having, and it is gone: the sheet is a live document the person edits, so
  // pinning a number to it means the test fails on the day they recategorise a
  // row rather than on the day the code breaks. Which is exactly what happened.
  //
  // What replaces it is what must be true of ANY window: the parts have to add
  // up to the whole, and every row has to land in exactly one bucket. The
  // hand-computed arithmetic above still pins the actual numbers, on fixtures
  // that cannot move.
  const near = (a, b) => Math.abs(a - b) < 0.005;

  const catSum = data.categories.reduce((s, c) => s + c.amount, 0) + data.uncategorised.amount;
  check('the categories add up to the total', near(catSum, data.total_spend),
    `${catSum.toFixed(2)} against ${data.total_spend.toFixed(2)}`);

  const catCount = data.categories.reduce((s, c) => s + c.count, 0) + data.uncategorised.count;
  check('every transaction lands in exactly one bucket',
    catCount + data.transfers.count === data.transactions,
    `${catCount} counted + ${data.transfers.count} transfers against ${data.transactions} rows`);

  const inbound = data.transfers.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  check('moved is the inbound side of the transfer rows', near(inbound, data.transfers.moved),
    `${inbound.toFixed(2)} against ${data.transfers.moved.toFixed(2)}`);

  check('no transfer leaked into a category', !data.categories.some((c) => c.category.toLowerCase() === 'transfer'));
  check('the window is inside the days asked for',
    data.window.from >= new Date(Date.now() - 61 * 864e5).toISOString().slice(0, 10),
    `${data.window.from} to ${data.window.to}`);
  check('sync age agrees with the newest row',
    data.sync.newest === data.window.to && typeof data.sync.days_ago === 'number',
    `newest ${data.sync.newest}, window ends ${data.window.to}`);

  console.log(bad === 0 ? '\nFinance step 3 clean' : `\n${bad} FAILURE(S)`);

  // Calling process.exit() from inside the child's own 'exit' handler tears
  // down a libuv handle that is already closing, which aborts the process with
  // a native assertion and a garbage exit code — so a clean run reported
  // failure. Set the code and let the loop drain instead: with the child dead
  // and its pipes closed there is nothing left to keep it alive.
  process.exitCode = bad === 0 ? 0 : 1;
  server.stdout.destroy();
  server.stderr.destroy();
  server.kill();
})().catch((e) => { console.error('harness error:', e.message); process.exit(1); });
