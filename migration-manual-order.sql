-- Manual ordering, and a coldness verdict the brain writes once a day.
--
-- Run once in the Supabase SQL editor. Safe to run again.

-- 1. The list is the person's own ranking -----------------------------------

-- Position in the stale panel. Lower is higher up. Nothing sorts by staleness
-- any more: the days-since label and the temperature bar inform, and only a
-- drag moves anything.
alter table entries add column if not exists sort_order int;

-- 2. The verdict -------------------------------------------------------------

-- Written by a daily job, read by the panel. The panel never calls the model,
-- so these are the only values it ever shows.
alter table entries add column if not exists cold boolean not null default false;
alter table entries add column if not exists cold_reason text;

-- 3. Priority is retired, but not destroyed ----------------------------------

-- The unique index went with ranked projects. The column stays, unused and
-- unread: dropping it would destroy whatever ordering it still holds, and an
-- unused column costs nothing.
drop index if exists entries_user_priority_idx;

-- 4. Ordering reads ----------------------------------------------------------

create index if not exists entries_user_sort_idx
  on entries (user_id, sort_order)
  where status = 'active';

-- 5. Seed the order ----------------------------------------------------------

-- Existing rows have no position. Give them one, newest first, so the panel
-- opens in a sensible order rather than an arbitrary one. Only rows that have
-- no position yet are touched, so re-running cannot reshuffle a list someone
-- has since arranged by hand.
with ordered as (
  select id, row_number() over (partition by user_id order by created_at desc) - 1 as n
    from entries
   where status = 'active'
     and type in ('habit', 'project', 'task')
     and sort_order is null
)
update entries e
   set sort_order = ordered.n
  from ordered
 where e.id = ordered.id;
