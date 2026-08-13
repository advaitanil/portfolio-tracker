// Cloudflare Worker with a Cron Trigger (Day 5). Multi-user: every signed-up
// user has their own holdings; each scheduled run refreshes ONE shared
// price/FX cache (so the market-data rate limit doesn't scale with user
// count), then loops through every user and sends each one their own daily
// email built from their own holdings.
//
// Test locally with: wrangler dev --test-scheduled
// then: curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
//
// Manually trigger a real run any time by visiting the deployed Worker's URL
// (the fetch handler below runs the exact same job on demand — useful for
// Day 6's "delete a ticker's price on purpose" test).

import { makeSupabase } from "./lib/supabase.js";
import { fetchPrices } from "./lib/prices.js";
import { fetchFxRates } from "./lib/fx.js";
import { computePortfolioMetrics } from "./lib/metrics.js";
import { fetchNews, prioritizeNews } from "./lib/news.js";
import { writeCommentary } from "./lib/commentary.js";
import { renderEmail, buildSubject, sendEmail } from "./lib/email.js";
import { fetchHistoricalPrices, fetchHistoricalFxRange, computeHistoryValues } from "./lib/history.js";

// CORS: the front end (a different origin, *.pages.dev) calls these routes
// directly from the browser. Day 19: now that authedFetch() sends a custom
// "Authorization" header, the browser preflights every request with an
// OPTIONS call first — Access-Control-Allow-Headers has to explicitly
// include Authorization or the browser blocks the real request before it's
// ever sent, no matter what the Worker itself would have returned.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

// Don't let rapid front-end calls (e.g. mis-clicks, multiple tabs) burn
// through Twelve Data's rate limit — skip refetching if we refreshed the
// cache more recently than this, and just tell the caller so.
const REFRESH_THROTTLE_MS = 2 * 60 * 1000; // 2 minutes

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyJob(env));
  },

  // Lets you trigger the same job manually (Day 6 testing, Day 13 "break
  // things on purpose"), and exposes a tiny JSON status page for the last
  // few runs (Day 13's "visible log of recent runs").
  //
  // Day 19 — locked down: every route below used to be reachable by anyone
  // who knew (or guessed) the URL, with no check that the caller was who
  // they claimed to be. That's a real cost/privacy risk, not just a
  // theoretical one: /run with no user_id emails EVERY signed-up user,
  // /refresh-prices and /backfill-history both burn through Twelve Data's
  // shared free-tier quota, and /status leaks another user's total_value
  // and commentary to anyone who can guess their UUID. Now:
  //   - /run?user_id=X and /status?user_id=X require a valid Supabase
  //     session AND that the session's user.id matches X.
  //   - /refresh-prices and /search-symbols require any valid signed-in
  //     session (not scoped to a specific user — they touch shared,
  //     not personal, data) so a random bot off the internet can't hit them.
  //   - /run with NO user_id (the full multi-user job) and /backfill-history
  //     are both expensive/sensitive at the WHOLE-APP level, not one user's
  //     problem to authorize — those require a shared admin secret instead
  //     (?admin_key=..., set via `wrangler secret put WORKER_ADMIN_KEY`).
  //     The actual daily cron trigger doesn't go through this HTTP route at
  //     all (see the scheduled() handler above), so this doesn't affect it.
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === "/run") {
      const userId = url.searchParams.get("user_id");
      if (userId) {
        const authedUser = await getAuthedUser(req, env);
        if (!authedUser || authedUser.id !== userId) {
          return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
        }
        const result = await runDailyJobForUser(env, userId);
        return Response.json(result, { headers: CORS_HEADERS });
      }
      if (!checkAdminKey(url, env)) {
        return Response.json({ error: "unauthorized — pass ?admin_key=<WORKER_ADMIN_KEY>" }, { status: 401, headers: CORS_HEADERS });
      }
      const result = await runDailyJob(env);
      return Response.json(result, { headers: CORS_HEADERS });
    }
    if (url.pathname === "/status") {
      const userId = url.searchParams.get("user_id");
      if (!userId) return Response.json({ error: "pass ?user_id=<your supabase auth user id>" }, { status: 400, headers: CORS_HEADERS });
      const authedUser = await getAuthedUser(req, env);
      if (!authedUser || authedUser.id !== userId) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
      }
      const sb = makeSupabase(env);
      const reports = await sb.getRecentReports(10, userId).catch((e) => ({ error: e.message }));
      return Response.json(reports, { headers: CORS_HEADERS });
    }
    if (url.pathname === "/refresh-prices") {
      const authedUser = await getAuthedUser(req, env);
      if (!authedUser) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
      const result = await refreshPricesOnly(env);
      return Response.json(result, { headers: CORS_HEADERS });
    }
    if (url.pathname === "/backfill-history") {
      if (!checkAdminKey(url, env)) {
        return Response.json({ error: "unauthorized — pass ?admin_key=<WORKER_ADMIN_KEY>" }, { status: 401, headers: CORS_HEADERS });
      }
      const result = await backfillHistory(env);
      return Response.json(result, { headers: CORS_HEADERS });
    }
    if (url.pathname === "/search-symbols") {
      const authedUser = await getAuthedUser(req, env);
      if (!authedUser) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
      const q = url.searchParams.get("q") || "";
      const result = await searchSymbols(q, env);
      return Response.json(result, { headers: CORS_HEADERS });
    }
    return new Response(
      "Portfolio Tracker Worker. Try /run, /run?user_id=..., /status?user_id=..., /refresh-prices, /backfill-history, or /search-symbols?q=...",
      { status: 200 }
    );
  },
};

