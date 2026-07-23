# Portfolio Tracker with Daily Email Intelligence

A web app for entering a portfolio of stocks/ETFs/funds, tracking it live, and
emailing a daily summary with metrics, news, and AI commentary.

Built for the ThinkPlan internship assignment. Single user, no login, free
tiers only, test data only — see Section 12 of the brief for constraints.

## Status

This repo contains a working implementation of the **Must** requirements
(Section 11) plus most of the **Should** items, generated as a starting
codebase. It has **not yet been deployed or run against real accounts** —
that's the next step, and it's yours to do (see "Setup" below). Treat the
code as a strong first draft: read it, understand every line, and verify the
maths before you trust it, exactly as the brief asks.

**Not yet done / left for you:**
- Actual account creation, key generation, and deployment (nobody else can do this — it needs your logins).
- Live end-to-end testing (nothing here has touched a real Supabase project, real API keys, or a real inbox yet).
- Charting portfolio value over time (Day 14 — the `daily_reports` history is already being written, so a chart is a front-end addition away; not built here).
- The Day 11 Haiku-vs-Sonnet comparison — the code supports switching models via `CLAUDE_MODEL`, but only you running it twice can produce real quality/latency/cost numbers.
- NAV/fund-specific handling beyond generic caching (Day 12) — funds that price once daily will just show yesterday's price with an older "as of" timestamp; no special-casing has been added, and the brief only asks you to *document* this behaviour, not necessarily change it.

## Architecture

```
public/            Front end — static HTML/CSS/JS, deployed to Cloudflare Pages
  index.html        Page structure
  style.css         Styling (mobile-friendly)
  app.js            Supabase client: holdings CRUD, reads from prices/fx cache only
  config.example.js Copy to config.js and fill in your Supabase URL + anon key

worker/             Backend — Cloudflare Worker with a Cron Trigger
  wrangler.toml     Worker config + cron schedule (UTC!)
  src/index.js      Scheduled handler: orchestrates the whole daily job
  src/lib/
    supabase.js      Minimal PostgREST client (service_role key, bypasses RLS)
    prices.js         Twelve Data — batched quote fetch
    fx.js             Frankfurter — FX rates
    metrics.js        All the maths: value, cost, gain/loss, weight, day change,
                       price return vs FX return
    news.js           Marketaux — fetch, dedupe, prioritise by biggest movers
    commentary.js     Claude API — guardrailed narrative commentary
    email.js          Render the HTML email + send via Resend
    retry.js          Shared exponential-backoff helper

schema.sql          Run once in the Supabase SQL editor — creates all 4 tables + RLS + seed data
```

### End-to-end flow

1. You add holdings on the web page → saved straight to Supabase (`holdings` table).
2. The **only** thing the front end ever reads for prices/FX is the cache
   (`prices`, `fx_rates` tables) — it never calls a market-data API directly.
   This is the single most important design decision in the project: it's
   what keeps you inside free-tier rate limits.
3. Once a day (cron, UTC), the Worker wakes up, fetches fresh prices and FX
   rates, writes them to the cache, computes every metric itself (never
   trusts a model with the arithmetic), fetches and deduplicates news, asks
   Claude for a short grounded commentary, renders the email, sends it via
   Resend, and logs the whole run to `daily_reports`.
4. Any single step failing (price fetch, news, AI) degrades gracefully —
   the email still sends with what it has, and flags what's missing/stale.

## Setup

Do this in order. Estimated total: a few hours if everything goes smoothly,
more if a provider's sign-up flow fights you — budget accordingly.

### 1. Accounts (Section 3 of the brief)

