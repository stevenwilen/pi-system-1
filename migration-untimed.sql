-- A block that is committed to a day but not to an hour.
--
-- "Anytime today": ring the dentist, put the bins out. Real commitments that
-- belong to a day and would be a lie to place at 10:30 — and placing them
-- there is what a schedule made only of timed blocks forces you to do.
--
-- SAME TABLE, deliberately. A second table would need its own ordering, its
-- own reconciliation on confirm, its own tie to an entry, and its own answer
-- to the staleness question — four copies of what `blocks` already does, kept
-- in step by hand. What an untimed item actually is, is a block with no time,
-- so that is what it is: start_time and duration_minutes are null together.
--
-- Null TOGETHER. A row with one and not the other is not a state this system
-- has a meaning for, and the routes refuse it.
--
-- `completed` COMES BACK TO LIFE HERE, and that is the point of the design.
-- It has been inert for a long time: the column defaults to true, nothing set
-- it, and staleness filtered on it anyway — kept, in as many words, in case
-- anything ever set it again. This is that. A timed block counts for staleness
-- by staying in the day; an untimed item has no hour to have passed, so it
-- counts only when the person says it is done. It is therefore inserted false
-- and set true by hand, and the filter that was waiting does the rest.
--
-- Run once, in the Supabase SQL editor. Safe to run twice: dropping a NOT NULL
-- that is already dropped is not an error.

alter table blocks alter column start_time drop not null;
alter table blocks alter column duration_minutes drop not null;

comment on column blocks.start_time is
  'When this block begins. NULL for an untimed item — one committed to the day but not to an hour — in which case duration_minutes is null too.';

comment on column blocks.duration_minutes is
  'How long this block runs, a multiple of 30. NULL for an untimed item, together with start_time. An untimed item takes no time in the day and is left out of the day''s end time.';

comment on column blocks.completed is
  'Whether this happened. Timed blocks are true and stay true: taking one out of the day is how you say it did not happen. Untimed items start false and are set true when marked done, which is what makes them count for staleness.';

-- No index. Untimed items are read with the plan they belong to, and the
-- delivery queue filters them out by start_time being null rather than by
-- looking for them.
