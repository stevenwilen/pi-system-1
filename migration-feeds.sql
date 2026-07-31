-- Calendar feeds move from the environment onto the person.
--
-- Run this in the Supabase SQL editor. Safe to run repeatedly.
--
-- WHY. The two feed URLs were env vars, which is the same shape of assumption
-- PI_USER_ID was: fine while there was one person, and wrong the moment there
-- are two, because the deployment cannot hold a different calendar for each of
-- them. A feed URL is a fact about a person, so it belongs on their row.
--
-- Nullable, both of them. A user with no calendar is an ordinary user, not a
-- misconfigured one: they get an empty aside and no error. The action feed was
-- already optional and stays that way.

alter table profile add column if not exists calendar_ics_url        text;
alter table profile add column if not exists calendar_action_ics_url text;


-- Your two feeds, onto your row -----------------------------------------------
--
-- These are the values currently in Railway, moved verbatim. Run this, confirm
-- the app still shows your calendar, and only then take the two variables out
-- of Railway — in that order, so there is never a moment with neither.

update profile set
  calendar_ics_url =
    'https://calendar.google.com/calendar/ical/f4efe309fa7f4889df549c1ad8c5c12ec923abc3ff23d413896259ec5a195da3%40group.calendar.google.com/private-7a4b92ea6ac1654896a976166fa2c749/basic.ics',
  calendar_action_ics_url =
    'https://calendar.google.com/calendar/ical/steven.wilen%40gmail.com/private-c945242bb720983a06ddc140ffa3c62b/basic.ics'
where user_id = 'b586ea65-f73a-40bd-bff6-7c93b51867f0';


-- Confirm it took --------------------------------------------------------------
--
--   select user_id,
--          calendar_ics_url is not null        as has_awareness,
--          calendar_action_ics_url is not null as has_action
--     from profile;
--
-- Exactly one row should have both. Anything else means the where clause missed.


-- A NOTE ON WHAT THESE URLS ARE. A Google "secret address in iCal format" is a
-- bearer credential: anyone holding the string can read that calendar, with no
-- further authentication. They are now stored in a table that row level
-- security scopes to their owner, which is a better place for them than a
-- deployment-wide environment variable that every part of the system could
-- read. But they are readable by anything holding the service key, and they
-- will appear in this migration file and in your git history — so if you ever
-- want them out of circulation, rotating them in Google is the only thing that
-- actually revokes them.
