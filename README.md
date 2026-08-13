# Portfolio Tracker with Daily Email Intelligence

A web app for entering a portfolio of stocks/ETFs/funds, tracking it live, and
emailing a daily summary with metrics, news, and AI commentary.

Built for the ThinkPlan internship assignment. Free tiers only, test data
only — see Section 12 of the brief for constraints.

**Note on scope:** the brief (Section 2) explicitly agrees "single portfolio,
no login, keep it simple." This build goes further than that on request: it's
a full multi-user app — anyone can sign up and gets their own private
portfolio, own daily email, own value-history chart. This is a significant,
intentional deviation from the agreed scope, not an oversight — worth
flagging clearly in your D1/D2 write-up so it reads as a documented trade-off
rather than scope creep, especially since the simpler alternatives (no login,
or login-but-still-one-shared-portfolio) were raised first.

Architecturally: `holdings`, `daily_reports`, and `portfolio_value_history`
are scoped per-user via RLS (`auth.uid() = user_id`) — one user can never see
another's data. `prices` and `fx_rates` stay a **shared** cache across every
user, since ticker prices/FX rates aren't user-owned data, and sharing them
is what keeps the app inside the market-data provider's free-tier rate limit
regardless of how many people sign up (Twelve Data doesn't care if 1 person
or 50 people are looking at AAPL's price — it's one shared row either way).
The scheduled Worker fetches that shared cache once per run, then loops
through every signed-up user and sends each one their own separate email.

**Known gap:** Resend's sandbox sender (`onboarding@resend.dev`) can only
deliver to the email address the Resend *account* was created with. Other
users' daily emails will fail gracefully (logged as a failed `daily_reports`
row) rather than crash the run, but they won't actually land in those users'
inboxes until a real domain is verified in Resend.

## Status

This is deployed and running, not just a starting codebase — live URL, live
Worker, real Supabase project. Everything below is either fully built and
testable, or is honestly flagged as something that needs your own real-world
action (time passing, a working API key, an actual submission) rather than
more code.

**Built and working:**
- All Section 11 **Must** items: holdings CRUD, cached prices with an "as of" timestamp, base-currency conversion, hand-verified value/gain/day-change, scheduled email, news, graceful degradation, no secrets in git.
- Most **Should** items: retries/backoff, a failure alert on shared-stage errors, price return separated from FX return, a run history log (`daily_reports` table + the `/status` API — dropped from the dashboard UI itself as of Day 19 to declutter it, but every run is still recorded).
- Most **Could** items: value-over-time chart (from *real* historical closing prices, not synthetic data), allocation breakdown, edit-holding (not just delete), a mobile-readable email layout.
- Beyond the brief: full login + multi-user support (see scope note above), an on-demand price refresh after adding a holding, NAV/fund holdings get a longer staleness grace period than intraday stocks and are labelled "NAV" rather than "price."

**Genuinely NOT done — and not something more code fixes:**
- **3 mornings of automated email** (Must, Section 11) — this requires the scheduled cron to fire unattended on 3 separate real calendar days. Nothing can shortcut this; check your inbox over the next few mornings.
- **Claude commentary actually appearing in the email** (Must) — the code is fully built and guardrailed, but you hit a blocker getting Claude API access, so `ANTHROPIC_API_KEY` was never set. Until it is, every email correctly *omits* the commentary section (graceful degradation working as designed) rather than containing one. This needs to be resolved for that Must item to be genuinely met.
- **The Day 11 Haiku-vs-Sonnet comparison** — blocked on the same Claude API access issue; can't produce real quality/latency/cost numbers without a working key.
- **Wider ticker coverage beyond Twelve Data's free tier** — this is a paid-plan constraint, not a code gap; Section 12 requires written approval before spending, so this stays documented as a limitation rather than solved.
- **D1/D2 submission, demo recording, and handover note** — these are real actions only you can take (sending to Divya, recording your screen), not code.

If you're using this repo as evidence for D1/D2, the honest move is to call out these five items explicitly rather than let the amount of finished code imply they're covered too.

## Architecture

