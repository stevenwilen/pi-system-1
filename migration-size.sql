-- The size bucket.
--
-- Size used to live inside the `body` column, packed into JSON alongside a
-- free-text note about where something stood. Both of those are gone, and the
-- vocabulary changed with them: it was days/weeks/months, and it is now five
-- buckets that map onto a number of days.
--
-- A column of its own rather than the old JSON, because this is now load
-- bearing. It is one half of the warning mark arithmetic, and a value that
-- decides whether something is shown in the miss colour should not have to be
-- parsed out of a blob that might not be JSON at all.
--
-- `body` is left exactly as it is, still holding whatever it held. Nothing
-- reads it any more.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table entries add column if not exists size text;

-- The five buckets, and nothing else. The check is here rather than only in the
-- route because this column feeds arithmetic: an unrecognised value would map
-- to no number of days, and the mark would silently vanish rather than fail.
alter table entries drop constraint if exists entries_size_bucket;
alter table entries add constraint entries_size_bucket
  check (size is null or size in (
    'a day', 'a few days', 'a week', 'a few weeks', 'months'));

comment on column entries.size is
  'How much work is in this: a day, a few days, a week, a few weeks, months. Required when a due date is set, because the warning mark is size against the time left. Null otherwise.';

-- No index. It is read with the row it belongs to and nothing filters on it.
