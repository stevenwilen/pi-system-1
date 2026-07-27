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
-- The notebook. Habits, projects and tasks.
--
-- The type CHECK still lists observation, idea and waiting. Those types are
-- retired and nothing creates them, but existing rows became tombstones rather
-- than being deleted, and a CHECK applies to tombstones too. Narrowing it would
-- mean destroying them, which is the one move that cannot be undone.
--
-- Deletion is soft: status = 'deleted' leaves a tombstone. Deleted rows are
-- never returned by search_entries and can never be flipped back to active.

create table if not exists entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  type        text not null check (type in (
                -- live
                'habit', 'project', 'task', 'finance_intent', 'finance_insight',
                -- retired, kept so existing tombstones remain valid
                'observation', 'idea', 'waiting')),

  title       text not null,
  body        text,

  why         text,          -- projects: why this matters, captured when added
  frequency   text,          -- habits: 'daily', 'weekdays', '3x/week', ...

  -- Retired. Nothing reads or writes it, and no index enforces it. Kept
  -- because dropping a column destroys whatever it still holds.
  priority    int,

  -- Position in the stale panel, lower is higher up. This list is the person's
  -- own ranking, so nothing sorts it but a drag.
  sort_order  int,

  -- The daily verdict. Written by one scheduled call, read by the panel, which
  -- never calls the model itself.
  cold        boolean not null default false,
  cold_reason text,

  status      text not null default 'active' check (status in ('active', 'deleted', 'done')),

  -- Set down on purpose, not neglected. A paused entry is still active and
  -- still cared about; it drops out of the stale list until unpaused. This is
  -- what replaced inferring whether a gap was deliberate.
  paused_at   timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists entries_user_type_status_idx
  on entries (user_id, type, status);

-- One list, in the order the person put it in.
create index if not exists entries_user_sort_idx
  on entries (user_id, sort_order)
  where status = 'active';

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
--
-- entry_id tags a block to a habit, project or task. That tag is what makes
-- the stale panel possible: how long since something was last scheduled is the
-- most recent block carrying its id.
--
-- Start plus duration, not start and end. The builder shifts the chain
-- client-side and persists the resulting start_times on confirm, so the
-- scheduler can fire from start_time without recomputing anything.

create table if not exists blocks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  plan_id     uuid not null references plans (id) on delete cascade,

  start_time       time not null,
  duration_minutes int not null,   -- always a multiple of 30
  sort_order       int,            -- drag to reorder
  title            text not null,
  entry_id         uuid references entries (id) on delete set null,

  -- Calendar events and appointments. A pinned block holds its start_time and
  -- never moves when the chain above it shifts. A collision with one is shown,
  -- never auto-resolved.
  pinned      boolean not null default false,

  completed   boolean not null default true,
  miss_reason text,

  -- Written in one reasoning pass when the plan is confirmed, then sent by a
  -- timer. The model is never called at block-start time.
  message_text    text,
  message_sent_at timestamptz,

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

-- No CHECK on `job`. The old one enumerated eight jobs that no longer exist,
-- so it could only reject whatever comes next. Per-block delivery is guarded
-- by blocks.message_sent_at, which is exact per block where (user, job, date)
-- never could be; this table remains for anything needing a once-a-day lock.

create table if not exists sent_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  job           text not null,
  sent_for_date date not null,
  created_at    timestamptz not null default now(),

  unique (user_id, job, sent_for_date)
);
