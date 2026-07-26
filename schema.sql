-- Personal Intelligence System — Postgres schema for Supabase
-- Every table is scoped by user_id. No RLS yet.
--
-- Safe to run repeatedly: every statement is guarded, so re-running
-- applies whatever is missing and skips whatever already exists.

create extension if not exists pgcrypto;


-- updated_at ----------------------------------------------------------------
-- The database owns updated_at, not the client. Clients and the database
-- keep different clocks; a client-stamped updated_at can land earlier than
-- a database-stamped created_at and quietly break ordering by recency.

create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- profile -------------------------------------------------------------------
-- One row per user. Timing and delivery settings only. Never rules.

create table if not exists profile (
  user_id           uuid primary key,
  timezone          text not null default 'UTC',
  default_wake_time time not null default '07:00',
  telegram_chat_id  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists profile_touch_updated_at on profile;
create trigger profile_touch_updated_at
  before update on profile
  for each row execute function touch_updated_at();


-- entries -------------------------------------------------------------------
-- The notebook. Observations, habits, projects.
-- Deletion is soft: status = 'deleted' leaves a tombstone. Deleted rows are
-- never returned by search_entries and can never be flipped back to active.

create table if not exists entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  type        text not null check (type in ('observation', 'habit', 'project', 'task', 'idea')),

  title       text not null,
  body        text,

  why         text,          -- projects: why this matters, captured when added
  priority    int,           -- projects: rank, 1 = highest
  frequency   text,          -- habits: 'daily', 'weekdays', '3x/week', ...

  evidence    text,          -- observations: what the user said or did
  confidence  int check (confidence between 0 and 100),

  status      text not null default 'active' check (status in ('active', 'deleted', 'done')),

  -- Set only by the app when the person edits an observation's wording. The
  -- brain can read it but must never write it.
  user_corrected boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists entries_user_type_status_idx
  on entries (user_id, type, status);

create index if not exists entries_user_priority_idx
  on entries (user_id, priority)
  where type = 'project' and status = 'active';

drop trigger if exists entries_touch_updated_at on entries;
create trigger entries_touch_updated_at
  before update on entries
  for each row execute function touch_updated_at();


-- plans ---------------------------------------------------------------------
-- One plan per user per day. Built in the evening, sent at wake time.
-- 'pending' until the user confirms it.

create table if not exists plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  date       date not null,
  wake_time  time not null,
  status     text not null default 'pending' check (status in ('pending', 'confirmed')),
  reasoning  text,           -- why the day was shaped this way
  created_at timestamptz not null default now(),

  unique (user_id, date)
);

create index if not exists plans_user_date_idx on plans (user_id, date);


-- blocks --------------------------------------------------------------------
-- The time blocks of a plan. Assumed done unless the user reports a miss.
-- entry_id tags a block to a project or habit, which is what makes
-- time-spent-vs-priority analysis possible.

create table if not exists blocks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  plan_id     uuid not null references plans (id) on delete cascade,

  start_time  time not null,
  end_time    time not null,
  title       text not null,
  entry_id    uuid references entries (id) on delete set null,

  completed   boolean not null default true,
  miss_reason text,

  created_at  timestamptz not null default now()
);

create index if not exists blocks_plan_idx       on blocks (plan_id, start_time);
create index if not exists blocks_user_entry_idx on blocks (user_id, entry_id);


-- messages ------------------------------------------------------------------
-- The conversation. App turns and outbound Telegram messages both land here,
-- so the brain sees one continuous thread.

create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_user_created_idx on messages (user_id, created_at);


-- api_usage -----------------------------------------------------------------
-- One row per call to the model, so spend can be shown without an admin key.
-- Anthropic exposes no balance endpoint; the balance shown in the app is a
-- figure you set, counted down by these rows.

create table if not exists api_usage (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  source                text not null,   -- 'chat' | 'day-plan' | 'habits' | 'projects'
  model                 text not null,
  input_tokens          int not null default 0,
  output_tokens         int not null default 0,
  cache_read_tokens     int not null default 0,
  cache_creation_tokens int not null default 0,
  cost_usd              numeric(12, 6) not null default 0,
  created_at            timestamptz not null default now()
);

create index if not exists api_usage_user_created_idx
  on api_usage (user_id, created_at);


-- sent_log ------------------------------------------------------------------
-- Proof that a scheduled job already went out. A row's existence means this
-- job fired for this user on this date, so the guard survives restarts and
-- redeploys. The unique constraint is the lock; it also provides the only
-- index this table needs.

create table if not exists sent_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  job           text not null check (job in ('day-plan', 'habits', 'projects', 'tasks', 'ideas', 'week-brief')),
  sent_for_date date not null,
  created_at    timestamptz not null default now(),

  unique (user_id, job, sent_for_date)
);
