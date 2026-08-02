-- Every account gets a profile row, at the moment it becomes an account.
--
-- Run this in the Supabase SQL editor. Safe to run repeatedly.
--
-- WHY IT IS HERE AND NOT IN THE APP. Nothing created a profile row. Not the
-- page, not the server, not the schema — and the page signs up by posting
-- straight to `/auth/v1/signup`, which never touches this deployment. So there
-- was no moment in the app's own code where a new account existed and could be
-- given a row. The database is the only place that sees every account however
-- it arrives: the sign-up form, the dashboard, an admin API call, a future
-- second client.
--
-- WHAT IT COST. Every write in routes/settings.js was an UPDATE, and an UPDATE
-- matching no rows is not an error — it reports nothing changed. Linking
-- Telegram on a new account answered `no profile for this account`, having
-- stored nothing and sent nothing. The reads all fell back to UTC instead,
-- which is worse in its own way: the account looked like it worked.
--
-- The routes now upsert, so the app no longer depends on this trigger having
-- run. That is deliberate belt and braces, not redundancy to be tidied up: the
-- trigger is what makes the row exist for the scheduler, which iterates profile
-- rows and would never see an account that had not yet opened the setup sheet.


-- The trigger ----------------------------------------------------------------
--
-- SECURITY DEFINER because the caller here is the sign-up itself, which holds
-- no rights on public.profile. The function runs as its owner — `postgres` in
-- the SQL editor — which owns the table and is therefore not subject to the
-- `profile_own` policy from migration-rls.sql. Without this the insert would be
-- refused by the very policy that protects the table.
--
-- `set search_path = ''` because a SECURITY DEFINER function that resolves
-- names through the caller's search_path can be pointed at a different table by
-- whoever calls it. Every name below is schema-qualified for that reason, and
-- must stay that way.
--
-- IT MUST NOT RAISE. This runs inside the transaction that creates the account,
-- so an exception here does not fail the profile row, it fails the SIGN-UP —
-- the person gets an error and no account at all. The only collision that can
-- happen is the primary key, and `on conflict do nothing` absorbs it, which is
-- also what makes a re-run of the backfill below harmless.
--
-- Only user_id. Every other column has a default (`timezone` UTC,
-- `default_wake_time` 07:00) and guessing at a timezone from an IP or a locale
-- is exactly the sort of inference this system does not make. UTC is the honest
-- placeholder until someone says otherwise.

create or replace function public.profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profile (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- AFTER INSERT: the account exists by the time the row is written, so there is
-- no window in which a profile row points at a user that failed to be created.
drop trigger if exists profile_on_signup on auth.users;
create trigger profile_on_signup
  after insert on auth.users
  for each row execute function public.profile_for_new_user();


-- The backfill ---------------------------------------------------------------
--
-- AFTER the trigger, deliberately, and this order is the whole point: anything
-- signing up between the two statements is caught by the trigger, and anything
-- that existed before is caught here. The other order leaves a gap exactly the
-- width of however long you take to run the second statement.
--
-- Every account that already exists, including the ones that hit
-- `no profile for this account` and gave up. `on conflict do nothing` means the
-- accounts that already have a row are left exactly as they are — no timezone
-- is reset, no chat id is cleared.

insert into public.profile (user_id)
select id from auth.users
on conflict (user_id) do nothing;


-- Confirm it took ------------------------------------------------------------
--
-- No account without a row. This must return 0:
--
--   select count(*)
--     from auth.users u
--     left join public.profile p on p.user_id = u.id
--    where p.user_id is null;
--
-- The trigger is there, and is on the right table:
--
--   select tgname, tgrelid::regclass, tgenabled
--     from pg_trigger
--    where tgname = 'profile_on_signup';
--
-- tgenabled must be 'O'. A disabled trigger ('D') is the failure mode that
-- looks like success here — it exists, it is just never fired.
--
-- The function is SECURITY DEFINER with an empty search_path:
--
--   select proname, prosecdef, proconfig
--     from pg_proc
--    where proname = 'profile_for_new_user';
--
-- prosecdef must be true and proconfig must hold search_path=.
--
-- And the end to end test, which is the only one that proves the trigger fires
-- rather than that it exists — create an account in Authentication → Users and
-- check it has a row:
--
--   select p.user_id, p.timezone, p.default_wake_time, u.email
--     from public.profile p
--     join auth.users u on u.id = p.user_id
--    order by p.created_at desc
--    limit 5;


-- STILL NOT DONE, and still on purpose: no foreign key from profile.user_id to
-- auth.users. migration-rls.sql explains why it was left out, and this changes
-- nothing about that — the trigger creates the row, but deleting an account
-- still leaves its profile row behind. That remains its own step.
