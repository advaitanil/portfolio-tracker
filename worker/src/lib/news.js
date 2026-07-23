// News provider: Marketaux (~100 requests/day free, entity tagging across
// 80+ markets — see README "Provider choice").
import { withRetry } from "./retry.js";

export async function fetchNews(holdings, env) {
  const symbols = [...new Set(holdings.map((h) => h.ticker))].join(",");
  if (!symbols) return [];

  const url = `https://api.marketaux.com/v1/news/all?symbols=${symbols}&filter_entities=true&language=en&limit=20&api_token=${env.MARKETAUX_API_KEY}`;

  const data = await withRetry(
    async () => {
      const res = await fetch(url);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "Marketaux error");
      return json;
    },
    { label: "fetchNews", retries: 2 }
  ).catch((err) => {
    // Day 9: "if the news API fails, send the email anyway without the news block."
    console.error("fetchNews failed — email will send with no news section:", err.message);
    return null;
  });

  if (!data?.data) return [];

  // Dedup: the same story is often tagged against several holdings, and wire
  // stories get syndicated near-verbatim across outlets. Key on normalized
  // title + source.
  const seen = new Set();
  const deduped = [];
  for (const item of data.data) {
    const key = `${(item.title || "").trim().toLowerCase()}|${item.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      title: item.title,
      source: item.source,
      url: item.url,
      published_at: item.published_at,
      tickers: (item.entities || []).map((e) => e.symbol).filter(Boolean),
    });
  }
  return deduped;
}

// Prioritise headlines about the day's biggest movers (Day 9), return top N.
export function prioritizeNews(news, portfolioMetrics, limit = 5) {
  const moveByTicker = {};
  for (const h of portfolioMetrics.holdings) {
    if (h.dayChangePct != null) moveByTicker[h.ticker] = Math.abs(h.dayChangePct);
  }
  return [...news]
    .sort((a, b) => {
      const scoreA = a.tickers.length ? Math.max(...a.tickers.map((t) => moveByTicker[t] || 0)) : 0;
      const scoreB = b.tickers.length ? Math.max(...b.tickers.map((t) => moveByTicker[t] || 0)) : 0;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}
