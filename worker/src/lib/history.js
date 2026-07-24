// Historical backfill for the "portfolio value over time" chart. Unlike the
// rest of the app (which only ever looks at "now"), this reconstructs what
// the portfolio was actually worth on every day since each holding's buy
// date, using REAL historical closing prices and FX rates — not synthetic
// data. It's meant to be run once (via /backfill-history) to seed the chart;
// after that, the daily scheduled job appends one new real point per day.
import { withRetry } from "./retry.js";

// Twelve Data batches multiple symbols into one call (each symbol still
// costs 1 API credit, but it's still a single request) — same pattern as
// prices.js's live quote fetch.
export async function fetchHistoricalPrices(tickers, startDate, env) {
  const unique = [...new Set(tickers)];
  const result = {};
  if (unique.length === 0) return result;

  const endDate = new Date().toISOString().slice(0, 10);
  const url = `https://api.twelvedata.com/time_series?symbol=${unique.join(",")}&interval=1day&start_date=${startDate}&end_date=${endDate}&apikey=${env.TWELVE_DATA_API_KEY}`;

  const data = await withRetry(
    async () => {
      const res = await fetch(url);
      const json = await res.json();
      if (json?.status === "error") throw new Error(json.message || "Twelve Data error");
      return json;
    },
    { label: "fetchHistoricalPrices", retries: 3 }
  ).catch((err) => {
    console.error("fetchHistoricalPrices failed entirely:", err.message);
    return null;
  });

  const normalized = data && unique.length === 1 && !data[unique[0]] ? { [unique[0]]: data } : data;

  for (const ticker of unique) {
    const entry = normalized?.[ticker];
    if (!entry || entry.status === "error" || !Array.isArray(entry.values)) {
      result[ticker] = { currency: null, series: {} };
      continue;
    }
    const series = {};
    // 1day interval returns datetime as 'YYYY-MM-DD', newest first.
    for (const point of entry.values) series[point.datetime] = Number(point.close);
    result[ticker] = { currency: entry.meta?.currency || "USD", series };
  }
  return result;
}

// Frankfurter's range query: /{start}..{end}?from=BASE&to=QUOTE1,QUOTE2
// Returns { rates: { 'YYYY-MM-DD': { QUOTE: rate } } } where rate means
// "1 base = rate quote" — same convention as fx.js's live fetch.
export async function fetchHistoricalFxRange(baseCurrency, quoteCurrencies, startDate) {
  const quotes = [...new Set(quoteCurrencies)].filter((c) => c && c !== baseCurrency);
  if (quotes.length === 0) return {};

  const endDate = new Date().toISOString().slice(0, 10);
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=${baseCurrency}&to=${quotes.join(",")}`;

  const data = await withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
      return res.json();
    },
    { label: "fetchHistoricalFxRange", retries: 3 }
  ).catch((err) => {
    console.error("fetchHistoricalFxRange failed:", err.message);
    return null;
  });

  return data?.rates || {};
}

// Walks day-by-day from the earliest holding's buy_date to today. Markets
// are closed on weekends/holidays, so on any given day we use the most
// recent trading-day price/rate on or before that day (carry-forward) —
// same idea as reading from a cache, just applied retroactively.
export function computeHistoryValues({ holdings, priceHistory, fxHistory, baseCurrency }) {
  if (!holdings.length) return [];

  const priceSorted = {};
  for (const [ticker, { series }] of Object.entries(priceHistory)) {
    priceSorted[ticker] = Object.entries(series).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  const fxSorted = {}; // per quote currency: [ [date, rate], ... ] ascending
  for (const [date, rates] of Object.entries(fxHistory)) {
    for (const [ccy, rate] of Object.entries(rates)) {
      (fxSorted[ccy] ??= []).push([date, rate]);
    }
  }
  for (const ccy in fxSorted) fxSorted[ccy].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const carryForward = (sortedEntries, targetDate) => {
    let result = null;
    for (const [d, v] of sortedEntries) {
      if (d > targetDate) break;
      result = v;
    }
    return result;
  };

  const earliestBuyDate = holdings.reduce((min, h) => (h.buy_date < min ? h.buy_date : min), holdings[0].buy_date);
  const today = new Date().toISOString().slice(0, 10);

  const points = [];
  const cursor = new Date(earliestBuyDate + "T00:00:00Z");
  const end = new Date(today + "T00:00:00Z");

  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    let total = 0;
    let anyPriced = false;

    for (const h of holdings) {
      if (dateStr < h.buy_date) continue; // not owned yet on this date

      const info = priceHistory[h.ticker];
      const price = info ? carryForward(priceSorted[h.ticker] || [], dateStr) : null;
      if (price == null) continue; // no price data this far back for this ticker — skip it for this day

      const ccy = info.currency || baseCurrency;
      let priceInBase = price;
      if (ccy !== baseCurrency) {
        const rate = carryForward(fxSorted[ccy] || [], dateStr);
        if (!rate) continue; // no FX data this far back — skip rather than guess
        priceInBase = price / rate;
      }
      total += h.quantity * priceInBase;
      anyPriced = true;
    }

    if (anyPriced) points.push({ date: dateStr, total_value: Math.round(total * 100) / 100 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}
