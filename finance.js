// Reads the transaction database and works out what actually happened.
//
// Every number here is computed, never inferred by a model. The sign rules,
// transfer exclusion and reimbursement handling in the handoff document are
// precisely the things an LLM gets quietly wrong, and a coach that miscounts
// is worse than no coach.
//
// The sheet is read only, over published CSV. Nothing here can write to it.

require('dotenv').config();

const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Spec section 4, as of 2026-07-27. The spec is explicit that this is a
// snapshot and that the Categories tab wins at runtime, so this is a fallback
// for when that tab is not reachable, not the source of truth.
//
// The tab is hidden, and Google's publish-to-web dropdown does not offer
// hidden sheets, so over published CSV this fallback is usually what runs.
// It is kept exact rather than approximate for that reason.
//
// A value outside whichever map is in force is never assumed to be spending.
// Counting a mistyped Transfer both inflates spending and invents income, and
// the spec records a misspelling that quietly drained every total for weeks,
// so unrecognised values are excluded and reported instead.
const CATEGORY_TYPE_FALLBACK = new Map([
  ['Food', 'Expense'],
  ['Groceries', 'Expense'],
  ['Gas', 'Expense'],
  ['Transportation', 'Expense'],
  ['Entertainment', 'Expense'],
  ['Service', 'Expense'],
  ['Work', 'Expense'],
  ['School', 'Expense'],
  ['Fees', 'Expense'],
  ['Other', 'Expense'],
  ['Gift', 'Expense'],
  ['Shopping', 'Expense'],
  ['Income', 'Income'],
  ['Transfer', 'Transfer'],
]);

const VALID_TYPES = new Set(['Expense', 'Income', 'Transfer']);

let cache = { at: 0, data: null };

// --- csv ---------------------------------------------------------------------

// Merchant names contain commas and quotes, so this handles quoted fields and
// escaped quotes rather than splitting on commas.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toObjects(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => {
      o[h] = (r[i] || '').trim();
    });
    return o;
  });
}

// The sync script writes 'yyyy-MM-dd' as a string, but Sheets frequently
// coerces that into a date cell, and a date cell exports in locale format.
// Every comparison here is a string compare, so an unhandled 7/26/2026 would
// not throw, it would silently filter to the wrong rows.
function toIsoDate(value) {
  const v = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  // US locale, matching a US bank feed.
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }

  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// parseFloat writes a plain number, but currency or accounting formatting on
// the column would export as $1,234.56 or (14.50). The second is the dangerous
// one: Number('(14.50)') is NaN, which would become zero and understate spend.
function toAmount(value) {
  let v = String(value || '').trim();
  if (!v) return 0;

  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }

  v = v.replace(/[$,\s]/g, '');
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

// Hosting dashboards store environment variables as raw text, so whatever
// decoration the URL picked up on its way here is kept verbatim. Chat clients
// and Markdown editors wrap pasted links in angle brackets, and copying out of
// quoted text keeps the quotes. fetch() then throws a parse error before any
// request is made, which reads as a network problem and sends you looking in
// the wrong place. Strip what cannot legally begin or end a URL instead.
function cleanUrl(raw) {
  return String(raw)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^[<'"]+|[>'"]+$/g, '')
    .trim();
}

// Publishing a sheet is fiddly and every way of getting it wrong returns
// something that looks like success, so each failure is named specifically
// rather than reported as a generic fetch error.
async function fetchCsv(rawUrl, label) {
  const url = cleanUrl(rawUrl);

  try {
    new URL(url);
  } catch {
    throw new Error(
      `the ${label} link is not a usable web address. Check the variable in your hosting dashboard for wrapping quotes, a line break, or a missing https:// at the front.`
    );
  }

  if (/\/edit/.test(url) || /[?&]usp=/.test(url)) {
    throw new Error(
      `the ${label} link is the normal sheet address from the browser bar, not a published one. Use File, then Share, then Publish to web, pick the ${label} tab, and choose comma-separated values.`
    );
  }

  if (!/output=csv/.test(url)) {
    throw new Error(
      `the ${label} link is not a CSV link. When publishing, change the format dropdown from Web page to comma-separated values.`
    );
  }

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(
        `the ${label} sheet did not respond within ${TIMEOUT_MS / 1000} seconds. This is usually temporary, so try again shortly.`
      );
    }
    throw new Error(`could not reach the ${label} sheet: ${err.message}`);
  }

  if (res.status === 404) {
    throw new Error(
      `the ${label} link returned 404, which usually means publishing was stopped or the tab was deleted.`
    );
  }
  if (!res.ok) throw new Error(`the ${label} sheet returned ${res.status}`);

  const text = await res.text();

  // A published web page, a permissions interstitial and a sign-in redirect
  // all arrive as HTML with a 200.
  if (/^\s*</.test(text)) {
    throw new Error(
      `the ${label} link returned a web page instead of CSV. Either it was published as a web page rather than comma-separated values, or the sheet is not actually published and Google is returning a sign-in page.`
    );
  }

  const rows = toObjects(parseCsv(text));
  if (!rows.length) {
    throw new Error(`the ${label} sheet came back empty.`);
  }

  return rows;
}

