-- A note on a block.
--
-- What the person is actually doing in this session, in their own words. It
-- belongs to the block and not to the entry, which is the whole point: "finish
-- the pricing page" is true of Tuesday morning, not of the project, and writing
-- it onto the project would make it a claim that outlives the session it
-- describes.
--
-- So it is here rather than on `entries`, and it goes with the block: change
-- the plan and the note goes with the day, re-confirm and it is rewritten
-- alongside everything else.
--
-- Nullable, and null on most blocks. Free text, used verbatim in that block's
-- Telegram message. Nothing parses it and nothing reasons about it.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table blocks add column if not exists note text;

comment on column blocks.note is
  'Free text about this session, written by the person. Belongs to the block, not the entry. Sent verbatim in the block message.';

-- No index. It is read with the row it belongs to and nothing filters on it.
