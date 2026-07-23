// Cloudflare Worker with a Cron Trigger (Day 5). This is the "sketch" from
// the assignment brief, actually wired up: fetch holdings -> refresh prices
// -> refresh FX -> compute metrics (code owns the maths) -> fetch + dedupe
// news -> ask Claude for commentary -> render + send the email -> log the run.
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyJob(env));
  },

  // Lets you trigger the same job manually (Day 6 testing, Day 13 "break
  // things on purpose"), and exposes a tiny JSON status page for the last
  // few runs (Day 13's "visible log of recent runs").
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      const result = await runDailyJob(env);
      return Response.json(result);
    }
    if (url.pathname === "/status") {
      const sb = makeSupabase(env);
      const reports = await sb.getRecentReports(10).catch((e) => ({ error: e.message }));
      return Response.json(reports);
    }
    return new Response("Portfolio Tracker Worker. Try /run or /status.", { status: 200 });
  },
};

async function runDailyJob(env) {
  const startedAt = Date.now();
  const baseCurrency = env.BASE_CURRENCY || "USD";
  const sb = makeSupabase(env);
  let status = "sent";
  let errorMsg = null;
  let metrics = null;
  let commentary = null;
  let topNews = [];

  try {
    const holdings = await sb.getHoldings();
    if (!holdings.length) throw new Error("No holdings in the database — add at least one before running the job.");

    const tickers = holdings.map((h) => h.ticker);
    const priceCurrenciesNeeded = [...new Set(holdings.map((h) => h.buy_currency))];

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

    // Cache what we fetched — write-through, append-only (see schema.sql notes).
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

    metrics = computePortfolioMetrics({ holdings, pricesByTicker: priceResults, fxRatesToday, fxRatesYesterday, baseCurrency });

    if (metrics.flagged.length > 0) status = "partial"; // graceful degradation, not silence

    // News (Day 8/9) — never let a news failure block the email.
    const news = await fetchNews(holdings, env).catch((e) => {
      console.error("News step failed entirely:", e.message);
      return [];
    });
    topNews = prioritizeNews(news, metrics, 5);

    // AI commentary (Day 10) — never let it block the email either.
    commentary = await writeCommentary(metrics, topNews, env).catch(() => null);

    const html = renderEmail(metrics, topNews, commentary);
    const subject = buildSubject(metrics);
    await sendEmail(html, subject, env);
  } catch (err) {
    status = "failed";
    errorMsg = err.message;
    console.error("Daily job failed:", err);
    await sendFailureAlert(err, env).catch((e) => console.error("Failure alert itself failed to send:", e.message));
  }

  const duration_ms = Date.now() - startedAt;
  await sb
    .insertRows("daily_reports", [
      {
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
    .catch((e) => console.error("Failed to write daily_reports row:", e.message));

  return { status, duration_ms, error: errorMsg, totalValue: metrics?.totalValue ?? null };
}

// Day 13: "send yourself a failure alert if a scheduled run breaks."
async function sendFailureAlert(err, env) {
  const html = `<p>The daily portfolio job failed:</p><pre>${(err.stack || err.message || String(err)).slice(0, 2000)}</pre>`;
  await sendEmail(html, "⚠️ Portfolio Tracker — daily run FAILED", env);
}