// Verifies a Supabase access token by asking Supabase itself who it belongs
// to (GET /auth/v1/user) — no JWT/JWKS handling needed in the Worker. Reads
// the token from "Authorization: Bearer <token>", which the front end sends
// via app.js's authedFetch(). Returns the Supabase user object (with .id) if
// valid, or null if missing/expired/invalid.
async function getAuthedUser(req, env) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Shared secret for the app-wide (not per-user) endpoints — set via
// `wrangler secret put WORKER_ADMIN_KEY`. If it's never set, these routes
// stay permanently locked rather than failing open.
function checkAdminKey(url, env) {
  const key = url.searchParams.get("admin_key");
  return !!env.WORKER_ADMIN_KEY && key === env.WORKER_ADMIN_KEY;
}

// Ticker autocomplete (Day 15): proxies Twelve Data's symbol_search so the
// API key never has to live in the browser. The front end debounces calls to
// this as the user types in the ticker field. Trimmed down to just what the
// dropdown needs — Twelve Data's raw response has more fields than we use.
async function searchSymbols(query, env) {
  const q = query.trim();
  if (q.length < 1) return { data: [] };
  try {
    const url = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&apikey=${env.TWELVE_DATA_API_KEY}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json?.status === "error") return { data: [], error: json.message || "search failed" };
    const rows = (json.data || []).slice(0, 12).map((r) => ({
      symbol: r.symbol,
      name: r.instrument_name,
      exchange: r.exchange,
      type: r.instrument_type,
      currency: r.currency,
      country: r.country,
    }));
    return { data: rows };
  } catch (err) {
    return { data: [], error: err.message };
  }
}

