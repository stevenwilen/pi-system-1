-- Row level security: the database enforces ownership, not just the code.
--
-- Run this in the Supabase SQL editor. Safe to run repeatedly.
--
-- WHY THIS EXISTS. Until now every query scoped itself with
-- `.eq('user_id', …)` and the service key bypassed row level security, so
-- ownership was a promise the code made about itself. One forgotten filter and
-- the route serves someone else's rows, and nothing anywhere would object.
-- After this, a query that forgets returns nothing instead.
--
-- WHAT AUTH.UID() IS. The `sub` claim of the caller's JWT, which PostgREST
-- reads from the Authorization header. It is null for the `anon` role, so an
-- unauthenticated request matches no row in any policy below — the tables stop
-- existing rather than appearing empty.
--
-- THE SERVICE KEY STILL BYPASSES ALL OF THIS, by design. `service_role` is
-- marked BYPASSRLS in Postgres, so the scheduler keeps working exactly as it
-- did: it acts for every user at once and has no caller to be. That is why the
-- scheduler is the only thing allowed to hold that key, and why there is both
-- a static check and a runtime guard making sure it stays that way.


-- ORDER MATTERS. `enable row level security` with no policy denies everything,
-- so between these two statements a table is closed to every caller. Each
-- table is done in one transaction to keep that window at zero.


-- profile --------------------------------------------------------------------

begin;
alter table profile enable row level security;
drop policy if exists profile_own on profile;
create policy profile_own on profile
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
commit;


-- entries --------------------------------------------------------------------

begin;
alter table entries enable row level security;
drop policy if exists entries_own on entries;
create policy entries_own on entries
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
commit;


-- plans ----------------------------------------------------------------------

begin;
alter table plans enable row level security;
drop policy if exists plans_own on plans;
create policy plans_own on plans
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
commit;


-- blocks ---------------------------------------------------------------------
--
-- On its own user_id rather than through plan_id. A block carries the column,
-- so the direct test is both cheaper and stricter: a row whose plan belongs to
-- someone else is refused on its own terms, without a join to be got wrong.

begin;
alter table blocks enable row level security;
drop policy if exists blocks_own on blocks;
create policy blocks_own on blocks
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
commit;


-- sent_log -------------------------------------------------------------------
--
-- Written only by the scheduler, which bypasses this. The policy is here so
-- that nothing else can read it: it records what was delivered and when, which
-- is a log of somebody's day.

begin;
alter table sent_log enable row level security;
drop policy if exists sent_log_own on sent_log;
create policy sent_log_own on sent_log
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
commit;


-- `for all` covers select, insert, update and delete in one policy. Two clauses
-- do the work and they are not the same check:
--
--   using       which existing rows this caller can see, and therefore which
--               ones update and delete are allowed to touch
--   with check  what a row is allowed to look like after an insert or update
--
-- Both are required. `using` alone would let a caller UPDATE their own row and
-- set user_id to somebody else's, handing it away — visible going in, not
-- checked coming out.


-- Confirm it took ------------------------------------------------------------
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public'
--      and tablename in ('profile','entries','plans','blocks','sent_log');
--
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--    where schemaname = 'public';
--
-- rowsecurity must be true on all five, and each must have exactly one policy
-- with cmd = 'ALL'.


-- NOT DONE HERE, on purpose: no foreign key from user_id to auth.users. It is
-- the right end state, but adding it now would invalidate every id the existing
-- suites use, all at once, on top of everything else changing. It goes in as
-- its own step once the suites are on real accounts.
--
-- ALSO NOT HERE: messages and api_usage. Neither is read by anything the
-- planner serves — no route touches them — so enabling policies on them is a
-- separate decision about two tables that are currently inert.