// --- loading -----------------------------------------------------------------

/**
 * Category -> Type, preferring the Categories tab as the spec requires and
 * falling back to the snapshot when it is not published.
 *
 * A configured tab that fails to load does not throw. Losing the category map
 * entirely would zero every total, which is a far worse outcome than running
 * on a snapshot that is very likely still correct, so the fallback is used and
 * the substitution is reported rather than hidden.
 */
async function categoryTypes() {
  const url = process.env.FINANCE_CATEGORIES_CSV_URL;
  if (!url) return { map: CATEGORY_TYPE_FALLBACK, source: 'built-in', note: null };

  try {
    const rows = await fetchCsv(url, 'Categories');
    if (!rows.length || !('Type' in rows[0])) {
      throw new Error(
        `it has no Type column, its headers are: ${Object.keys(rows[0] || {}).join(', ')}`
      );
    }

    const map = new Map();
    for (const r of rows) {
      const name = (r.Category || '').trim();
      const type = (r.Type || '').trim();
      // A row with a type outside the three is itself a data error, and
      // trusting it would misclassify every transaction using that category.
      if (name && VALID_TYPES.has(type)) map.set(name, type);
    }
    if (!map.size) throw new Error('it produced no usable rows');

    return { map, source: 'Categories tab', note: null };
  } catch (err) {
    return {
      map: CATEGORY_TYPE_FALLBACK,
      source: 'built-in',
      note: `the Categories tab could not be read (${err.message}), so the built-in category list was used instead.`,
    };
  }
}

async function load() {
  const txUrl = process.env.FINANCE_TRANSACTIONS_CSV_URL;
  if (!txUrl) return null;

  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const tx = await fetchCsv(txUrl, 'Transactions');
  const categories = await categoryTypes();

  // A published tab missing these headers means a different tab was published,
  // which would otherwise look like an empty month rather than a mistake.
  if (tx.length && !('Transaction ID' in tx[0])) {
    throw new Error(
      `the Transactions link does not have the expected columns. Its headers are: ${Object.keys(tx[0]).join(', ')}. Check that the Transactions tab was selected when publishing, not a different one.`
    );
  }

  const rows = tx
    .filter((t) => t.Date && t['Transaction ID'])
    .map((t) => {
      const category = (t.Category || '').trim();
      return {
        date: toIsoDate(t.Date),
        account: t.Account || '',
        merchant: (t.Merchant || '').trim(),
        amount: toAmount(t.Amount),
        category,
        status: (t.Status || '').trim(),
        note: (t.Note || '').trim(),
        // '' means not yet reviewed. 'Unknown' means a category with no entry
        // in the map, which is a different problem and is counted separately.
        type: category ? categories.map.get(category) || 'Unknown' : '',
      };
    })
    // A row whose date could not be read is dropped rather than counted into
    // the wrong period.
    .filter((r) => r.date);

  const data = { rows, categories };
  cache = { at: Date.now(), data };
  return data;
}

// --- helpers -----------------------------------------------------------------

const iso = (d) => d.toISOString().slice(0, 10);

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

