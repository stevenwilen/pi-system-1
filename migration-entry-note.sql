-- A note on a thing, which is a message to yourself for the next time you
-- schedule it.
--
-- THIS IS NOT THE NOTE ON A BLOCK, and the difference is the whole design.
-- `blocks.note` says what you are doing in that session; it belongs to Tuesday
-- morning and stays there. This one says what you want to remember WHEN you
-- next put this thing in a day: "start with the pricing page", "bring the blue
-- folder".
--
-- IT IS COPIED, NOT MOVED. Confirming a day writes it onto the first new block
-- for that thing and leaves this column alone, because at that moment the work
-- is still ahead and the words are still what you will want when you come to
-- do it.
--
-- IT IS CLEARED ONCE THE SESSION HAS HAPPENED, by a daily sweep, when a block
-- for this entry sits in a confirmed plan whose date is before today. A block
-- still in a day that has passed is a block that happened, and taking one out
-- of the day is how you say it did not, so a note survives a scheduling that
-- was pulled and is spent by one that was kept.
--
-- Habits are never swept. A habit's note is standing, read every time it is
-- scheduled, so clearing it would destroy it rather than spend it.
--
-- It was moved rather than copied once, at confirm time. That lost the words
-- whenever a day was agreed to and then not followed, which is the case the
-- note is most needed for.
--
-- Nullable, and null on almost every row. Free text. Nothing parses it and
-- nothing reasons about it.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table entries add column if not exists note text;

comment on column entries.note is
  'Free text for the next time this is scheduled. COPIED onto the first new block for this entry when a day is confirmed; this column is left alone. Cleared by a daily sweep once a block for this entry sits in a confirmed plan dated before today, which is when the session actually happened. Never cleared on a habit, whose note is standing. Not blocks.note, which belongs to one session and keeps its own copy.';

-- No index. It is read with the row it belongs to and nothing filters on it.
