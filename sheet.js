// Reading the transaction sheet.
//
// This module has no database import and never will. Transactions are not
// stored: they are read inside a bounded window, handed to the caller, and
// dropped when the caller is done with them. Nothing here writes anywhere.
//
// One export: readTransactions(days).

require('dotenv').config();

const TIMEOUT_MS = 15000;
const DEFAULT_DAYS = 60;

// A hard ceiling on the window, separate from the default. The point of the
// bound is that no caller can ask for everything, so the ceiling has to sit
// where a caller cannot move it.
const MAX_DAYS = 120;

// --- the url ----------------------------------------------------------------

// Hosting dashboards store environment variables as raw text, so whatever
// decoration the URL picked up on the way in is kept verbatim. This one was
// pasted wrapped in angle brackets once already, and fetch() throws a parse
// error before any request is made, which reads as a network fault and sends
// you looking in entirely the wrong place.
function cleanUrl(raw) {
  return String(raw)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^[<'"]+|[>'"]+$/g, '')
    .trim();
}

// --- parsing ----------------------------------------------------------------

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

// The sync writes yyyy-MM-dd as a string, but Sheets frequently coerces that
// into a date cell and a date cell exports in locale format. Every comparison
// downstream is a string compare, so an unhandled 7/26/2026 would not throw,
// it would silently fall outside the window.
function toIsoDate(value) {
  const v = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;

  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// parseFloat handles a plain number, but currency or accounting formatting on
// the column exports as $1,234.56 or (14.50). The second is the dangerous one:
// Number('(14.50)') is NaN, which would become zero and quietly understate.
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

// --- reading ----------------------------------------------------------------

const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/**
 * Transactions from the last `days` days.
 *
 * Returns [] on any failure and never throws. A finance lane that cannot read
 * the sheet has nothing to say, and that is a quiet outcome rather than one
 * that takes a request down with it. Every failure is logged loudly, because
 * an empty array is otherwise indistinguishable from a genuinely quiet month.
 *
 * Note on the bound: a published CSV cannot be range-requested, so the whole
 * sheet arrives over the wire. The window governs what leaves this function,
 * which is what matters, since nothing beyond it is ever seen or stored.
 */
async function readTransactions(days = DEFAULT_DAYS) {
  const window = Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, MAX_DAYS));

  const raw = process.env.FINANCE_TRANSACTIONS_CSV_URL;
  if (!raw) {
    console.error('[SHEET] FINANCE_TRANSACTIONS_CSV_URL is not set. Returning nothing.');
    return [];
  }

  const url = cleanUrl(raw);

  try {
    new URL(url);
  } catch {
    console.error(
      '[SHEET] FINANCE_TRANSACTIONS_CSV_URL is not a usable web address. Check it for wrapping quotes, a line break, or a missing https:// at the front. Returning nothing.'
    );
    return [];
  }

  if (!/output=csv/.test(url)) {
    console.error(
      '[SHEET] the link is not a CSV link. Republish the Transactions tab choosing comma-separated values. Returning nothing.'
    );
    return [];
  }

  let text;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

    if (res.status === 404) {
      console.error('[SHEET] the link returned 404. Publishing was probably stopped, or the tab was deleted. Returning nothing.');
      return [];
    }
    if (!res.ok) {
      console.error(`[SHEET] the sheet returned ${res.status}. Returning nothing.`);
      return [];
    }

    text = await res.text();
  } catch (err) {
    const timedOut = err && err.name === 'TimeoutError';
    console.error(
      timedOut
        ? `[SHEET] the sheet did not respond within ${TIMEOUT_MS / 1000} seconds. Returning nothing.`
        : `[SHEET] could not reach the sheet: ${err.message}. Returning nothing.`
    );
    return [];
  }

  // A published web page, a permissions interstitial and a sign-in redirect all
  // arrive as HTML with a 200.
  if (/^\s*</.test(text)) {
    console.error(
      '[SHEET] the link returned a web page instead of CSV. Either it was published as a web page rather than comma-separated values, or it is not published at all and Google is returning a sign-in page. Returning nothing.'
    );
    return [];
  }

  let rows;
  try {
    rows = toObjects(parseCsv(text));
  } catch (err) {
    console.error(`[SHEET] could not parse the CSV: ${err.message}. Returning nothing.`);
    return [];
  }

  if (!rows.length) {
    console.error('[SHEET] the sheet came back empty. Returning nothing.');
    return [];
  }

  // A tab missing these headers means a different tab was published, which
  // would otherwise look like a quiet month rather than a mistake.
  for (const column of ['Date', 'Amount', 'Category']) {
    if (!(column in rows[0])) {
      console.error(
        `[SHEET] the published tab has no ${column} column. Its headers are: ${Object.keys(rows[0]).join(', ')}. Check that the Transactions tab was selected when publishing. Returning nothing.`
      );
      return [];
    }
  }

  const since = daysAgo(window);

  return rows
    .map((r) => ({
      date: toIsoDate(r.Date),
      // Merchant is the cleaned, readable name and Description is the raw bank
      // text. The readable one is what a person recognises, so it leads, with
      // the raw text as a fallback for rows the cleaner left blank.
      description: (r.Merchant || r.Description || '').trim(),
      amount: toAmount(r.Amount),
      // Blank means not yet reviewed. It is passed through as an empty string
      // rather than guessed at, so the caller can report the gap.
      category: (r.Category || '').trim(),
    }))
    // A row whose date cannot be read is dropped rather than counted into the
    // wrong period.
    .filter((t) => t.date && t.date >= since)
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { readTransactions };
