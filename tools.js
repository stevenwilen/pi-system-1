// The four tools. No AI in this file.
//
// user_id is always the FIRST argument and is always supplied by the caller.
// It is never part of `fields` and never chosen by the model.

require('dotenv').config();

const ical = require('node-ical');

const supabase = require('./db');

// Fields the caller may set. Anything else is dropped, so user_id, id,
// created_at and updated_at can never be overwritten from outside.
// `priority` is deliberately absent. The list position replaced it, the column
// is retired, and leaving it off the whitelist means nothing can write it back
// by accident. `sort_order`, `cold` and `cold_reason` are absent for a
// different reason: the first is the person's own ordering and the other two
// are a daily verdict, and neither is a field a caller sets in passing.
//
// `due` is here because the person sets it. It is a date the caller supplies or
// clears, never something inferred: nothing in this system decides on someone's
// behalf when a thing is due, in the same way nothing decides that a gap was
// deliberate.
const CREATABLE = ['type', 'title', 'body', 'why', 'frequency', 'due'];

const UPDATABLE = [...CREATABLE, 'status'];

function pick(fields, allowed) {
  const out = {};
  for (const key of allowed) {
    if (fields && fields[key] !== undefined) out[key] = fields[key];
  }
  return out;
}

// PostgREST `or()` takes a comma-separated filter string, so strip the
// characters that would let a search term break out of it.
function escapeForOr(text) {
  return String(text).replace(/[,()\\%]/g, ' ').trim();
}

/**
 * Read active entries for one user.
 * Never returns rows with status = 'deleted'.
 */
async function search_entries(user_id, query, type, limit = 50) {
  if (!user_id) return { error: 'user_id is required' };

  let q = supabase
    .from('entries')
    .select('*')
    .eq('user_id', user_id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (type) q = q.eq('type', type);

  if (query) {
    const term = escapeForOr(query);
    if (term) q = q.or(`title.ilike.%${term}%,body.ilike.%${term}%`);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };
  return data;
}

// --- profile ----------------------------------------------------------------

const PROFILE_UPDATABLE = ['timezone', 'default_wake_time'];

/**
 * Change when the day plan arrives, or which timezone it follows.
 *
 * Both values are validated here rather than trusted. A malformed time or an
 * unknown timezone would not fail loudly: the scheduler would throw while
 * working out the local hour, skip this user, and silently stop sending them
 * anything at all.
 */
async function update_profile(user_id, fields) {
  if (!user_id) return { error: 'user_id is required' };

  const patch = pick(fields, PROFILE_UPDATABLE);
  if (Object.keys(patch).length === 0) return { error: 'no fields to update' };

  if (
    patch.default_wake_time &&
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.default_wake_time)
  ) {
    return {
      error: `not a valid time: ${patch.default_wake_time}. Use HH:MM on a 24 hour clock.`,
    };
  }

  if (patch.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: patch.timezone });
    } catch {
      return {
        error: `not a valid timezone: ${patch.timezone}. Use an IANA name such as America/New_York.`,
      };
    }
  }

  const { data, error } = await supabase
    .from('profile')
    .update(patch)
    .eq('user_id', user_id)
    .select('timezone, default_wake_time')
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: 'no profile for this user' };
  return data;
}

// --- calendar ---------------------------------------------------------------

// The ICS feed is refetched at most this often. One brain turn can call
// get_calendar several times; without this each call re-downloads the file.
const CALENDAR_TTL_MS = 60 * 1000;
const CALENDAR_TIMEOUT_MS = 10000;

let calendarCache = { at: 0, parsed: null };

async function loadCalendar() {
  const url = process.env.CALENDAR_ICS_URL;
  if (!url) return null;

  if (calendarCache.parsed && Date.now() - calendarCache.at < CALENDAR_TTL_MS) {
    return calendarCache.parsed;
  }

  // Our own fetch rather than ical.async.fromURL, so a hung feed cannot
  // stall a scheduled job forever.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`calendar returned ${res.status}`);

  const parsed = await ical.async.parseICS(await res.text());
  calendarCache = { at: Date.now(), parsed };
  return parsed;
}

// Milliseconds between UTC and `timeZone` at a given instant.
function offsetAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(instant)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instant.getTime();
}

