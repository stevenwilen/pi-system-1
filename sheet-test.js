// Prints the last 30 days from the sheet, grouped by category.
//
// Read only. Nothing here writes to the database or to the sheet.
//
//   node sheet-test.js          last 30 days
//   node sheet-test.js 7        last 7 days

require('dotenv').config();

const { readTransactions } = require('./sheet');

const money = (n) => (n < 0 ? '-' : ' ') + Math.abs(n).toFixed(2).padStart(9);

(async () => {
  const days = Number(process.argv[2]) || 30;

  if (!process.env.FINANCE_TRANSACTIONS_CSV_URL) {
    console.log(
      'FINANCE_TRANSACTIONS_CSV_URL is not set locally. It lives in Railway.\n' +
        'Add it to .env to run this here, or run it on the server.\n'
    );
  }

  const rows = await readTransactions(days);

  if (!rows.length) {
    console.log(`\nNothing came back for the last ${days} days. Any reason is logged above.`);
    return;
  }

  console.log(`\nLast ${days} days: ${rows.length} transactions, ${rows[0].date} to ${rows[rows.length - 1].date}\n`);

  const byCategory = new Map();
  for (const t of rows) {
    const key = t.category || '(not yet categorised)';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(t);
  }

  // Biggest outflow first, so the categories worth looking at are at the top.
  const sorted = [...byCategory.entries()].sort((a, b) => {
    const sum = (list) => list.reduce((n, t) => n + t.amount, 0);
    return sum(a[1]) - sum(b[1]);
  });

  for (const [category, list] of sorted) {
    const total = list.reduce((n, t) => n + t.amount, 0);
    console.log(`${category}   ${money(total)}   ${list.length} transaction${list.length === 1 ? '' : 's'}`);
    for (const t of list) {
      console.log(`    ${t.date}  ${money(t.amount)}  ${t.description}`);
    }
    console.log('');
  }

  // Deliberately arithmetic only: sums of what came back, with no notion of
  // what a transfer is or which categories count. That judgment belongs to
  // whatever consumes this, not to a reader.
  const out = rows.filter((t) => t.amount < 0).reduce((n, t) => n + t.amount, 0);
  const inn = rows.filter((t) => t.amount > 0).reduce((n, t) => n + t.amount, 0);

  console.log('-'.repeat(52));
  console.log(`out         ${money(out)}`);
  console.log(`in          ${money(inn)}`);
  console.log(`net         ${money(out + inn)}`);
  console.log(`categories  ${byCategory.size}`);

  const blank = rows.filter((t) => !t.category);
  if (blank.length) {
    console.log(`\n${blank.length} transaction${blank.length === 1 ? '' : 's'} not yet categorised, covering ${money(blank.reduce((n, t) => n + t.amount, 0)).trim()}.`);
  }
})();