```
public/            Front end — static HTML/CSS/JS, deployed to Cloudflare Pages
  index.html        Page structure
  style.css         Styling (mobile-friendly)
  app.js            Supabase client: holdings CRUD + edit, login/signup, reads
                     from prices/fx/history caches only (never calls a
                     market-data or FX API directly from the browser)
  config.example.js Copy to config.js and fill in your Supabase URL + anon key

worker/             Backend — Cloudflare Worker with a Cron Trigger
  wrangler.toml     Worker config + cron schedule (UTC!)
  src/index.js      Routes: scheduled job, /run (+?user_id=), /status, /refresh-prices, /backfill-history, /search-symbols
  src/lib/
    supabase.js      Minimal PostgREST client (service_role key, bypasses RLS)
    prices.js         Twelve Data — batched quote fetch
    fx.js             Frankfurter — FX rates
    history.js        Twelve Data time_series + Frankfurter historical range —
                       real historical portfolio-value backfill for the chart
    metrics.js        All the maths: value, cost, gain/loss, weight, day change,
                       price return vs FX return
    news.js           Marketaux — fetch, dedupe, prioritise by biggest movers
    commentary.js     Claude API — guardrailed narrative commentary
    email.js          Render the HTML email + send via Resend
    retry.js          Shared exponential-backoff helper

schema.sql          Run once in the Supabase SQL editor — creates all 5 tables + RLS + seed data
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

**Migration note:** `schema.sql` is written for a fresh Supabase project. If
your database already had holdings/reports/history from before multi-user
support was added, those tables needed `user_id` added via `alter table`,
existing rows backfilled to a real user, and RLS policies swapped from
"any authenticated user" to "only this row's owner" — a one-time migration,
not something `schema.sql` re-running would do for you on an existing table.
The same is true for the later addition of **portfolios** (a new `portfolios`
table + `holdings.portfolio_id`) — see the migration block at the bottom of
`schema.sql` if you already have data.

**Portfolios, scoped:** you can now group holdings into named portfolios
(e.g. "Retirement", "Trading") and filter the dashboard by one, or view
everything under "All portfolios". This filters the holdings table, summary
stats, allocation breakdown, **and the value-over-time chart** (each
portfolio has its own real history, in a separate `portfolio_history` table —
see schema.sql). The **daily email and realized gains stay whole-account**
(every portfolio combined) — splitting those per portfolio too (multiple
emails per morning) wasn't asked for and would be a bigger rearchitecture;
this keeps the email as one summary of everything while still letting the
dashboard itself be filtered.

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

### 3a. Google sign-in and "forgot password" (Day 21)

Both are implemented in the front end already (`public/index.html` /
`public/app.js` — the "Continue with Google" button and "Forgot password?"
link on the login screen). Password reset needs zero extra setup beyond what
Supabase gives you out of the box; Google sign-in needs a one-time dashboard
step I can't do for you (it requires your own Google Cloud login):

**Forgot password** — works immediately, but double check Supabase's Auth >
URL Configuration has your site's real URL(s) listed under "Redirect URLs"
(e.g. `https://portfolio.rexorot.com`, plus your `*.pages.dev` URL if you
still use it) and that "Site URL" is set to your primary domain. Without
this, the reset-password link Supabase emails will redirect somewhere
Supabase refuses to send the session to, and the link will silently fail.

**Google sign-in** — needs a Google OAuth Client ID/Secret:
1. In [Google Cloud Console](https://console.cloud.google.com) → APIs &
   Services → Credentials → Create OAuth client ID → Application type "Web
   application".
2. Authorized redirect URI: `https://<your-project-ref>.supabase.co/auth/v1/callback`
   (Supabase's Auth > Providers > Google page shows you this exact URL —
   copy it from there rather than typing it by hand).
3. Copy the generated Client ID and Client Secret.
4. In Supabase: Auth > Providers > Google → toggle it on → paste the Client
   ID and Client Secret → Save.
5. Same "Redirect URLs" caveat as above — add your site's URL(s) under Auth
   > URL Configuration, or the post-login redirect back to the app will fail
   even though the Google login itself succeeded.

Until step 4 is done, clicking "Continue with Google" will show an error
from Supabase (something like "Unsupported provider") instead of doing
anything harmful — the front-end code doesn't need to change once the
provider is turned on.

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

# Day 19: a shared secret for the two app-wide (not per-user) endpoints —
# the full multi-user /run and /backfill-history. Pick any long random
# string; you'll pass it back as ?admin_key=<this value> when you need to
# hit either of those two routes yourself. Every other endpoint now checks
# your Supabase session instead — this key is NOT needed for normal use of
# the site, only for those two specific manual/admin actions.
wrangler secret put WORKER_ADMIN_KEY
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
There's a **"Run now" button on the dashboard itself** (top of the page,
next to "Fetch prices") that hits `/run?user_id=<you>` — scoped to just your
own holdings/email. As of Day 19 this (and every other endpoint below except
`/search-symbols`, which just needs any signed-in session) checks that your
browser's Supabase session actually belongs to the user_id you're asking
for, so hitting these with `curl` yourself now requires a real access token:

