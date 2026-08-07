-- Portfolio Tracker — Supabase schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).

-- ── holdings ────────────────────────────────────────────────────────────────
-- What you own. One row per manually-entered lot. Multi-user: every holding
-- belongs to exactly one Supabase Auth user (see RLS policies below).
create table if not exists holdings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  ticker       text not null,
  name         text,
  asset_type   text not null check (asset_type in ('stock', 'etf', 'fund')),
  quantity     numeric not null check (quantity > 0),
  buy_price    numeric not null check (buy_price > 0),
  buy_currency text not null default 'USD',
  buy_date     date not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_holdings_user on holdings (user_id);

-- ── prices ──────────────────────────────────────────────────────────────────
-- Cached price snapshots. We APPEND a new row every refresh (never overwrite)
-- so we can look back at "yesterday's" price to compute day change / FX return.
-- Always read the latest row per ticker on the front end — never call the
-- market-data API directly from the browser.
create table if not exists prices (
  id              uuid primary key default gen_random_uuid(),
  ticker          text not null,
  price           numeric, -- nullable: an unsupported/delisted ticker still gets a row (via `error`), it just has no price
  previous_close  numeric,
  currency        text,
  as_of           timestamptz not null default now(),
  source          text not null,
  is_stale        boolean not null default false,
  error           text
);
create index if not exists idx_prices_ticker_asof on prices (ticker, as_of desc);

-- ── fx_rates ────────────────────────────────────────────────────────────────
-- Currency conversion. Appended (not upserted) for the same reason as prices:
-- we need yesterday's rate to separate FX return from price return (Day 12).
create table if not exists fx_rates (
  id      uuid primary key default gen_random_uuid(),
  base    text not null,
  quote   text not null,
  rate    numeric not null,
  as_of   timestamptz not null default now()
);
create index if not exists idx_fx_base_quote_asof on fx_rates (base, quote, as_of desc);

-- ── daily_reports ───────────────────────────────────────────────────────────
-- One row per (user, scheduled Worker run) — the Worker loops through every
-- signed-up user each run and emails each one separately. This is both the
-- audit trail (Day 13's "visible log of recent runs") and the record of what
-- each user's email contained.
create table if not exists daily_reports (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  report_date    date not null default current_date,
  total_value    numeric,
  day_change_pct numeric,
  commentary     text,
  news_json      jsonb,
  status         text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'partial')),
  duration_ms    integer,
  error          text,
  sent_at        timestamptz
);
create index if not exists idx_daily_reports_user_date on daily_reports (user_id, report_date desc);

-- ── portfolio_value_history ─────────────────────────────────────────────────
-- One row per calendar day: total portfolio value in base currency. Seeded
-- once via a real historical backfill (Twelve Data time_series + Frankfurter
-- historical FX, since each holding's buy_date — see worker/src/lib/history.js),
-- then appended to daily by the scheduled job going forward. Powers the
-- "value over time" chart. Deliberately a separate table from daily_reports:
-- daily_reports is an audit trail of actual Worker runs (Day 13); this table
-- is purely valuation-over-time data and can be legitimately backfilled for
-- dates before the Worker ever ran.
create table if not exists portfolio_value_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  date          date not null,
  total_value   numeric not null,
  base_currency text not null,
  source        text not null default 'backfill', -- 'backfill' | 'daily_job'
  created_at    timestamptz not null default now()
);
create unique index if not exists idx_portfolio_value_history_user_date on portfolio_value_history (user_id, date);

-- ── realized_gains ───────────────────────────────────────────────────────────
-- One row per "sell" event — a closed position, distinct from just deleting a
-- holding. Deleting a holding discards it with no record (for fixing a data
-- entry mistake); selling records what it went for and computes the gain.
-- Supports partial sells: selling less than the full quantity reduces the
-- source holding rather than removing it (see app.js sellForm handler).
-- Same known limitation as unrealised gains: the buy-side conversion to base
-- currency uses whatever FX rate is cached "now", not the rate on buy_date —
-- documented in README, not fixed here (would need a historical FX lookup
-- per holding's buy_date, same idea as history.js but not wired up for this).
create table if not exists realized_gains (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  ticker             text not null,
  asset_type         text not null,
  quantity           numeric not null check (quantity > 0),
  buy_price          numeric not null,
  buy_currency       text not null,
  buy_date           date not null,
  sell_price         numeric not null,
  sell_currency      text not null,
  sell_date          date not null,
  base_currency      text not null,
  realized_gain_abs  numeric,
  realized_gain_pct  numeric,
  created_at         timestamptz not null default now()
);
create index if not exists idx_realized_gains_user_date on realized_gains (user_id, sell_date desc);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- NOTE: this project deviates here from the brief's agreed scope (Section 2:
-- "single portfolio, no login, keep it simple") — it's a full multi-user app
-- with each person's own portfolio, on request. An explicit, documented
-- choice, not an oversight. holdings/daily_reports/portfolio_value_history
-- are scoped per-user (auth.uid() = user_id) so one user can never see
-- another's data. prices/fx_rates stay a SHARED cache across all users —
-- ticker prices and FX rates aren't user-owned data, and sharing them is
-- what keeps the whole app inside the market-data provider's free-tier rate
-- limit regardless of how many people sign up. The Worker's service_role key
-- always bypasses RLS entirely (it has to — it writes on behalf of every
-- user in one run), so none of this affects the scheduled job itself.
alter table holdings enable row level security;
alter table prices enable row level security;
alter table fx_rates enable row level security;
alter table daily_reports enable row level security;
alter table portfolio_value_history enable row level security;
alter table realized_gains enable row level security;

create policy "users manage own holdings" on holdings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "authenticated read/write prices" on prices for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated read/write fx_rates" on fx_rates for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "users manage own daily_reports" on daily_reports for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage own portfolio_value_history" on portfolio_value_history for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage own realized_gains" on realized_gains for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No seed data here on purpose: holdings now require a real user_id, and
-- there's no user until someone signs up through the app. Sign up, then add
-- your first 3 test holdings through the dashboard form.
