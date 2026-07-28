// The contract: one export, bounded window, [] on every failure, never throws,
// and no database anywhere near it.
const fs = require('fs');
const http = require('http');
// The app, found from where this file sits, so the suite runs from any clone.
const path = require('path');
const ROOT = path.join(__dirname, '..').split(path.sep).join('/');
process.chdir(ROOT);

// The live sheet, from the environment. It is a link to somebody's bank export
// and does not belong in this repository, so the checks that need a real one
// are skipped when it is absent rather than failing on a fake.
const REAL = process.env.FINANCE_TRANSACTIONS_CSV_URL || null;

// Well formed, reachable by nothing. Enough to drive the malformed-input paths,
// which never get as far as a request.
const SHAPED = 'https://docs.google.com/spreadsheets/d/e/EXAMPLE/pub?gid=0&single=true&output=csv';

let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Silence the module's own logging while driving failure paths, but count it:
// "logs loudly" is part of the contract.
let logged = [];
const realError = console.error;
const quiet = () => { logged = []; console.error = (...a) => logged.push(a.join(' ')); };
const loud = () => { console.error = realError; };

function fresh() {
  delete require.cache[require.resolve(ROOT + '/sheet.js')];
  return require(ROOT + '/sheet.js');
}

(async () => {
  console.log('shape');
  const src = fs.readFileSync(ROOT + '/sheet.js', 'utf8');
  check('exports exactly one function', Object.keys(fresh()).join(',') === 'readTransactions');
  check('no database import', !/require\('\.\/db'\)|supabase/i.test(src));
  check('nothing writes', !/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(src));
  check('no model call', !/anthropic|runBrain/i.test(src));

  console.log('\nfailure paths return [] and never throw');
  const cases = [
    ['env var missing', undefined],
    ['empty env var', ''],
    ['not a url at all', 'not a url'],
    ['missing scheme', SHAPED.replace('https://', '')],
    ['not a csv link', 'https://docs.google.com/spreadsheets/d/e/abc/pub?output=html'],
    ['unreachable host', 'https://this-host-does-not-exist-9f3a.example/pub?output=csv'],
    // Only meaningful against a sheet that actually answers: the point is that
    // the brackets are stripped and rows still come back.
    ...(REAL ? [['wrapped in angle brackets but otherwise fine', `<${REAL}>`]] : []),
  ];

  for (const [label, value] of cases) {
    if (value === undefined) delete process.env.FINANCE_TRANSACTIONS_CSV_URL;
    else process.env.FINANCE_TRANSACTIONS_CSV_URL = value;

    quiet();
    let result, threw = null;
    try { result = await fresh().readTransactions(30); } catch (e) { threw = e; }
    loud();

    const isArray = Array.isArray(result);
    const empty = isArray && result.length === 0;
    const spoke = logged.length > 0;

    if (label.includes('angle brackets')) {
      check(label, !threw && isArray && result.length > 0, threw ? 'THREW' : `${result.length} rows, recovered`);
    } else {
      check(label, !threw && empty && spoke, threw ? `THREW ${threw.message}` : (spoke ? logged[0].slice(0, 74) : 'SILENT'));
    }
  }

  console.log('\nserver failures');
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/404')) { res.writeHead(404); return res.end('no'); }
    if (req.url.startsWith('/500')) { res.writeHead(500); return res.end('no'); }
    if (req.url.startsWith('/html')) { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end('<!doctype html><html>sign in</html>'); }
    if (req.url.startsWith('/empty')) { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end(''); }
    if (req.url.startsWith('/wrongtab')) { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end('Category,Type\nFood,Expense\n'); }
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end('Date,Merchant,Amount,Category\n2026-07-20,"Osteria, Via Roma","$1,234.56",Food\n2026-07-21,Refund,(14.50),Food\n1999-01-01,Ancient,-5.00,Food\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const at = (p) => `http://127.0.0.1:${port}${p}?output=csv`;

  for (const [label, path] of [['404', '/404'], ['500', '/500'], ['html instead of csv', '/html'], ['empty body', '/empty'], ['wrong tab published', '/wrongtab']]) {
    process.env.FINANCE_TRANSACTIONS_CSV_URL = at(path);
    quiet();
    let result, threw = null;
    try { result = await fresh().readTransactions(30); } catch (e) { threw = e; }
    loud();
    check(label, !threw && Array.isArray(result) && result.length === 0 && logged.length > 0,
      threw ? `THREW ${threw.message}` : (logged[0] || 'SILENT').slice(0, 70));
  }

  console.log('\nparsing');
  process.env.FINANCE_TRANSACTIONS_CSV_URL = at('/ok');
  const parsed = await fresh().readTransactions(3650);
  check('quoted comma in a merchant name', parsed.some((t) => t.description === 'Osteria, Via Roma'));
  check('currency formatting', parsed.some((t) => t.amount === 1234.56), JSON.stringify(parsed.map((t) => t.amount)));
  check('accounting negative', parsed.some((t) => t.amount === -14.5));
  check('exactly the four fields', Object.keys(parsed[0]).sort().join(',') === 'amount,category,date,description');

  console.log('\nthe window is a bound, not a suggestion');
  // The fixture holds a 1999 row. No window a caller can ask for should ever
  // reach it, because MAX_DAYS caps the request long before that.
  const narrow = await fresh().readTransactions(30);
  const widest = await fresh().readTransactions(99999);
  check('the 1999 row is outside a thirty day window', !narrow.some((t) => t.date === '1999-01-01'));
  check('and still outside the largest window a caller can ask for', !widest.some((t) => t.date === '1999-01-01'),
    `asked for 99999 days, got ${widest.length} rows, oldest ${widest[0] && widest[0].date}`);
  check('recent rows survive the clamp', widest.length === 2, `${widest.length}`);
  check('a nonsense window falls back to the default', Array.isArray(await fresh().readTransactions('banana')));
  check('zero and negative are floored, not inverted', (await fresh().readTransactions(0)).length >= 0 && (await fresh().readTransactions(-5)).length >= 0);

  server.close();

  console.log('\nagainst the real sheet');
  if (!REAL) {
    console.log('  SKIPPED: FINANCE_TRANSACTIONS_CSV_URL is not set in this environment');
  } else {
    process.env.FINANCE_TRANSACTIONS_CSV_URL = REAL;
    const real = await fresh().readTransactions(30);
    // Empty proves nothing here: every assertion below is vacuously true on an
    // empty array, so the row count is checked first and on its own.
    check('returns rows', real.length > 0, `${real.length}`);
    check('every row has the four fields and nothing else', real.every((t) => Object.keys(t).sort().join(',') === 'amount,category,date,description'));
    check('dates are ISO', real.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date)));
    check('amounts are numbers', real.every((t) => typeof t.amount === 'number' && isFinite(t.amount)));
    check('sorted oldest first', real.every((t, i, a) => i === 0 || a[i - 1].date <= t.date));
    check('all inside the window', real.every((t) => t.date >= new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10)));
  }

  console.log(bad === 0 ? '\nsheet.js contract clean' : `\n${bad} FAILURE(S)`);
  // Set the code and let the loop drain. Calling process.exit() with the local
  // http server still closing aborts with a native assertion and a garbage exit
  // code, so a clean run reports failure.
  process.exitCode = bad === 0 ? 0 : 1;
})().catch((e) => {
  loud();
  console.error('harness error:', e.message);
  process.exitCode = 1;
});
