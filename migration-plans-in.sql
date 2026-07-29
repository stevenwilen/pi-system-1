-- When this person plans.
--
-- Two kinds of planner, and the difference decides two things: which day the
-- app opens on, and which day the evening nudge asks about.
--
--   evening   plans tomorrow before bed. Opens on Tomorrow, and is nudged when
--             TOMORROW has no confirmed plan.
--   morning   plans the day they are in. Opens on Today, and is nudged when
--             TODAY has no confirmed plan.
--
-- Nudging an evening planner about today would be telling them about a day
-- they are already halfway through, and nudging a morning planner about
-- tomorrow would be asking for a plan they do not make until they wake up. It
-- is the same message either way; only the day it asks about changes.
--
-- The nudge hour is separate and unchanged: `profile.nudge_hour` still says
-- when, this says what about.
--
-- Nullable, and null reads as 'evening' everywhere — which is what the system
-- did before this column existed, so an unset row behaves exactly as it did.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table profile add column if not exists plans_in text;

alter table profile drop constraint if exists profile_plans_in_kind;
alter table profile add constraint profile_plans_in_kind
  check (plans_in is null or plans_in in ('morning', 'evening'));

comment on column profile.plans_in is
  'When this person plans: morning or evening. Decides which day the app opens on and which day the nudge asks about. Null means evening.';
