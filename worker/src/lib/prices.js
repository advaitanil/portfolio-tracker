// Market data provider: Twelve Data (see README section "Provider choice").
// Free tier: 800 calls/day, US + forex + crypto free. We batch every ticker
// into ONE call per run (Twelve Data supports comma-separated symbols) so a
// once-a-day schedule costs a single call, not one per holding.
import { withRetry } from "./retry.js";

const TWELVE_DATA_BASE = "https://api.twelvedata.com";

// Return shape: { results, batchFailed }. batchFailed distinguishes "the
// whole Twelve Data call errored out" (rate limit, bad API key, network
// blip — nothing here is trustworthy) from "this one ticker has no data"
// (delisted/typo — every OTHER ticker's price is still fine). Callers use
// batchFailed to decide whether it's safe to cache these results: writing a
// batch-failure result into the append-only prices table would flag every
// holding as stale and shadow the last GOOD cached price, since readers
// always take the most recent row per ticker (see Day 20 bug: "Run now"
// hit a Twelve Data failure and every holding went stale/$0 as a result).
export async function fetchPrices(tickers, env) {
  const unique = [...new Set(tickers)];
  const results = {};
  if (unique.length === 0) return { results, batchFailed: false };

  const url = `${TWELVE_DATA_BASE}/quote?symbol=${unique.join(",")}&apikey=${env.TWELVE_DATA_API_KEY}`;

  const data = await withRetry(
    async () => {
      const res = await fetch(url);
      const json = await res.json();
      // Twelve Data returns HTTP 200 with a {status:"error"} body on failure.
      if (json?.status === "error") throw new Error(json.message || "Twelve Data error");
      return json;
    },
    { label: "fetchPrices", retries: 3 }
  ).catch((err) => {
    console.error("fetchPrices failed entirely — every holding will be flagged stale:", err.message);
    return null;
  });

  const batchFailed = data === null;

  // Single symbol -> one flat object. Multiple symbols -> {SYMBOL: {...}, ...}.
  const normalized = data && unique.length === 1 && !data[unique[0]] ? { [unique[0]]: data } : data;

  for (const ticker of unique) {
    const q = normalized?.[ticker];
    if (!q || q.code >= 400 || q.close == null) {
      // Day 3 requirement: handle an unknown/delisted ticker without crashing.
      results[ticker] = {
        ticker,
        price: null,
        previous_close: null,
        currency: null,
        source: "twelvedata",
        is_stale: true,
        error: q?.message || "no data returned for ticker",
      };
      continue;
    }
    results[ticker] = {
      ticker,
      price: Number(q.close),
      previous_close: q.previous_close != null ? Number(q.previous_close) : null,
      currency: q.currency || "USD",
      source: "twelvedata",
      is_stale: false,
      error: null,
    };
  }
  return { results, batchFailed };
}
