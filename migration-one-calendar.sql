-- One calendar, and it is the Personal one.
--
-- Run this in the Supabase SQL editor. Safe to run repeatedly.
--
-- No DDL. Both columns stay exactly as they are; this only moves a value
-- between them. `calendar_ics_url` is the one the code reads from now, and
-- `calendar_action_ics_url` is left in place holding nothing, unread — the same
-- treatment `blocks.completed` and `blocks.miss_reason` got, for the same
-- reason: dropping a column is the one move that cannot be undone.
--
-- WHICH WAY ROUND, and why it is not the obvious way. `calendar_ics_url`
-- currently holds the "Dates" group calendar, which has nothing on it.
-- `calendar_action_ics_url` holds the personal one, which has the actual
-- appointments. The distinction between them is gone, so what is left is one
-- calendar — and it should be the one with the events in it.

begin;

update profile
   set calendar_ics_url        = calendar_action_ics_url,
       calendar_action_ics_url = null
 where user_id = 'b586ea65-f73a-40bd-bff6-7c93b51867f0'
   and calendar_action_ics_url is not null;

commit;


-- Confirm it took ------------------------------------------------------------
--
--   select user_id,
--          calendar_ics_url,
--          calendar_action_ics_url
--     from profile;
--
-- calendar_ics_url should end in the personal address —
-- .../steven.wilen%40gmail.com/private-.../basic.ics — and
-- calendar_action_ics_url should be null.
--
-- The `and calendar_action_ics_url is not null` guard is what makes this safe
-- to run twice: a second run finds nothing to move and changes nothing, rather
-- than overwriting the url it just set with the null beside it.


-- THE DATES CALENDAR IS NOT DELETED, it is simply no longer pointed at. If you
-- would rather keep that one instead, the address is still in your Google
-- account and in migration-feeds.sql in this repository — paste it into the
-- settings sheet and it becomes the one calendar.