const between = (rows, from, to) =>
  rows.filter((r) => r.date >= from && r.date < to);

// Spending is the negated sum, so a positive reimbursement inside an expense
// category nets against it exactly as the handoff describes.
const spend = (rows) =>
  -rows.filter((r) => r.type === 'Expense').reduce((a, r) => a + r.amount, 0);

const income = (rows) =>
  rows.filter((r) => r.type === 'Income').reduce((a, r) => a + r.amount, 0);

function byCategory(rows) {
  const out = {};
  for (const r of rows) {
    if (r.type !== 'Expense') continue;
    out[r.category] = (out[r.category] || 0) - r.amount;
  }
  return out;
}

function byMerchant(rows) {
  const out = {};
  for (const r of rows) {
    if (r.type !== 'Expense' || !r.merchant) continue;
    out[r.merchant] = (out[r.merchant] || 0) - r.amount;
  }
  return out;
}

const top = (obj, n) =>
  Object.entries(obj)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

// Charges from the same merchant, similar in size, roughly a month apart.
// With only 30 to 90 days of history two occurrences is all that can be asked
// for, so this is labelled "likely" rather than asserted.
function likelyRecurring(rows) {
  const byName = {};
  for (const r of rows) {
    if (r.type !== 'Expense' || !r.merchant || r.amount >= 0) continue;
    (byName[r.merchant] = byName[r.merchant] || []).push(r);
  }

  const found = [];
  for (const [merchant, list] of Object.entries(byName)) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));

    const amounts = list.map((r) => Math.abs(r.amount));
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const consistent = amounts.every((a) => Math.abs(a - avg) <= avg * 0.15);
    if (!consistent) continue;

    let monthly = false;
    for (let i = 1; i < list.length; i++) {
      const gap =
        (new Date(list[i].date) - new Date(list[i - 1].date)) / 86400000;
      if (gap >= 25 && gap <= 35) monthly = true;
    }
    if (monthly) found.push({ merchant, amount: avg, seen: list.length });
  }

  return found.sort((a, b) => b.amount - a.amount);
}

// --- the brief ---------------------------------------------------------------

/**
 * Everything the coach needs, already counted. Returns null when the sheet is
 * not configured, so the caller can stay silent rather than guess.
 */