Create each of these — I can't do this step for you, it requires your own
login:
- [Supabase](https://supabase.com) — new project, note the project URL
- [Cloudflare](https://cloudflare.com) — account for Pages + Workers
- [Resend](https://resend.com) — account + API key
- [Twelve Data](https://twelvedata.com) — free API key (see "Provider choice" below for why)
- [Marketaux](https://marketaux.com) — free API key
- [Claude API / platform.claude.com](https://platform.claude.com) — API key

### 2. Database

In the Supabase dashboard: SQL Editor → New query → paste the contents of
`schema.sql` → Run. This creates `holdings`, `prices`, `fx_rates`,
`daily_reports`, opens RLS policies for this single-user demo, and inserts 3
seed holdings. Verify with:
```sql
select * from holdings;
```

### 3. Front end

```
cp public/config.example.js public/config.js
# edit public/config.js: paste your Supabase URL and anon key (Project Settings > API)
```
Open `public/index.html` directly in a browser first to sanity check it
against your real Supabase project (holdings should load). Then deploy to
Cloudflare Pages:
```
# from the repo root — Cloudflare Pages dashboard: connect this GitHub repo,
# set the build output directory to "public", no build command needed.
```
Confirm you get a live public URL where you can add/see/delete holdings —
that alone satisfies Day 2's "done when".

### 4. Worker

```
cd worker
npm install
wrangler login

# Set every secret (never put these in wrangler.toml or commit them):
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put TWELVE_DATA_API_KEY
wrangler secret put MARKETAUX_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put RESEND_API_KEY
```
Edit `wrangler.toml` `[vars]`: set `EMAIL_FROM` (a Resend-verified sender),
`EMAIL_TO` (your inbox), `BASE_CURRENCY`, and adjust the cron line to your
preferred UTC time.

Test locally before trusting the schedule:
```
npm run dev
# in another terminal:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```
Then deploy:
```
npm run deploy
```
Trigger a real run any time (useful for testing) by visiting
`https://<your-worker>.workers.dev/run`, and check recent run history at
`/status`.

### 5. Verify the maths (Day 4 — do not skip this)

Pick 3 holdings. By hand (calculator, not the app):
1. Convert the current price to your base currency using the FX rate the
   Worker cached (`select * from fx_rates order by as_of desc limit 5;`).
2. Multiply by quantity → compare to `currentValue` for that holding.
3. Do the same for the buy price/cost basis, subtract, compare to
   `gainAbs`/`gainPct`.

If these don't match, the bug is almost certainly in `worker/src/lib/metrics.js`
— that file is the one place all the arithmetic lives, by design, so it's
also the one file worth reading line by line.

## Provider choice and rationale

| Need | Chosen | Free-tier limit | Why | What I gave up |
|---|---|---|---|---|
| Market data | **Twelve Data** | 800 calls/day; US + forex + crypto free; batched quotes (one call for all tickers) | Highest free call budget of the options in Section 7, and batching multiple symbols per request means a once-a-day job costs 1 call, not N | International exchanges beyond US listings sit behind a paid plan — start with US-listed instruments (ETFs still give global exposure) and widen later per Day 12 |
| FX | **Frankfurter** | Free, no key, ECB reference rates | Zero friction (no signup), and the brief calls it "a good default" | ECB rates update once/day on business days — fine for a daily job, not for intraday FX |
| News | **Marketaux** | ~100 requests/day free; entity tagging across 80+ markets | Entity tagging means headlines come pre-linked to tickers, which is most of the dedup/prioritisation work done for free | 100/day is tight if testing repeatedly — cache or throttle manual test runs |
| Email | **Resend** | Required by the brief | — | — |
| AI | **Claude Haiku** (`CLAUDE_MODEL` env var, switchable to Sonnet) | — | Cost-efficient default for a short, structured, low-creativity task; the guardrail prompt does most of the quality work, not model size | Haven't yet run the Day 11 side-by-side comparison — do this once real API access is live and record latency/cost/quality differences here |

**Caching strategy:** every price/FX fetch is written to Supabase before
anything reads it back. The front end and the email template only ever read
from `prices`/`fx_rates`, never call Twelve Data/Frankfurter directly. This
is what keeps a once-a-day Worker run and occasional manual testing well
inside every free-tier limit above.

**If we paid:** Twelve Data's paid tier unlocks 90+ international exchanges
(useful once Day 12's "widen coverage" is a real constraint rather than a
nice-to-have), and a Marketaux paid tier would remove the 100/day ceiling
for more frequent news refreshes.

## Known limitations (honest list)

- Single user, no auth — RLS policies are wide open by design (Section 2: "internal demo, keep it simple"). Do not point this at anything beyond test data.
- FX conversion for cost basis uses the *current* FX rate, not the rate on the buy date — a holding's unrealised gain/loss will include FX drift since purchase that isn't broken out separately. A future version would store the buy-date FX rate at entry time.
- No retry/backoff tuning has been load-tested against real rate limits yet — the numbers in `retry.js` (3 attempts, exponential backoff) are reasonable defaults, not measured ones.
- Metrics logic is duplicated between `public/app.js` (for the live dashboard) and `worker/src/lib/metrics.js` (for the email) rather than shared — acceptable for this scope, but a real product would extract one shared module.
- No automated tests yet. Given the brief's emphasis on correctness, adding a small test file for `metrics.js` covering the hand-verified examples from Day 4 would be a good next step.

## Disclaimer (required, Section 10)

Every email includes: *"This is an internal tool for informational purposes
only. It is not investment advice. Data may be delayed, cached, or
inaccurate."* — rendered in `worker/src/lib/email.js`, do not remove it.

## Day-by-day mapping

The brief lays out a 15-day, ~4-hours/day plan (Section 7). This repo gets
you through most of the Week 1 Musts and a chunk of Week 2 in one pass. Use
the original day-by-day plan to pace what's left — roughly:
- **Days 1–2 equivalent:** done — schema, seed data, CRUD front end (once you deploy it).
- **Days 3–4 equivalent:** done — cached prices, FX, and hand-verified metrics (once you verify them).
- **Days 5–7 equivalent:** done — scheduled Worker, email, README v1. **This is your D1 deliverable once deployed and verified.**
- **Days 8–11 equivalent:** done in code (news, commentary) — needs your live testing and the Haiku/Sonnet comparison write-up.
- **Days 12–14 equivalent:** partially done (FX-vs-price return split, allocation breakdown, retries); charting and deeper NAV handling are still open.
- **Day 15:** record your demo, write the handover note, do the final review — that part is inherently yours.
