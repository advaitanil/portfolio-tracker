-- Migration: adding the per-portfolio value chart (portfolio_history)
-- Run this once in Supabase (Project > SQL Editor > New query). Safe to
-- re-run — every statement is idempotent (if not exists / or replace).

create table if not exists portfolio_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  portfolio_id  uuid not null references portfolios (id) on delete cascade,
  date          date not null,
  total_value   numeric not null,
  base_currency text not null,
  source        text not null default 'backfill', -- 'backfill' | 'daily_job' | 'live_update'
  created_at    timestamptz not null default now()
);

create unique index if not exists idx_portfolio_history_portfolio_date
  on portfolio_history (portfolio_id, date);

create index if not exists idx_portfolio_history_user
  on portfolio_history (user_id);

alter table portfolio_history enable row level security;

create policy "users manage own portfolio_history" on portfolio_history for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- After running this: redeploy the Worker (cd worker && npx wrangler deploy),
-- push the front-end changes, then visit <your-worker>/backfill-history once
-- to seed real historical per-portfolio data. Until you do that, a
-- portfolio's chart will only show "today" going forward (from live updates).
