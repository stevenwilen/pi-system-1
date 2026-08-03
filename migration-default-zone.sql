-- The default timezone stops being UTC.
--
-- UTC IS NOT A PLACE ANYONE LIVES, and defaulting to it is not the neutral
-- choice it reads as. Every question this system answers about WHICH DAY IT IS
-- comes off this column:
--
--   * the date rolls over at 8pm rather than midnight,
--   * "tomorrow" in the evening means the day after tomorrow,
--   * block messages fire four hours early,
--   * and the day screen shows a date that is simply the wrong one.
--
-- None of it announces itself. The screen shows a date and an hour and both
-- look ordinary.
--
-- It cost a real person a real day. An evening's planning went onto the wrong
-- date because at 9pm his clock said the 2nd and this column said the 3rd, so
-- the schedule he built for "tomorrow" landed two days out and the morning he
-- built it for was empty. He had done nothing wrong and there was nothing on
-- any screen to suggest what had happened.
--
-- A default that is wrong for everyone who uses this is worse than one that is
-- wrong for whoever moves away — and the second case is visible and one tap to
-- fix, because Setup offers the device's own zone whenever it disagrees.
--
-- The app has the same constant, once, in clock.js as DEFAULT_ZONE. The two
-- must agree: this one is what a row is born with, and that one is what the
-- routes fall back to for an account whose row does not exist yet.
--
-- Run once, in the Supabase SQL editor.

alter table profile alter column timezone set default 'America/New_York';

comment on column profile.timezone is
  'IANA name. Every day boundary and every send time is computed from it. Defaults to America/New_York — see migration-default-zone.sql for why not UTC. Set from the setup screen, which offers the device''s own zone in one tap.';


-- The accounts already on UTC ------------------------------------------------
--
-- RUN THIS ONCE, AND ONLY ONCE. It is deliberately not part of the statement
-- above, and it is the one thing in this file that is not safe to repeat: it
-- cannot tell an account that was left on the default from one that chose UTC
-- on purpose, because the column has no way to record which. Nobody has chosen
-- it — there was no screen to choose it with until recently — so today it is
-- unambiguous. It will not stay that way.
--
-- Every account currently on UTC was put there by the old default, and every
-- one of them is in New York.

update profile set timezone = 'America/New_York' where timezone = 'UTC';


-- Confirm it took ------------------------------------------------------------
--
-- No account left on the old default. This must return 0:
--
--   select count(*) from profile where timezone = 'UTC';
--
-- And the column is born the right way now. This must say America/New_York:
--
--   select column_default from information_schema.columns
--    where table_name = 'profile' and column_name = 'timezone';
