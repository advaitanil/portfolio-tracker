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

// CORS: the front end (a different origin, *.pages.dev) calls /refresh-prices
// directly from the browser.
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

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
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === "/run") {
      const result = await runDailyJob(env);
      return Response.json(result);
    }
    if (url.pathname === "/status") {
      const userId = url.searchParams.get("user_id");
      if (!userId) return Response.json({ error: "pass ?user_id=<your supabase auth user id>" }, { status: 400 });
      const sb = makeSupabase(env);
      const reports = await sb.getRecentReports(10, userId).catch((e) => ({ error: e.message }));
      return Response.json(reports);
    }
    if (url.pathname === "/refresh-prices") {
      const result = await refreshPricesOnly(env);
      return Response.json(result, { headers: CORS_HEADERS });
    }
    if (url.pathname === "/backfill-history") {
      const result = await backfillHistory(env);
      return Response.json(result, { headers: CORS_HEADERS });
    }
    return new Response("Portfolio Tracker Worker. Try /run, /status?user_id=..., /refresh-prices, or /backfill-history.", { status: 200 });
  },
};

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

    const tickers = holdings.map((h) => h.ticker);
    const priceCurrenciesNeeded = [...new Set(holdings.map((h) => h.buy_currency))];
    const priceResults = await fetchPrices(tickers, env);
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
      perUser.push({ email: user.email, ok: true, pointsWritten: points.length, from: points[0].date, to: points[points.length - 1].date });
    }

    return { ok: true, users: perUser };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    const tickers = [...new Set(allHoldings.map((h) => h.ticker))];
    const priceCurrenciesNeeded = [...new Set(allHoldings.map((h) => h.buy_currency))];
    const priceResults = await fetchPrices(tickers, env);
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
    metrics = computePortfolioMetrics({ holdings, pricesByTicker: priceResults, fxRatesToday, fxRatesYesterday, baseCurrency });
    if (metrics.flagged.length > 0) status = "partial"; // graceful degradation, not silence

    // Append today's real value to this user's chart history (Day 14).
    await sb
      .upsertRows(
        "portfolio_value_history",
        [{ date: new Date().toISOString().slice(0, 10), total_value: metrics.totalValue, base_currency: baseCurrency, source: "daily_job", user_id: user.id }],
        "user_id,date"
      )
      .catch((e) => console.error(`[${user.email}] Failed to append value history (continuing anyway):`, e.message));

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