async function brief() {
  let loaded;
  try {
    loaded = await load();
  } catch (err) {
    return { error: err.message };
  }
  if (!loaded) return null;

  const { rows, categories } = loaded;
  if (!rows.length) return { empty: true };

  const now = iso(new Date());
  const d7 = daysAgo(7);
  const d14 = daysAgo(14);
  const d30 = daysAgo(30);
  const d90 = daysAgo(90);

  const week = between(rows, d7, now);
  const prevWeek = between(rows, d14, d7);
  const month = between(rows, d30, now);
  const quarter = between(rows, d90, now);

  const monthSpend = spend(month);
  const monthIncome = income(month);

  // Both of these are excluded from every total above, so their weight decides
  // how much the rest can be trusted. They are separated because they call for
  // different actions: a blank category needs reviewing in the sheet, while an
  // unrecognised one means this code and the sheet disagree about the 12.
  const outflow = (list) =>
    -list.filter((r) => r.amount < 0).reduce((a, r) => a + r.amount, 0);

  const unreviewed = month.filter((r) => !r.category);
  const unreviewedTotal = outflow(unreviewed);

  const unknown = month.filter((r) => r.type === 'Unknown');
  const unknownNames = [...new Set(unknown.map((r) => r.category))].sort();

  const thisCats = byCategory(week);
  const lastCats = byCategory(prevWeek);
  const moved = Object.keys({ ...thisCats, ...lastCats })
    .map((c) => ({
      category: c,
      now: thisCats[c] || 0,
      before: lastCats[c] || 0,
      change: (thisCats[c] || 0) - (lastCats[c] || 0),
    }))
    .filter((c) => Math.abs(c.change) >= 25)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const biggest = week
    .filter((r) => r.type === 'Expense' && r.amount < 0)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 5)
    .map((r) => ({
      merchant: r.merchant,
      amount: Math.abs(r.amount),
      date: r.date,
      category: r.category,
      note: r.note,
    }));

  // The earliest date present, not the first row. Row order follows whatever
  // the sheet is sorted by, so reading the span off quarter[0] would divide by
  // the wrong number of days the moment the sheet is sorted newest-first.
  const earliest = quarter.reduce((a, r) => (r.date < a ? r.date : a), now);
  const days = Math.max(
    1,
    Math.round((new Date(now) - new Date(earliest)) / 86400000)
  );

  // Reported as dates so the reader can judge them. The gap at the recent end
  // looks the same whether the feed broke or nothing was bought, and the gap
  // at the far end is a hard retention limit: the provider supplies about 30
  // days and nothing older exists anywhere, so any request for a longer trend
  // has to be answered against this range rather than assumed.
  const latest = rows.reduce((a, r) => (r.date > a ? r.date : a), '');
  const oldest = rows.reduce((a, r) => (r.date < a ? r.date : a), latest);

  // Status is derived from Category, so the two disagreeing means something
  // upstream is wrong. The spec asks for it to be reported rather than fixed.
  const inconsistent = rows.filter(
    (r) =>
      (r.status === 'Needs Review' && r.category) ||
      (r.status !== 'Needs Review' && r.status && !r.category)
  ).length;

  return {
    sync: {
      latest_transaction: latest || null,
      earliest_transaction: oldest || null,
      days_of_history: oldest
        ? Math.round((new Date(latest) - new Date(oldest)) / 86400000) + 1
        : 0,
    },
    categories: {
      source: categories.source,
      note: categories.note,
      count: categories.map.size,
    },
    window: { from: d30, to: now },
    week: { spend: spend(week), income: income(week) },
    prev_week: { spend: spend(prevWeek), income: income(prevWeek) },
    month: {
      spend: monthSpend,
      income: monthIncome,
      net: monthIncome - monthSpend,
      savings_rate:
        monthIncome > 0
          ? Math.round(((monthIncome - monthSpend) / monthIncome) * 100)
          : null,
    },
    daily_average: spend(quarter) / days,
    daily_average_days: days,
    categories_month: top(byCategory(month), 8),
    // Categories where more came back than went out, which the spec requires
    // be reported rather than dropped for looking odd. It happens when a
    // refund lands inside the window but the charge it offsets does not.
    categories_net_positive: Object.entries(byCategory(month))
      .filter(([, v]) => v < 0)
      .map(([c, v]) => [c, -v])
      .sort((a, b) => b[1] - a[1]),
    merchants_month: top(byMerchant(month), 8),
    week_changes: moved.slice(0, 6),
    biggest_this_week: biggest,
    recurring: likelyRecurring(quarter).slice(0, 10),
    data_quality: {
      unreviewed_rows: unreviewed.length,
      unreviewed_spend: unreviewedTotal,
      unknown_categories: unknownNames,
      unknown_rows: unknown.length,
      unknown_spend: outflow(unknown),
      reviewed: month.filter((r) => r.status === 'Reviewed').length,
      auto: month.filter((r) => r.status === 'Auto').length,
      total_rows_30d: month.length,
      status_mismatches: inconsistent,
    },
  };
}

