-- Phase 7: the database side of the simplification.
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- Step 3 is irreversible. Everything before it is additive, and everything
-- after it is structural on empty tables.

-- 1. New columns ------------------------------------------------------------

-- Pause is a separate, reversible state from delete. A paused entry is still
-- active and still cared about; it has been set down on purpose and drops out
-- of the stale list until unpaused. This is SPEC 2.6 and 2.7: intent is
-- declared by a tap, never inferred from a gap.
alter table entries add column if not exists paused_at timestamptz;

-- Blocks become start plus duration. Pinned blocks are calendar events and
-- appointments: they hold their start_time and never recompute when the chain
-- above them shifts. sort_order carries drag-to-reorder.
--
-- Named sort_order rather than position: `position` is a SQL keyword and,
-- while Postgres does allow it as a column name, it reads ambiguously next to
-- the position() function for no benefit.
alter table blocks add column if not exists pinned           boolean not null default false;
alter table blocks add column if not exists sort_order       int;
alter table blocks add column if not exists duration_minutes int;

-- Written in one reasoning pass at confirm time and sent later by a timer, so
-- the model is never called at block-start time. SPEC section 5.
alter table blocks add column if not exists message_text    text;
alter table blocks add column if not exists message_sent_at timestamptz;

-- 2. Tombstone the types nothing surfaces any more ---------------------------

-- Before the drops, so the deletion is recorded while the columns still exist.
-- Rule 2.5 stands: these become tombstones, not holes. The type CHECK is
-- deliberately left permissive so they remain legal rows.
update entries
   set status = 'deleted'
 where type in ('observation', 'idea', 'waiting')
   and status = 'active';

-- 3. Drop columns. IRREVERSIBLE ----------------------------------------------

-- evidence and confidence belonged to observations, which are gone: nothing
-- creates them without a chat, and deliberate-versus-drift is now a tap.
-- user_corrected was set only by the Noticed tab. due went with task ranking.
alter table entries drop column if exists evidence;
alter table entries drop column if exists confidence;
alter table entries drop column if exists user_corrected;
alter table entries drop column if exists due;

-- 4. Indexes -----------------------------------------------------------------

-- Tasks sort by staleness now, not by rank, so a unique task ranking buys
-- nothing and makes inserting a task fiddly. Project rank is untouched.
drop index if exists entries_task_priority_idx;
drop index if exists entries_user_due_idx;

-- 5. blocks: end_time becomes duration_minutes -------------------------------

-- The table is empty, so this is a definition change and not a data migration.
-- The builder computes start times client-side as blocks shift and persists
-- them on confirm; the scheduler then reads start_time directly and never has
-- to recompute the chain to know when to fire.
alter table blocks drop column if exists end_time;
alter table blocks alter column duration_minutes set not null;

-- 6. sent_log ----------------------------------------------------------------

-- The CHECK enumerated the eight deleted jobs, so it would reject anything new.
-- Per-block delivery is guarded by blocks.message_sent_at, which is exact per
-- block where (user_id, job, date) never could be. The constraint is dropped
-- rather than rewritten, and the table kept for whatever needs a daily guard.
alter table sent_log drop constraint if exists sent_log_job_check;

-- Untouched on purpose: messages (124 rows), api_usage (174 rows), the entries
-- type CHECK, plans, and every existing tombstone.
