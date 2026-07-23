// FX provider: Frankfurter (see README "Provider choice") — free, no API key,
// ECB reference rates. Returns { QUOTE: rate } meaning "1 baseCurrency = rate QUOTE".
import { withRetry } from "./retry.js";

export async function fetchFxRates(baseCurrency, quoteCurrencies) {
  const quotes = [...new Set(quoteCurrencies)].filter((c) => c && c !== baseCurrency);
  if (quotes.length === 0) return {};

  const url = `https://api.frankfurter.app/latest?from=${baseCurrency}&to=${quotes.join(",")}`;
  const data = await withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
      return res.json();
    },
    { label: "fetchFxRates", retries: 3 }
  ).catch((err) => {
    console.error("fetchFxRates failed — currency conversion for non-base holdings will be flagged missing_fx_rate:", err.message);
    return null;
  });

  return data?.rates || {};
}
