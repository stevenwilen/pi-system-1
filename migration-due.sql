-- Re-add the due date on entries.
--
-- This column existed before and was dropped in the simplification. It comes
-- back with a narrower job than it had: a due date is an annotation, not an
-- ordering. Nothing sorts by it. Position in the priorities list is still the
-- person's own ranking and only a drag changes it.
--
-- Nullable, and null on nearly everything. Only projects and tasks may carry
-- one; a habit has a cadence instead, and a habit with a deadline would be two
-- different ideas in one row.
--
-- Run once, in the Supabase SQL editor. Safe to run twice.

alter table entries add column if not exists due date;

comment on column entries.due is
  'Optional deadline for a project or task. Never set on a habit. An annotation, never a sort key.';

-- No index. Nothing filters or orders by this column: it is read alongside the
-- row it belongs to and nowhere else, so an index would be weight with no
-- query behind it.