// Rendered as text rather than JSON: it costs fewer tokens and reads as a
// briefing, which is what the model is being asked to respond to.
function render(b) {
  const m = (n) => `$${Math.abs(n).toFixed(2)}`;
  const L = [];

  L.push(`Window: last 30 days, ending ${b.window.to}`);
  // Stated as plain facts, not warnings. A gap at the recent end reads as a
  // broken feed but is just as often a quiet week. The far end is a hard
  // limit: nothing older than this exists anywhere, so it bounds what can
  // honestly be said about trends.
  L.push(
    `Data available: ${b.sync.earliest_transaction || 'none'} to ${b.sync.latest_transaction || 'none'} (${b.sync.days_of_history} days). Nothing older is recoverable.`
  );
  L.push('');
  L.push(`Last 7 days:      spent ${m(b.week.spend)}, income ${m(b.week.income)}`);
  L.push(`Previous 7 days:  spent ${m(b.prev_week.spend)}, income ${m(b.prev_week.income)}`);
  L.push('');
  L.push(`Last 30 days:     spent ${m(b.month.spend)}, income ${m(b.month.income)}`);
  L.push(`Net:              ${b.month.net >= 0 ? '+' : '-'}${m(b.month.net)}`);
  if (b.month.savings_rate !== null) {
    L.push(`Savings rate:     ${b.month.savings_rate}% of income kept`);
  }
  // Named for the span that actually exists. Calling this a 90-day average
  // when only a few weeks are in the sheet invites exactly the long-range
  // conclusion the data cannot support.
  L.push(
    `Daily average:    ${m(b.daily_average)} per day, across the ${b.daily_average_days} days since the first transaction`
  );

  if (b.week_changes.length) {
    L.push('');
    L.push('Category shifts, this week against last:');
    for (const c of b.week_changes) {
      const dir = c.change > 0 ? 'up' : 'down';
      L.push(`  ${c.category || '(uncategorised)'}: ${dir} ${m(c.change)} (${m(c.before)} to ${m(c.now)})`);
    }
  }

  L.push('');
  L.push('Biggest categories, 30 days:');
  for (const [cat, amt] of b.categories_month) L.push(`  ${cat}: ${m(amt)}`);

  if (b.categories_net_positive.length) {
    L.push('');
    L.push('Categories where money came back, 30 days:');
    for (const [cat, amt] of b.categories_net_positive) {
      L.push(
        `  ${cat}: +${m(amt)} net, a refund landed in this window while the charge it offsets did not`
      );
    }
  }

  L.push('');
  L.push('Biggest merchants, 30 days:');
  for (const [mer, amt] of b.merchants_month) L.push(`  ${mer}: ${m(amt)}`);

  if (b.biggest_this_week.length) {
    L.push('');
    L.push('Largest single charges this week:');
    for (const t of b.biggest_this_week) {
      L.push(`  ${t.date} ${t.merchant} ${m(t.amount)} [${t.category}]${t.note ? ` note: ${t.note}` : ''}`);
    }
  }

  if (b.recurring.length) {
    L.push('');
    L.push('Likely recurring charges:');
    let total = 0;
    for (const r of b.recurring) {
      total += r.amount;
      L.push(`  ${r.merchant}: about ${m(r.amount)} a month (${r.seen} seen)`);
    }
    L.push(`  These come to roughly ${m(total)} a month.`);
  }

  const q = b.data_quality;
  L.push('');
  L.push(
    `Data quality: ${q.total_rows_30d} rows in 30 days, ${q.reviewed} human-reviewed, ${q.auto} auto-categorised, ${q.unreviewed_rows} still uncategorised${
      q.unreviewed_spend > 0 ? ` covering ${m(q.unreviewed_spend)} of spending not counted above` : ''
    }.`
  );

  // Categories outside the 12 are a disagreement between this code and the
  // sheet, not a gap in the user's reviewing, so it is stated separately.
  if (q.unknown_rows) {
    L.push(
      `${q.unknown_rows} ${q.unknown_rows === 1 ? 'row uses' : 'rows use'} a category this system does not recognise (${q.unknown_categories.join(', ')}), ` +
        `covering ${m(q.unknown_spend)} left out of every total above.`
    );
  }

  if (q.status_mismatches) {
    L.push(
      `${q.status_mismatches} ${q.status_mismatches === 1 ? 'row has' : 'rows have'} a Status that disagrees with whether the Category is filled in, which should not happen.`
    );
  }

  // Only surfaced when a configured source failed. A silent fall back to the
  // snapshot would be indistinguishable from it having worked.
  if (b.categories.note) L.push(b.categories.note);

  // Stated without a conclusion attached. Zero income means a payroll account
  // is not connected about as often as it means nothing was earned, and only
  // the reader knows which.
  if (b.month.income < 1) {
    L.push(
      `No income is recorded in this window. If that is unexpected, an account may not be connected.`
    );
  }

  return L.join('\n');
}

// cleanUrl is exported so /finance-status reports on the same string the
// fetch actually uses, rather than a second copy of the rules that can drift.
module.exports = { brief, render, cleanUrl };