// Day 19: ensures fx_rates has a cached rate at or before each holding's
// buy_date for its buy_currency, so front-end/email cost-basis math can use
// the ACTUAL rate on the day you bought instead of today's rate. Reuses the
// chart backfill's range-fetch (fetchHistoricalFxRange) so one Frankfurter
// call covers a whole currency's date range at once rather than one call per
// holding. Best-effort and non-blocking: on any failure it just leaves the
// gap uncached, and callers (app.js's computeRow, metrics.js) fall back to
// today's rate exactly like before this feature existed.
async function ensureBuyDateFxCoverage(env, sb, holdings, baseCurrency) {
  try {
    const earliestNeededByCurrency = {};
    for (const h of holdings) {
      if (!h.buy_currency || h.buy_currency === baseCurrency) continue;
      const covered = await sb.getFxRateBefore(baseCurrency, h.buy_currency, `${h.buy_date}T23:59:59.999Z`).catch(() => null);
      if (covered != null) continue;
      if (!earliestNeededByCurrency[h.buy_currency] || h.buy_date < earliestNeededByCurrency[h.buy_currency]) {
        earliestNeededByCurrency[h.buy_currency] = h.buy_date;
      }
    }
    for (const [currency, sinceDate] of Object.entries(earliestNeededByCurrency)) {
      const range = await fetchHistoricalFxRange(baseCurrency, [currency], sinceDate).catch(() => ({}));
      const rows = Object.entries(range).flatMap(([date, rates]) =>
        Object.entries(rates).map(([quote, rate]) => ({ base: baseCurrency, quote, rate, as_of: `${date}T12:00:00.000Z` }))
      );
      if (rows.length) await sb.insertRows("fx_rates", rows).catch((e) => console.error("Failed to cache buy-date FX (continuing anyway):", e.message));
    }
  } catch (e) {
    console.error("ensureBuyDateFxCoverage failed (continuing anyway):", e.message);
  }
}

// Cache-only refresh — no email, no daily_reports row. This is what the front
// end calls right after you add a holding, so you're not stuck waiting for
// tomorrow's cron just to see a price for something you just added. Works
// over EVERY user's tickers combined, since the price/FX cache is shared.
async function refreshPricesOnly(env) {
  const baseCurrency = env.BASE_CURRENCY || "USD";
  const sb = makeSupabase(env);

  try {
    const holdings = await sb.getHoldings(); // across all users
    if (!holdings.length) return { skipped: true, reason: "no holdings yet" };

    const lastAsOf = await sb.getMostRecentPriceAsOf().catch(() => null);
    if (lastAsOf && Date.now() - new Date(lastAsOf).getTime() < REFRESH_THROTTLE_MS) {
      return { skipped: true, reason: "refreshed recently, throttled" };
    }

    await ensureBuyDateFxCoverage(env, sb, holdings, baseCurrency);

    const tickers = holdings.map((h) => h.ticker);
    const priceCurrenciesNeeded = [...new Set(holdings.map((h) => h.buy_currency))];
    const { results: priceResults, batchFailed } = await fetchPrices(tickers, env);
    if (batchFailed) {
      // Whole Twelve Data call failed — bail out before writing anything, so
      // the last good cached prices stay authoritative instead of getting
      // shadowed by a null/stale row for every ticker (Day 20 bug).
      throw new Error("Twelve Data price fetch failed entirely — previous prices kept, nothing overwritten. Check TWELVE_DATA_API_KEY / rate limits.");
    }
    const currenciesInPrices = Object.values(priceResults).map((p) => p.currency).filter(Boolean);
    const allQuoteCurrencies = [...new Set([...priceCurrenciesNeeded, ...currenciesInPrices])];
    const fxRatesToday = await fetchFxRates(baseCurrency, allQuoteCurrencies);

    await sb.insertRows(
      "prices",
      tickers.map((t) => ({
        ticker: t,
        price: priceResults[t]?.price ?? null,
        previous_close: priceResults[t]?.previous_close ?? null,
        currency: priceResults[t]?.currency ?? null,
        source: priceResults[t]?.source ?? "twelvedata",
        is_stale: priceResults[t]?.is_stale ?? true,
        error: priceResults[t]?.error ?? null,
      }))
    );
    await sb.insertRows(
      "fx_rates",
      Object.entries(fxRatesToday).map(([quote, rate]) => ({ base: baseCurrency, quote, rate }))
    );

    return { refreshed: true, tickers };
  } catch (err) {
    return { refreshed: false, error: err.message };
  }
}

