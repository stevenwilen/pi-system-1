-- The evening nudge hour.
--
-- Which hour, in the person's own timezone, they get told that tomorrow has
-- not been planned. Null means 20:00, which is the answer for everyone until
-- somebody says otherwise, so no existing row needs touching.
--
-- An hour rather than a time. The nudge is not an appointment and does not need
-- to land on a particular minute; the scheduler ticks every fifteen and fires
-- in the first window that opens on the hour.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table profile add column if not exists nudge_hour int;

alter table profile drop constraint if exists profile_nudge_hour_range;
alter table profile add constraint profile_nudge_hour_range
  check (nudge_hour is null or (nudge_hour >= 0 and nudge_hour <= 23));

comment on column profile.nudge_hour is
  'Hour of the local evening to send the no-plan-for-tomorrow nudge. Null means 20.';
