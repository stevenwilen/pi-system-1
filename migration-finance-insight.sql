-- Allow entries of type 'finance_insight'.
--
-- One row per daily finance line. The line itself is stored so the next day's
-- can read what has already been said and not repeat it. Nothing from the
-- sheet is stored, only the sentence.
--
-- Run once in the Supabase SQL editor. Safe to run again.

alter table entries drop constraint if exists entries_type_check;

alter table entries add constraint entries_type_check
  check (type in (
    -- live
    'habit', 'project', 'task', 'finance_intent', 'finance_insight',
    -- retired, kept so existing tombstones remain valid
    'observation', 'idea', 'waiting'
  ));