// Run this ONCE (visit /backfill-history) to seed every user's value-over-time
// chart with real historical data — closing prices + FX rates since each of
// their holdings' buy_date, not synthetic numbers. Safe to re-run: it upserts
// by (user, date), so it just overwrites with fresher data.
async function backfillHistory(env) {
  const baseCurrency = env.BASE_CURRENCY || "USD";
  const sb = makeSupabase(env);

  try {
    const allHoldings = await sb.getHoldings();
    if (!allHoldings.length) return { ok: false, reason: "no holdings yet" };

    const users = await sb.listUsers();
    const earliestBuyDate = allHoldings.reduce((min, h) => (h.buy_date < min ? h.buy_date : min), allHoldings[0].buy_date);
    const tickers = allHoldings.map((h) => h.ticker);

    // Fetch historical prices/FX ONCE for the union of every user's tickers —
    // each user's computation below just reads from these shared maps.
    const priceHistory = await fetchHistoricalPrices(tickers, earliestBuyDate, env);
    const tickerCurrencies = Object.values(priceHistory).map((p) => p.currency).filter(Boolean);
    const buyCurrencies = allHoldings.map((h) => h.buy_currency);
    const allQuoteCurrencies = [...new Set([...tickerCurrencies, ...buyCurrencies])];
    const fxHistory = await fetchHistoricalFxRange(baseCurrency, allQuoteCurrencies, earliestBuyDate);

    // Day 19: also persist the FX history itself into fx_rates (not just use
    // it transiently for the chart math above) — this is what lets cost-basis
    // calculations later look up the ACTUAL rate on a holding's buy_date
    // instead of always falling back to today's rate. One row per
    // (currency, day) in the range, appended the same way live refreshes
    // append rather than overwrite (fx_rates has no unique constraint by
    // design — see schema.sql) — re-running backfill re-appends the same
    // historical rows, which is harmless for correctness (lookups always
    // take the closest match) but does grow the table on repeated runs.
    const fxHistoryRows = Object.entries(fxHistory).flatMap(([date, rates]) =>
      Object.entries(rates).map(([quote, rate]) => ({ base: baseCurrency, quote, rate, as_of: `${date}T12:00:00.000Z` }))
    );
    if (fxHistoryRows.length) {
      await sb.insertRows("fx_rates", fxHistoryRows).catch((e) => console.error("Failed to cache historical FX range (continuing anyway):", e.message));
    }

    const perUser = [];
    for (const user of users) {
      const holdings = allHoldings.filter((h) => h.user_id === user.id);
      if (!holdings.length) continue;

      const points = computeHistoryValues({ holdings, priceHistory, fxHistory, baseCurrency });
      if (!points.length) {
        perUser.push({ email: user.email, ok: false, reason: "could not compute any historical points" });
        continue;
      }

      await sb.upsertRows(
        "portfolio_value_history",
        points.map((p) => ({ date: p.date, total_value: p.total_value, base_currency: baseCurrency, source: "backfill", user_id: user.id })),
        "user_id,date"
      );

      // Same backfill, scoped to each of this user's named portfolios — reuses
      // the SAME priceHistory/fxHistory maps fetched above, so this costs zero
      // extra market-data API calls, just extra arithmetic. Portfolio
      // membership is applied as of TODAY, not historically (a holding didn't
      // necessarily belong to its current portfolio on every day since its
      // buy_date) — same kind of "use current data, not a true point-in-time
      // reconstruction" simplification already used for buy-currency FX.
      const portfolioIds = [...new Set(holdings.map((h) => h.portfolio_id).filter(Boolean))];
      let portfoliosWritten = 0;
      for (const portfolioId of portfolioIds) {
        const portfolioHoldings = holdings.filter((h) => h.portfolio_id === portfolioId);
        const pPoints = computeHistoryValues({ holdings: portfolioHoldings, priceHistory, fxHistory, baseCurrency });
        if (!pPoints.length) continue;
        await sb.upsertRows(
          "portfolio_history",
          pPoints.map((p) => ({
            date: p.date,
            total_value: p.total_value,
            base_currency: baseCurrency,
            source: "backfill",
            user_id: user.id,
            portfolio_id: portfolioId,
          })),
          "portfolio_id,date"
        );
        portfoliosWritten++;
      }

      perUser.push({
        email: user.email,
        ok: true,
        pointsWritten: points.length,
        from: points[0].date,
        to: points[points.length - 1].date,
        portfoliosBackfilled: portfoliosWritten,
      });
    }

    return { ok: true, users: perUser };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Shared by the full cron job, the single-user "Run now" button, and (in
// spirit) /refresh-prices: fetch fresh prices + today's/yesterday's FX for
// whatever set of holdings it's given, and cache the results. Pulled out into
// one place so all three callers stay consistent instead of drifting.
async function refreshSharedPriceFxCache(env, sb, holdings, baseCurrency) {
  await ensureBuyDateFxCoverage(env, sb, holdings, baseCurrency);

  const tickers = [...new Set(holdings.map((h) => h.ticker))];
  const priceCurrenciesNeeded = [...new Set(holdings.map((h) => h.buy_currency))];
  const { results: priceResults, batchFailed } = await fetchPrices(tickers, env);
  if (batchFailed) {
    // Same reasoning as refreshPricesOnly above: never let a total fetch
    // failure overwrite the prices cache OR flow into today's chart point
    // (processUserDailyJob would otherwise upsert a $0 into
    // portfolio_value_history since every holding's price would be missing).
    // Throwing here means neither happens — callers' existing try/catch
    // blocks (runDailyJob, runDailyJobForUser, refreshPricesOnly) already
    // surface this as a clean "failed" status instead of a silent stale $0.
    throw new Error("Twelve Data price fetch failed entirely — previous prices kept, nothing overwritten. Check TWELVE_DATA_API_KEY / rate limits.");
  }
  const currenciesInPrices = Object.values(priceResults).map((p) => p.currency).filter(Boolean);
  const allQuoteCurrencies = [...new Set([...priceCurrenciesNeeded, ...currenciesInPrices])];
  const fxRatesToday = await fetchFxRates(baseCurrency, allQuoteCurrencies);

  const nowIso = new Date().toISOString();
  // Yesterday's FX snapshot, per quote currency, for the price-vs-FX return split (Day 12).
  const fxRatesYesterday = {};
  for (const q of allQuoteCurrencies) {
    if (q === baseCurrency) continue;
    fxRatesYesterday[q] = await sb.getFxRateBefore(baseCurrency, q, nowIso).catch(() => null);
  }

  // Cache what we fetched — write-through, append-only, shared across all users.
  await sb
    .insertRows(
      "prices",
      tickers.map((t) => ({
        ticker: t,
        price: priceResults[t]?.price ?? null,
        previous_close: priceResults[t]?.previous_close ?? null,
        currency: priceResults[t]?.currency ?? null,
        source: priceResults[t]?.source ?? "twelvedata",
        is_stale: priceResults[t]?.is_stale ?? true,
        error: priceResults[t]?.error ?? null,
      }))
    )
    .catch((e) => console.error("Failed to cache prices (continuing anyway):", e.message));

  await sb
    .insertRows(
      "fx_rates",
      Object.entries(fxRatesToday).map(([quote, rate]) => ({ base: baseCurrency, quote, rate }))
    )
    .catch((e) => console.error("Failed to cache FX rates (continuing anyway):", e.message));

  return { priceResults, fxRatesToday, fxRatesYesterday };
}

async function runDailyJob(env) {
  const startedAt = Date.now();
  const baseCurrency = env.BASE_CURRENCY || "USD";
  const sb = makeSupabase(env);

  try {
    const allHoldings = await sb.getHoldings();
    if (!allHoldings.length) return { status: "skipped", reason: "no holdings for any user yet" };

    const users = await sb.listUsers();

    // --- Shared price/FX refresh, once for the union of every user's tickers ---
    const { priceResults, fxRatesToday, fxRatesYesterday } = await refreshSharedPriceFxCache(env, sb, allHoldings, baseCurrency);

    // --- Per-user: metrics, news, commentary, email, logging ---
    const results = [];
    for (const user of users) {
      const holdings = allHoldings.filter((h) => h.user_id === user.id);
      if (!holdings.length) continue; // signed up, no holdings yet — nothing to email

      const result = await processUserDailyJob({ user, holdings, priceResults, fxRatesToday, fxRatesYesterday, baseCurrency, sb, env });
      results.push(result);
    }

    return { status: "completed", duration_ms: Date.now() - startedAt, users: results };
  } catch (err) {
    // Failure at the SHARED stage (holdings/price/FX fetch) affects everyone —
    // this is the one case that still goes to the single ops alert address.
    console.error("Daily job failed at the shared stage:", err);
    await sendFailureAlert(err, env).catch((e) => console.error("Failure alert itself failed to send:", e.message));
    return { status: "failed", error: err.message, duration_ms: Date.now() - startedAt };
  }
}

// Day 15's "Run now" button: the same job as runDailyJob, but scoped to one
// user's own holdings/tickers only — it does NOT touch or email anyone else,
// unlike hitting /run with no user_id. This DOES send a real email to that
// one user (it's a genuine on-demand run of their daily job, not a dry run),
// and writes a real daily_reports row so it shows up in "Recent Runs".
async function runDailyJobForUser(env, userId) {
  const startedAt = Date.now();
  const baseCurrency = env.BASE_CURRENCY || "USD";
  const sb = makeSupabase(env);

  try {
    const allHoldings = await sb.getHoldings();
    const holdings = allHoldings.filter((h) => h.user_id === userId);
    if (!holdings.length) return { status: "skipped", reason: "no holdings for this user yet" };

    const user = await sb.getUserById(userId);
    if (!user) return { status: "failed", error: "no user found for that id" };

    const { priceResults, fxRatesToday, fxRatesYesterday } = await refreshSharedPriceFxCache(env, sb, holdings, baseCurrency);
    const result = await processUserDailyJob({ user, holdings, priceResults, fxRatesToday, fxRatesYesterday, baseCurrency, sb, env });

    return { status: "completed", duration_ms: Date.now() - startedAt, user: result };
  } catch (err) {
    console.error(`Manual run failed for user ${userId}:`, err);
    return { status: "failed", error: err.message, duration_ms: Date.now() - startedAt };
  }
}

// One user's slice of the daily job: their own metrics, news, commentary,
// email (sent to THEIR OWN address, looked up from their Supabase Auth
// account — not a fixed EMAIL_TO), and their own daily_reports/history rows.
// Wrapped so one user's failure can't take down anyone else's run.
async function processUserDailyJob({ user, holdings, priceResults, fxRatesToday, fxRatesYesterday, baseCurrency, sb, env }) {
  const startedAt = Date.now();
  let status = "sent";
  let errorMsg = null;
  let metrics = null;
  let commentary = null;
  let topNews = [];

  try {
    // Day 19: look up each holding's OWN buy-date FX rate (cached by
    // ensureBuyDateFxCoverage, called earlier in refreshSharedPriceFxCache)
    // instead of letting cost basis silently use today's rate. Missing
    // coverage just means that holding falls back to today's rate below —
    // never a hard failure.
    const buyFxRatesById = {};
    for (const h of holdings) {
      if (!h.buy_currency || h.buy_currency === baseCurrency) continue;
      const rate = await sb.getFxRateBefore(baseCurrency, h.buy_currency, `${h.buy_date}T23:59:59.999Z`).catch(() => null);
      if (rate != null) buyFxRatesById[h.id] = rate;
    }

    metrics = computePortfolioMetrics({ holdings, pricesByTicker: priceResults, fxRatesToday, fxRatesYesterday, baseCurrency, buyFxRatesById });
    if (metrics.flagged.length > 0) status = "partial"; // graceful degradation, not silence

    // Append today's real value to this user's chart history (Day 14).
    const todayStr = new Date().toISOString().slice(0, 10);
    await sb
      .upsertRows(
        "portfolio_value_history",
        [{ date: todayStr, total_value: metrics.totalValue, base_currency: baseCurrency, source: "daily_job", user_id: user.id }],
        "user_id,date"
      )
      .catch((e) => console.error(`[${user.email}] Failed to append value history (continuing anyway):`, e.message));

    // Same, per portfolio — metrics.holdings is index-aligned with `holdings`
    // (computePortfolioMetrics does holdings.map(...)), so zip by index
    // rather than matching on ticker: a ticker can now legitimately appear in
    // more than one of a user's portfolios, and a ticker-based lookup would
    // silently attribute both to whichever one it found first.
    const valueByPortfolio = {};
    holdings.forEach((h, i) => {
      if (!h.portfolio_id) return;
      const r = metrics.holdings[i];
      if (!r || r.currentValue == null) return;
      valueByPortfolio[h.portfolio_id] = (valueByPortfolio[h.portfolio_id] || 0) + r.currentValue;
    });
    const portfolioHistoryRows = Object.entries(valueByPortfolio).map(([portfolio_id, total_value]) => ({
      date: todayStr,
      total_value,
      base_currency: baseCurrency,
      source: "daily_job",
      user_id: user.id,
      portfolio_id,
    }));
    if (portfolioHistoryRows.length) {
      await sb
        .upsertRows("portfolio_history", portfolioHistoryRows, "portfolio_id,date")
        .catch((e) => console.error(`[${user.email}] Failed to append per-portfolio value history (continuing anyway):`, e.message));
    }

    // News (Day 8/9) — never let a news failure block the email.
    const news = await fetchNews(holdings, env).catch((e) => {
      console.error(`[${user.email}] News step failed entirely:`, e.message);
      return [];
    });
    topNews = prioritizeNews(news, metrics, 5);

    // AI commentary (Day 10) — never let it block the email either.
    commentary = await writeCommentary(metrics, topNews, env).catch(() => null);

    const html = renderEmail(metrics, topNews, commentary);
    const subject = buildSubject(metrics);
    await sendEmail(html, subject, { ...env, EMAIL_TO: user.email }); // each user gets their own email
  } catch (err) {
    status = "failed";
    errorMsg = err.message;
    console.error(`[${user.email}] Daily job failed for this user:`, err);
  }

  const duration_ms = Date.now() - startedAt;
  await sb
    .insertRows("daily_reports", [
      {
        user_id: user.id,
        total_value: metrics?.totalValue ?? null,
        day_change_pct: metrics?.dayChangePct ?? null,
        commentary,
        news_json: topNews,
        status,
        duration_ms,
        error: errorMsg,
        sent_at: status === "failed" ? null : new Date().toISOString(),
      },
    ])
    .catch((e) => console.error(`[${user.email}] Failed to write daily_reports row:`, e.message));

  return { userId: user.id, email: user.email, status, duration_ms, error: errorMsg, totalValue: metrics?.totalValue ?? null };
}

// Day 13: "send yourself a failure alert if a scheduled run breaks." This is
// the one email that still goes to the fixed EMAIL_TO (an ops/admin address),
// since a shared-stage failure isn't any single user's problem to see.
async function sendFailureAlert(err, env) {
  const html = `<p>The daily portfolio job failed at the shared stage (before any per-user processing):</p><pre>${(err.stack || err.message || String(err)).slice(0, 2000)}</pre>`;
  await sendEmail(html, "⚠️ Portfolio Tracker — daily run FAILED", env);
}
