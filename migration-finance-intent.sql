-- Allow entries of type 'finance_intent'.
--
-- The existing CHECK enumerates six types. It is permissive toward the retired
-- ones, observation, idea and waiting, so their tombstones stay legal, but that
-- is not the same as accepting a new type: 'finance_intent' is rejected until
-- it appears in the list.
--
-- Run once in the Supabase SQL editor. Safe to run again.

alter table entries drop constraint if exists entries_type_check;

alter table entries add constraint entries_type_check
  check (type in (
    -- live
    'habit', 'project', 'task', 'finance_intent',
    -- retired, kept so existing tombstones remain valid
    'observation', 'idea', 'waiting'
  ));
