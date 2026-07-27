// Arithmetic on transactions. No I/O, no database, no model.
//
// Everything here is counting and matching. Nothing in this file decides what
// anything means, and no figure it produces is ever written down: the caller
// reads the sheet, calls this, sends the result to the screen, and drops the
// transactions.

// How far apart the two halves of a transfer may sit. A credit card payment
// posts on both accounts within a day or two; anything wider starts matching
// unrelated charges that happen to share an amount.
const PAIR_WINDOW_DAYS = 4;

// Beyond this, the sheet has stopped arriving and the screen has to say so.
const STALE_AFTER_DAYS = 3;

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);

const round = (n) => Math.round(n * 100) / 100;

/**
 * Which rows are internal movement rather than spending.
 *
 * Two mechanisms, both arithmetic, and both needed.
 *
 * The sheet's own Transfer category is authoritative where it is set. It
 * catches the lone half of a movement whose other side falls outside the
 * window, which pairing cannot see: a brokerage deposit with no matching
 * withdrawal would otherwise read as income that was never earned.
 *
 * Pairing then catches what categorising missed. An exact offsetting amount
 * within a few days is money that left one account and arrived in another, and
 * counting either half is wrong however it happens to be labelled.
 */
function findTransfers(rows) {
  const transfer = new Set();

  rows.forEach((r, i) => {
    if (r.category.toLowerCase() === 'transfer') transfer.add(i);
  });

  // Index the unclaimed negatives by amount so each is matched at most once.
  const negatives = new Map();
  rows.forEach((r, i) => {
    if (transfer.has(i) || r.amount >= 0) return;
    const key = round(Math.abs(r.amount)).toFixed(2);
    if (!negatives.has(key)) negatives.set(key, []);
    negatives.get(key).push(i);
  });

  rows.forEach((r, i) => {
    if (transfer.has(i) || r.amount <= 0) return;

    const candidates = negatives.get(round(r.amount).toFixed(2));
    if (!candidates || !candidates.length) return;

    const at = candidates.findIndex(
      (j) => Math.abs(daysBetween(rows[j].date, r.date)) <= PAIR_WINDOW_DAYS
    );
    if (at === -1) return;

    const [j] = candidates.splice(at, 1);
    transfer.add(i);
    transfer.add(j);
  });

  return transfer;
}

/**
 * Everything the finance screen shows, counted.
 *
 * `today` is passed in rather than read from the clock, so the sync age is
 * measured in the person's own timezone and the whole function stays pure.
 */
function summarise(rows, today) {
  const transferIdx = findTransfers(rows);

  const transfers = rows.filter((_, i) => transferIdx.has(i));
  const spending = rows.filter((_, i) => !transferIdx.has(i));

  // Per category, negated so an outflow reads positive. A refund or a
  // reimbursement sits in the category of the thing it offsets and nets
  // against it, which is why a category can legitimately come out negative:
  // more came back than went out inside this window.
  const byCategory = new Map();
  for (const t of spending) {
    const key = t.category || '';
    const seen = byCategory.get(key) || { category: key, amount: 0, count: 0 };
    seen.amount -= t.amount;
    seen.count += 1;
    byCategory.set(key, seen);
  }

  const categories = [...byCategory.values()]
    .map((c) => ({ ...c, amount: round(c.amount) }))
    .sort((a, b) => b.amount - a.amount);

  const total = round(spending.reduce((n, t) => n - t.amount, 0));
  const uncategorised = categories.find((c) => c.category === '') || { amount: 0, count: 0 };

  const newest = rows.reduce((a, t) => (t.date > a ? t.date : a), '');
  const oldest = rows.reduce((a, t) => (t.date < a ? t.date : a), newest);
  const age = newest ? daysBetween(newest, today) : null;

  return {
    window: { from: oldest || null, to: newest || null },
    // Stated whether or not it is old. A screen that only mentions the date
    // when something is wrong teaches you to read its silence as freshness.
    sync: {
      newest: newest || null,
      days_ago: age,
      stale: age !== null && age > STALE_AFTER_DAYS,
    },
    total_spend: total,
    transactions: rows.length,
    categories: categories.filter((c) => c.category !== ''),
    uncategorised: { amount: round(uncategorised.amount), count: uncategorised.count },
    // Visible, separate, and in neither total. Money that moved between the
    // person's own accounts is not income and not spending.
    transfers: {
      count: transfers.length,
      moved: round(transfers.filter((t) => t.amount > 0).reduce((n, t) => n + t.amount, 0)),
      rows: transfers.map((t) => ({ date: t.date, description: t.description, amount: t.amount })),
    },
  };
}

/**
 * Merchants charged more than once in the window.
 *
 * Recurring spending is the priority signal because it happens without a
 * decision being made, so it has to be found rather than waited for. This is
 * counting only: it reports how often a name appeared, what it came to, and
 * whether the amounts held steady. It does not decide that anything is a
 * subscription, and it never guesses at a cadence the window is too short to
 * show.
 */
function repeatCharges(rows, transferIdx) {
  const byMerchant = new Map();

  rows.forEach((r, i) => {
    if (transferIdx.has(i)) return;
    if (r.amount >= 0) return; // refunds are not charges
    const key = r.description.trim();
    if (!key) return;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(r);
  });

  const out = [];

  for (const [merchant, list] of byMerchant) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));

    const amounts = list.map((r) => Math.abs(r.amount));
    const average = amounts.reduce((n, a) => n + a, 0) / amounts.length;
    // Within a fifth of the average each time. Enough to tell a fixed monthly
    // charge from a shop visited repeatedly for different amounts.
    const steady = amounts.every((a) => Math.abs(a - average) <= average * 0.2);

    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      gaps.push(Math.abs(daysBetween(list[i - 1].date, list[i].date)));
    }
    const typicalGap = gaps.length
      ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
      : null;

    out.push({
      merchant,
      times: list.length,
      total: round(amounts.reduce((n, a) => n + a, 0)),
      average: round(average),
      steady,
      typical_gap_days: typicalGap,
      first: list[0].date,
      last: list[list.length - 1].date,
    });
  }

  return out.sort((a, b) => b.total - a.total);
}

module.exports = {
  summarise,
  findTransfers,
  repeatCharges,
  STALE_AFTER_DAYS,
  PAIR_WINDOW_DAYS,
};
