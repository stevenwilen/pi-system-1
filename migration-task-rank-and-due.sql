-- Tasks: a strict importance rank and a date they should be done by.
-- Safe to run more than once.

-- A single date, not a range: the window is from now until this day.
alter table entries add column if not exists due date;

-- Tasks rank exactly as projects do, 1 = most important, no ties.
-- Partial so it only binds live tasks; a done or deleted task frees its place.
-- `priority is not null` keeps unranked tasks out of the index entirely.
create unique index if not exists entries_task_priority_idx
  on entries (user_id, priority)
  where type = 'task' and status = 'active' and priority is not null;

-- What is due drives the day plan, so it is looked up on every planning run.
create index if not exists entries_user_due_idx
  on entries (user_id, due)
  where status = 'active' and due is not null;

-- Note on projects: schema.sql declared entries_user_priority_idx without
-- `unique`, but this database rejects duplicate project priorities, so a
-- unique index was applied at some point that the file never recorded.
-- schema.sql now says `unique` so a fresh database matches this one. Nothing
-- is altered here, because dropping and recreating a live uniqueness
-- guarantee to correct a name is not worth the window where it is absent.