// The UTC instant at which `date` begins in `timeZone`.
function startOfDay(date, timeZone) {
  const naive = new Date(`${date}T00:00:00Z`);
  return new Date(naive.getTime() - offsetAt(naive, timeZone));
}

function nextDay(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function timezoneFor(user_id) {
  const { data } = await supabase
    .from('profile')
    .select('timezone')
    .eq('user_id', user_id)
    .maybeSingle();

  return (data && data.timezone) || 'UTC';
}

function event(title, start, end) {
  return {
    title: title || '(untitled)',
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

/**
 * Calendar events for one day, in the user's own timezone.
 * Any failure returns [] — a calendar that cannot be read must never stop
 * day planning.
 */
async function get_calendar(user_id, date) {
  if (!user_id) return { error: 'user_id is required' };
  if (!date) return [];

  try {
    const parsed = await loadCalendar();
    if (!parsed) return [];

    const timeZone = await timezoneFor(user_id);
    const dayStart = startOfDay(date, timeZone);
    const dayEnd = startOfDay(nextDay(date), timeZone);

    const out = [];

    for (const key of Object.keys(parsed)) {
      const ev = parsed[key];
      if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;

      const duration = ev.end ? ev.end.getTime() - ev.start.getTime() : 0;

      if (!ev.rrule) {
        const end = ev.end || new Date(ev.start.getTime() + duration);
        if (ev.start < dayEnd && end > dayStart) {
          out.push(event(ev.summary, ev.start, end));
        }
        continue;
      }

      // Recurring. Look back one duration so an occurrence that began
      // yesterday and runs into today is still caught.
      const from = new Date(dayStart.getTime() - Math.max(duration, 0) - 1);

      for (const occurrence of ev.rrule.between(from, dayEnd, true)) {
        const dayId = occurrence.toISOString().slice(0, 10);
        const isoId = occurrence.toISOString();

        // This occurrence was deleted from the series.
        if (ev.exdate && (ev.exdate[dayId] || ev.exdate[isoId])) continue;

        // This occurrence was edited — moved, renamed, or both.
        const override =
          ev.recurrences && (ev.recurrences[dayId] || ev.recurrences[isoId]);

        const start = override ? override.start : occurrence;
        const end = override
          ? override.end
          : new Date(occurrence.getTime() + duration);

        if (start < dayEnd && end > dayStart) {
          out.push(event(override ? override.summary : ev.summary, start, end));
        }
      }
    }

    out.sort((a, b) => a.start.localeCompare(b.start));
    return out;
  } catch {
    return [];
  }
}

/**
 * Insert one entry. user_id is forced from the argument.
 */
async function create_entry(user_id, fields) {
  if (!user_id) return { error: 'user_id is required' };

  const row = { ...pick(fields, CREATABLE), user_id };

  if (!row.type) return { error: 'type is required' };
  if (!row.title) return { error: 'title is required' };

  const { data, error } = await supabase
    .from('entries')
    .insert(row)
    .select()
    .single();

  if (error) return { error: describe(error) };
  return data;
}

// No unique index applies to entries any more: the project ranking went with
// priority itself. A 23505 here would be something unforeseen, so the raw
// message is more useful than a guess at which rule was broken.
function describe(error) {
  return error.message;
}

/**
 * Update one entry, but only if it belongs to this user.
 * Soft-delete is update_entry(user_id, id, { status: 'deleted' }).
 */
async function update_entry(user_id, id, fields) {
  if (!user_id) return { error: 'user_id is required' };
  if (!id) return { error: 'id is required' };

  const patch = pick(fields, UPDATABLE);
  if (Object.keys(patch).length === 0) return { error: 'no fields to update' };

  // updated_at is set by a database trigger, not from here — the client
  // clock and the database clock do not agree.

  let q = supabase
    .from('entries')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user_id);

  // A deleted entry is a tombstone: it can never be brought back.
  if (patch.status === 'active') q = q.neq('status', 'deleted');

  const { data, error } = await q.select().maybeSingle();

  if (error) return { error: describe(error) };
  if (!data) return { error: 'entry not found for this user' };
  return data;
}

module.exports = {
  search_entries,
  get_calendar,
  create_entry,
  update_entry,
  update_profile,
  timezoneFor,
};
