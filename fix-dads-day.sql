-- One-off repair, not a migration. Delete this file once it has been run.
--
-- WHAT HAPPENED. His profile was on UTC, so the date rolled over at 8pm his
-- time. Planning in the evening, the app already believed it was the 3rd, so
-- the day he built on the "Tomorrow" tab was written for the 4th — and the
-- morning he built it for showed a nearly empty day instead.
--
-- The timezone is already fixed. This moves the nine blocks onto the day he
-- meant. Nothing has been lost: all nine are still sitting on the 4th.
--
-- SIMPLER THAN THE FIRST VERSION OF THIS FILE, which did the same work with a
-- window function to renumber sort_order. It did not need to: the nine are
-- already numbered 0 to 8 in clock order, so moving them is one column.
--
-- Run the four statements in order. The two plan ids are his, read out of the
-- database, and are the only rows any of this touches.


-- 1. The day he built, onto today --------------------------------------------

update blocks
   set plan_id = 'c5491488-ccae-42db-bcad-13a9b190978d'
 where plan_id = 'c85ff51c-5782-493c-b199-36c17be39dcf';


-- 2. The leftover duplicate --------------------------------------------------
--
-- Today already held one block: "Morning Routine" at 12:30, whose message has
-- already gone out — 12:30 UTC was 8:30am on his clock, which is when it
-- arrived. The day he built has its own Morning Routine at 07:00, so keeping
-- both leaves the same thing on the list twice, and its sort_order of 0
-- collides with the 07:00 one.
--
-- SKIP THIS if you would rather he decided. An extra row is one swipe to
-- remove and nothing else depends on it being gone.

delete from blocks
 where plan_id = 'c5491488-ccae-42db-bcad-13a9b190978d'
   and title = 'Morning Routine'
   and start_time = '12:30:00';


-- 3. The day starts when he said it did --------------------------------------

update plans set wake_time = '07:00:00'
 where id = 'c5491488-ccae-42db-bcad-13a9b190978d';


-- 4. The emptied plan --------------------------------------------------------
--
-- LAST, AND ONLY AFTER 1 HAS RUN. blocks.plan_id cascades on delete, so
-- removing this plan while its blocks still pointed at it would take all nine
-- with it. The guard makes that impossible rather than unlikely: it deletes
-- nothing at all if anything still belongs to it.

delete from plans
 where id = 'c85ff51c-5782-493c-b199-36c17be39dcf'
   and not exists (
     select 1 from blocks
      where plan_id = 'c85ff51c-5782-493c-b199-36c17be39dcf'
   );


-- Confirm it took ------------------------------------------------------------
--
-- Nine blocks on the 3rd, 07:00 through 17:00, and nothing on the 4th:
--
--   select p.date, b.start_time, b.duration_minutes, b.title
--     from blocks b join plans p on p.id = b.plan_id
--    where p.user_id = (select user_id from plans
--                        where id = 'c5491488-ccae-42db-bcad-13a9b190978d')
--    order by p.date, b.start_time;
