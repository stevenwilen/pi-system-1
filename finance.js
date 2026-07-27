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

// Hosting dashboards store environment variables as raw text, so a value
// pasted with wrapping quotes or a stray line break arrives with them still
// attached. fetch() then throws "Failed to parse URL" before any request is
// made, which reads as a network problem and sends you looking in the wrong
// place. Strip the characters that cannot legally appear in a URL instead.
function cleanUrl(raw) {
  return String(raw)
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\s+/g, '')
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

async function load() {
  const txUrl = process.env.FINANCE_TRANSACTIONS_CSV_URL;
  const catUrl = process.env.FINANCE_CATEGORIES_CSV_URL;
  if (!txUrl || !catUrl) return null;

  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  // Fetched separately so the error can say which of the two is wrong.
  const tx = await fetchCsv(txUrl, 'Transactions');
  const cats = await fetchCsv(catUrl, 'Categories');

  // A published Transactions tab that is missing its headers means the wrong
  // tab was published, which would otherwise look like an empty month.
  if (tx.length && !('Transaction ID' in tx[0])) {
    throw new Error(
      `the Transactions link does not have the expected columns. Its headers are: ${Object.keys(tx[0]).join(', ')}. Check that the Transactions tab was selected when publishing, not a different one.`
    );
  }
  if (cats.length && !('Type' in cats[0])) {
    throw new Error(
      `the Categories link does not have a Type column. Its headers are: ${Object.keys(cats[0]).join(', ')}. Check that the Categories tab was selected when publishing.`
    );
  }

  // Category -> Expense | Income | Transfer. This join is what makes the
  // database self-describing, and without it none of the sums are meaningful.
  const typeOf = new Map();
  for (const c of cats) {
    if (c.Category) typeOf.set(c.Category.trim(), (c.Type || '').trim());
  }

  const rows = tx
    .filter((t) => t.Date && t['Transaction ID'])
    .map((t) => ({
      date: toIsoDate(t.Date),
      account: t.Account || '',
      merchant: (t.Merchant || '').trim(),
      amount: toAmount(t.Amount),
      category: (t.Category || '').trim(),
      status: (t.Status || '').trim(),
      note: (t.Note || '').trim(),
      type: typeOf.get((t.Category || '').trim()) || '',
    }))
    // A row whose date could not be read is dropped rather than counted into
    // the wrong period.
    .filter((r) => r.date);

  cache = { at: Date.now(), data: rows };
  return rows;
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
  let rows;
  try {
    rows = await load();
  } catch (err) {
    return { error: err.message };
  }
  if (!rows) return null;
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

  // Uncategorised rows are excluded from every total above, so their weight
  // decides how much the rest can be trusted.
  const unreviewed = month.filter((r) => !r.category || !r.type);
  const unreviewedTotal = -unreviewed
    .filter((r) => r.amount < 0)
    .reduce((a, r) => a + r.amount, 0);

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

  const days = Math.max(
    1,
    Math.round((new Date(now) - new Date(quarter[0] ? quarter[0].date : d90)) / 86400000)
  );

  // The sync logs SimpleFIN connection errors and carries on, so a bank that
  // needs re-authenticating shows up as nothing at all rather than a failure.
  // The only visible symptom is transactions stopping, which is worth naming.
  const latest = rows.reduce((a, r) => (r.date > a ? r.date : a), '');
  const staleDays = latest
    ? Math.round((new Date(now) - new Date(latest)) / 86400000)
    : null;

  return {
    sync: {
      latest_transaction: latest || null,
      days_since: staleDays,
      // Chase posts most days; three clear days means something is wrong.
      looks_stalled: staleDays !== null && staleDays >= 3,
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
    daily_average_90d: spend(quarter) / days,
    categories_month: top(byCategory(month), 8),
    merchants_month: top(byMerchant(month), 8),
    week_changes: moved.slice(0, 6),
    biggest_this_week: biggest,
    recurring: likelyRecurring(quarter).slice(0, 10),
    data_quality: {
      unreviewed_rows: unreviewed.length,
      unreviewed_spend: unreviewedTotal,
      reviewed: month.filter((r) => r.status === 'Reviewed').length,
      auto: month.filter((r) => r.status === 'Auto').length,
      total_rows_30d: month.length,
    },
  };
}

// Rendered as text rather than JSON: it costs fewer tokens and reads as a
// briefing, which is what the model is being asked to respond to.
function render(b) {
  const m = (n) => `$${Math.abs(n).toFixed(2)}`;
  const L = [];

  L.push(`Window: last 30 days, ending ${b.window.to}`);
  L.push('');
  L.push(`Last 7 days:      spent ${m(b.week.spend)}, income ${m(b.week.income)}`);
  L.push(`Previous 7 days:  spent ${m(b.prev_week.spend)}, income ${m(b.prev_week.income)}`);
  L.push('');
  L.push(`Last 30 days:     spent ${m(b.month.spend)}, income ${m(b.month.income)}`);
  L.push(`Net:              ${b.month.net >= 0 ? '+' : '-'}${m(b.month.net)}`);
  if (b.month.savings_rate !== null) {
    L.push(`Savings rate:     ${b.month.savings_rate}% of income kept`);
  }
  L.push(`90-day average:   ${m(b.daily_average_90d)} per day`);

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

  if (b.sync.looks_stalled) {
    L.push('');
    L.push(
      `SYNC WARNING: the most recent transaction is ${b.sync.days_since} days old (${b.sync.latest_transaction}). ` +
        `The bank feed has probably stopped, which usually means an institution needs re-authenticating in SimpleFIN. ` +
        `Everything above is therefore incomplete.`
    );
  }

  const q = b.data_quality;
  L.push('');
  L.push(
    `Data quality: ${q.total_rows_30d} rows in 30 days, ${q.reviewed} human-reviewed, ${q.auto} auto-categorised, ${q.unreviewed_rows} still uncategorised${
      q.unreviewed_spend > 0 ? ` covering ${m(q.unreviewed_spend)} of spending not counted above` : ''
    }.`
  );

  return L.join('\n');
}

module.exports = { brief, render };
