-- A note on a thing, which is a message to yourself for the next time you
-- schedule it.
--
-- THIS IS NOT THE NOTE ON A BLOCK, and the difference is the whole design.
-- `blocks.note` says what you are doing in that session; it belongs to Tuesday
-- morning and stays there. This one says what you want to remember WHEN you
-- next put this thing in a day — "start with the pricing page", "bring the
-- blue folder" — and it is spent the moment it arrives.
--
-- So it moves rather than being copied: confirming a day writes it onto the
-- first new block for that thing and sets this column back to null. A note
-- that stayed here would be read again on every future scheduling, which is
-- how a sentence about one morning becomes a standing instruction nobody
-- meant to give.
--
-- Nullable, and null on almost every row. Free text. Nothing parses it and
-- nothing reasons about it.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table entries add column if not exists note text;

comment on column entries.note is
  'Free text for the next time this is scheduled. Moves onto the first new block for this entry when a day is confirmed, and is cleared here. Not blocks.note, which belongs to one session.';

-- No index. It is read with the row it belongs to and nothing filters on it.