```
# Get your own token from the browser console while signed in to the dashboard:
#   (await supabase.auth.getSession()).data.session.access_token
curl -H "Authorization: Bearer <your access token>" \
  "https://<your-worker>.workers.dev/run?user_id=<your user id>"
```

The full multi-user `/run` (no `user_id`) and `/backfill-history` are
app-wide, not any one user's call to make — they're gated behind the
`WORKER_ADMIN_KEY` secret instead:
```
curl "https://<your-worker>.workers.dev/backfill-history?admin_key=<WORKER_ADMIN_KEY>"
```
Note the actual daily cron trigger doesn't go through this HTTP route at all
(see `scheduled()` in `worker/src/index.js`), so none of this affects the
real scheduled email.

Also there's a **"Fetch prices" button** next to "Run now" — same
`/refresh-prices` cache refresh the app already triggers automatically after
every add/edit, just exposed as an on-demand button with visible feedback
and, importantly, no email side effect.

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

- Multi-user with Supabase Auth + RLS (see "Login gate" note near the top) — every user's holdings/reports/history are scoped to `auth.uid() = user_id`, and as of Day 19 the Worker's HTTP endpoints check a real session token too, not just the database layer. Still an internal/small-scale tool, not hardened for public signup at scale.
- FX conversion for cost basis: **fixed as of Day 19**, with a caveat. Unrealised gain, realized gain, and the daily email's gain figures now use the actual historical FX rate on each holding's buy_date/sell_date (see `ensureBuyDateFxCoverage` in `worker/src/index.js`), not just today's rate. The caveat: this depends on that historical rate having been backfilled/cached already — a currency/date combination that's never been seen before still falls back to today's rate until the next price refresh or daily run catches it up (usually within minutes of adding the holding, via `/refresh-prices`).
- No retry/backoff tuning has been load-tested against real rate limits yet — the numbers in `retry.js` (3 attempts, exponential backoff) are reasonable defaults, not measured ones.
- Metrics logic is duplicated between `public/app.js` (for the live dashboard) and `worker/src/lib/metrics.js` (for the email) rather than shared — acceptable for this scope, but a real product would extract one shared module.
- No automated tests yet. Given the brief's emphasis on correctness, adding a small test file for `metrics.js` covering the hand-verified examples from Day 4 would be a good next step.
- `fx_rates` is append-only with no unique constraint (by design — see schema.sql), so re-running `/backfill-history` re-appends the same historical rows each time rather than upserting. Harmless for correctness (lookups always take the closest match) but the table grows on every re-run.
- **Fixed (Day 20):** a total Twelve Data outage/rate-limit during a "Run now" or scheduled run used to write a null/stale row for every ticker into the append-only `prices` table, which — because readers always take the most recent row — permanently shadowed the last good cached price (symptom: every holding shows "stale" and total value drops to $0, even though nothing is actually wrong with the ticker data itself). `fetchPrices()` now distinguishes "the whole batch call failed" from "one ticker has no data," and `refreshSharedPriceFxCache`/`refreshPricesOnly` abort before writing anything — including today's `portfolio_value_history` point — when the whole batch fails. "Run now" and "Fetch prices" now surface a clear `Failed: ...` message instead of silently corrupting the cache. Note "Run now" still has no throttle (unlike `/refresh-prices`'s 2-minute one), so heavy manual testing can still burn through Twelve Data's daily credit limit — that part is unchanged, just no longer destructive when it happens.

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
