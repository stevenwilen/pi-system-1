// The four tools. No AI in this file.
//
// The database client is the FIRST argument and user_id the second, both
// always supplied by the caller. Neither is ever part of `fields` and neither
// is ever chosen by the model.
//
// The client is passed rather than imported so that a route asks with the
// caller's own connection, subject to row level security, while the scheduler
// asks with the service key. One module, two callers, and no way to be the
// wrong one by accident, because there is no client in here to reach for.

require('dotenv').config();

const ical = require('node-ical');

// Fields the caller may set. Anything else is dropped, so user_id, id,
// created_at and updated_at can never be overwritten from outside.
//
// The absences are the interesting part, and they are all the same absence:
// every one of these columns is still in the schema, still holding whatever it
// last held, and read by nothing. `priority` and `sort_order` were ways of
// ordering this list by hand. `cold` and `cold_reason` were a daily verdict
// written by a model call. `paused_at` was a declared intent. `why` was a
// project's stated reason and `body` was a note about where it stood. Leaving
// them off this list is what stops anything writing to a column nothing reads.
//
// `due` and `size` are here because the person sets them. They are the two
// halves of the warning mark, and both are supplied or cleared by hand: nothing
// in this system decides on someone's behalf when a thing is due or how big it
// is.
const CREATABLE = ['type', 'title', 'frequency', 'due', 'size'];

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
async function search_entries(db, user_id, query, type, limit = 50) {
  if (!user_id) return { error: 'user_id is required' };

  let q = db
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
async function update_profile(db, user_id, fields) {
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

  const { data, error } = await db
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
//
// Two feeds, and which one an event is on is the whole signal.
//
//   awareness  profile.calendar_ics_url         things to KNOW
//   action     profile.calendar_action_ics_url  things to DO
//
// Nothing is filtered by TRANSP, by calendar name, or by anything written
// inside the event. The person sorts their own life by putting a thing on one
// calendar or the other, and this reads that decision rather than second
// guessing it.
//
// ON THE ROW, NOT IN THE ENVIRONMENT. These were CALENDAR_ICS_URL and
// CALENDAR_ACTION_ICS_URL, which is the same assumption PI_USER_ID was: fine
// while there was one person, and unable to express two. A feed URL is a fact
// about a person.
//
// Both are optional. No awareness URL and no action URL is an ordinary account
// with an empty calendar, not a broken one.

const FEEDS = [
  { source: 'awareness', column: 'calendar_ics_url', label: 'Dates' },
  { source: 'action', column: 'calendar_action_ics_url', label: 'Personal' },
];

// Each feed is refetched at most this often. One brain turn can call
// get_calendar several times; without this each call re-downloads the file.
const CALENDAR_TTL_MS = 60 * 1000;
const CALENDAR_TIMEOUT_MS = 10000;

/**
 * Parsed feeds, by user and url.
 *
 * THE URL IS WHAT MAKES THIS SAFE. Two people with different feeds have
 * different urls and therefore different slots, and the entry holds the raw
 * parsed file rather than anything filtered per person — so keying on the url
 * alone would already be leak-free.
 *
 * user_id is in the key anyway, and it is worth being clear that it is NOT
 * load-bearing: nothing about isolation depends on it, and anyone reading this
 * later should not treat it as the thing standing between two accounts. It is
 * a second belt over a fastened one, cheap at this scale, and what it actually
 * buys is that the invariant survives a future edit that gets the key wrong.
 *
 * What WOULD leak is keying on `source` — 'awareness' / 'action' — which is
 * the tempting mistake now that the url is a variable and the source is the
 * constant. tests/calendar-feeds-test.js has a case that goes red if anyone
 * makes it.
 */
const calendarCache = new Map();

// A space separates them, unambiguously: a uuid contains none, and a url
// percent-encodes any it has.
const cacheKey = (user_id, url) => `${user_id} ${url}`;

/**
 * One feed, parsed. Throws when the feed is unreachable — the caller decides
 * what a failure costs.
 */
async function loadFeed(user_id, url) {
  const key = cacheKey(user_id, url);
  const hit = calendarCache.get(key);
  if (hit && Date.now() - hit.at < CALENDAR_TTL_MS) return hit.parsed;

  // Our own fetch rather than ical.async.fromURL, so a hung feed cannot
  // stall a scheduled job forever.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`returned ${res.status}`);

  const parsed = await ical.async.parseICS(await res.text());
  calendarCache.set(key, { at: Date.now(), parsed });
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

async function timezoneFor(db, user_id) {
  const { data } = await db
    .from('profile')
    .select('timezone')
    .eq('user_id', user_id)
    .maybeSingle();

  return (data && data.timezone) || 'UTC';
}

/**
 * The timezone and both feed urls, in one read.
 *
 * One query rather than a timezone read and then a url read. They come off the
 * same row and reading it twice is two chances for a caller to be served a
 * timezone from one moment and a url from another.
 *
 * A missing profile row is not an error. It reads as UTC with no feeds, which
 * is exactly what an account that has set nothing up should get.
 */
async function calendarSettings(db, user_id) {
  const { data } = await db
    .from('profile')
    .select('timezone, calendar_ics_url, calendar_action_ics_url')
    .eq('user_id', user_id)
    .maybeSingle();

  return {
    timeZone: (data && data.timezone) || 'UTC',
    urls: {
      calendar_ics_url: (data && data.calendar_ics_url) || null,
      calendar_action_ics_url: (data && data.calendar_action_ics_url) || null,
    },
  };
}

function event(id, title, start, end, source) {
  return {
    // Stable across reads of the same feed, so a placement can be remembered
    // without storing the event itself. A recurring series repeats its uid on
    // every occurrence, so the occurrence start is part of the identity.
    id,
    title: title || '(untitled)',
    start: start.toISOString(),
    end: end.toISOString(),
    // 'awareness' or 'action'. Which feed it came from is the only thing that
    // decides whether it is a fact to know or a thing to do.
    source,
  };
}

/** Whole-day by the calendar's own reckoning: starts at midnight, runs 24h. */
function isAllDay(startMs, endMs, date, timeZone) {
  const dayStart = startOfDay(date, timeZone).getTime();
  return startMs <= dayStart && endMs - startMs >= 24 * 60 * 60 * 1000 - 1;
}

/** Every event on one date from one parsed feed. */
function eventsOn(parsed, source, date, timeZone) {
  const dayStart = startOfDay(date, timeZone);
  const dayEnd = startOfDay(nextDay(date), timeZone);
  const out = [];

  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;

    const uid = ev.uid || key;
    const duration = ev.end ? ev.end.getTime() - ev.start.getTime() : 0;

    if (!ev.rrule) {
      const end = ev.end || new Date(ev.start.getTime() + duration);
      if (ev.start < dayEnd && end > dayStart) {
        out.push(event(uid, ev.summary, ev.start, end, source));
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
        out.push(
          event(`${uid}:${isoId}`, override ? override.summary : ev.summary, start, end, source)
        );
      }
    }
  }

  return out;
}

/**
 * Everything on one date, across both feeds, with the failures named.
 *
 * A feed that cannot be read costs its own events and nothing else: the other
 * feed still reports, and the day is still planned. But the failure is
 * returned rather than swallowed, because [] from a dead feed and [] from a
 * quiet Tuesday are the same value and must not look the same on screen.
 */
async function readCalendar(db, user_id, date) {
  const result = { events: [], failed: [], configured: [] };
  if (!user_id || !date) return result;

  const { timeZone, urls } = await calendarSettings(db, user_id);

  for (const feed of FEEDS) {
    // The angle-bracket strip is kept from when these came out of a .env file,
    // where a url pasted from a mail client arrives wrapped in them.
    const url = String(urls[feed.column] || '').replace(/[<>]/g, '').trim();
    if (!url) continue;

    result.configured.push(feed.source);

    try {
      const parsed = await loadFeed(user_id, url);
      for (const e of eventsOn(parsed, feed.source, date, timeZone)) {
        result.events.push({
          ...e,
          all_day: isAllDay(Date.parse(e.start), Date.parse(e.end), date, timeZone),
        });
      }
    } catch (err) {
      // Loud, and named by feed. Without this a calendar that has been broken
      // for a week looks exactly like a week with nothing on.
      console.error(
        `[CALENDAR] could not read the ${feed.label} feed (${feed.env}): ${err.message}`
      );
      result.failed.push({ source: feed.source, label: feed.label });
    }
  }

  result.events.sort((a, b) => a.start.localeCompare(b.start));
  return result;
}

/**
 * Calendar events for one day, in the user's own timezone.
 *
 * Any failure returns the events it could read — a calendar that cannot be
 * read must never stop day planning. Callers that need to know a feed was
 * unreachable use readCalendar instead.
 */
async function get_calendar(db, user_id, date) {
  if (!user_id) return { error: 'user_id is required' };
  if (!date) return [];

  try {
    return (await readCalendar(db, user_id, date)).events;
  } catch {
    return [];
  }
}

/**
 * Insert one entry. user_id is forced from the argument.
 */
async function create_entry(db, user_id, fields) {
  if (!user_id) return { error: 'user_id is required' };

  const row = { ...pick(fields, CREATABLE), user_id };

  if (!row.type) return { error: 'type is required' };
  if (!row.title) return { error: 'title is required' };

  const { data, error } = await db
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
async function update_entry(db, user_id, id, fields) {
  if (!user_id) return { error: 'user_id is required' };
  if (!id) return { error: 'id is required' };

  const patch = pick(fields, UPDATABLE);
  if (Object.keys(patch).length === 0) return { error: 'no fields to update' };

  // updated_at is set by a database trigger, not from here — the client
  // clock and the database clock do not agree.

  let q = db
    .from('entries')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user_id);

  // A deleted entry is a tombstone: it can never be brought back, whatever it
  // would be brought back as. This guarded only the flip to 'active', which was
  // the only one that existed when it was written; 'done' is a real state now,
  // and resurrecting a tombstone as finished work is the same move wearing a
  // different word.
  if (patch.status && patch.status !== 'deleted') q = q.neq('status', 'deleted');

  const { data, error } = await q.select().maybeSingle();

  if (error) return { error: describe(error) };
  if (!data) return { error: 'entry not found for this user' };
  return data;
}

module.exports = {
  search_entries,
  get_calendar,
  // The same read, with the failures named. get_calendar is the tool the brain
  // holds and answers with events alone; the web layer needs to know when a
  // feed was unreachable so it can say so.
  readCalendar,
  create_entry,
  update_entry,
  update_profile,
  timezoneFor,
};
