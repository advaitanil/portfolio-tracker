-- Portfolio Tracker — Supabase schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).

-- ── holdings ────────────────────────────────────────────────────────────────
-- What you own. One row per manually-entered lot.
create table if not exists holdings (
  id           uuid primary key default gen_random_uuid(),
  ticker       text not null,
  name         text,
  asset_type   text not null check (asset_type in ('stock', 'etf', 'fund')),
  quantity     numeric not null check (quantity > 0),
  buy_price    numeric not null check (buy_price > 0),
  buy_currency text not null default 'USD',
  buy_date     date not null,
  created_at   timestamptz not null default now()
);

-- ── prices ──────────────────────────────────────────────────────────────────
-- Cached price snapshots. We APPEND a new row every refresh (never overwrite)
-- so we can look back at "yesterday's" price to compute day change / FX return.
-- Always read the latest row per ticker on the front end — never call the
-- market-data API directly from the browser.
create table if not exists prices (
  id              uuid primary key default gen_random_uuid(),
  ticker          text not null,
  price           numeric not null,
  previous_close  numeric,
  currency        text not null,
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
-- One row per scheduled Worker run. This is both the audit trail (Day 13's
-- "visible log of recent runs") and the record of what each email contained.
create table if not exists daily_reports (
  id             uuid primary key default gen_random_uuid(),
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
create index if not exists idx_daily_reports_date on daily_reports (report_date desc);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Single-user internal demo (Section 2: "no login"). We still enable RLS and
-- open it up explicitly rather than leaving tables unprotected — this is the
-- kind of thing worth a one-line note in the README under "known limitations":
-- a real multi-user version would scope every row to an authenticated user.
alter table holdings enable row level security;
alter table prices enable row level security;
alter table fx_rates enable row level security;
alter table daily_reports enable row level security;

create policy "public read/write holdings" on holdings for all using (true) with check (true);
create policy "public read/write prices" on prices for all using (true) with check (true);
create policy "public read/write fx_rates" on fx_rates for all using (true) with check (true);
create policy "public read/write daily_reports" on daily_reports for all using (true) with check (true);

-- ── Seed: 3 test holdings (Day 1 "done when") ───────────────────────────────
insert into holdings (ticker, name, asset_type, quantity, buy_price, buy_currency, buy_date) values
  ('AAPL', 'Apple Inc.',              'stock', 10, 180.00, 'USD', '2026-01-15'),
  ('VOO',  'Vanguard S&P 500 ETF',    'etf',   5,  420.00, 'USD', '2026-02-01'),
  ('VWCE', 'Vanguard FTSE All-World', 'fund',  8,   95.00, 'EUR', '2026-03-01')
on conflict do nothing;

-- Verify with:
-- select * from holdings;
