// The heart of the project (Day 4). Every number here should be hand-verified
// against a calculator for at least 3 holdings before you trust it — see
// README "Verifying the maths".
//
// fxRates* shape: { QUOTE_CCY: rate } where rate means "1 baseCurrency = rate QUOTE_CCY".
// To convert an amount FROM quote currency INTO base currency: amount / rate.

function toBase(amount, currency, fxRates, baseCurrency) {
  if (amount == null) return null;
  if (currency === baseCurrency) return amount;
  const rate = fxRates[currency];
  if (!rate) return null;
  return amount / rate;
}

export function computeHoldingMetrics(holding, priceRow, fxRatesToday, fxRatesYesterday, baseCurrency) {
  const flags = [];

  if (!priceRow || priceRow.price == null) {
    return {
      ticker: holding.ticker,
      name: holding.name,
      quantity: holding.quantity,
      error: true,
      flags: ["missing_price"],
      reason: priceRow?.error || "no price available",
      currentValue: null,
      gainAbs: null,
      gainPct: null,
      dayChangePct: null,
    };
  }

  const priceCcy = priceRow.currency;
  const priceInBase = toBase(priceRow.price, priceCcy, fxRatesToday, baseCurrency);
  const buyPriceInBase = toBase(holding.buy_price, holding.buy_currency, fxRatesToday, baseCurrency);

  if (priceInBase == null || buyPriceInBase == null) flags.push("missing_fx_rate");
  if (priceRow.is_stale) flags.push("stale_price");

  const currentValue = priceInBase != null ? holding.quantity * priceInBase : null;
  const costBasis = buyPriceInBase != null ? holding.quantity * buyPriceInBase : null;
  const gainAbs = currentValue != null && costBasis != null ? currentValue - costBasis : null;
  const gainPct = gainAbs != null && costBasis ? (gainAbs / costBasis) * 100 : null;

  // --- Day change, split into price return vs FX return (Day 12) ---
  let priceReturnPct = null;
  let fxReturnPct = null;
  let totalReturnPct = null;
  let dayChangeAbsBase = null;

  if (priceRow.previous_close) {
    priceReturnPct = ((priceRow.price - priceRow.previous_close) / priceRow.previous_close) * 100;

    if (priceCcy === baseCurrency) {
      // No currency to convert — total return IS the price return.
      totalReturnPct = priceReturnPct;
      fxReturnPct = 0;
      dayChangeAbsBase = holding.quantity * (priceRow.price - priceRow.previous_close);
    } else {
      const fxYesterday = fxRatesYesterday?.[priceCcy];
      const fxToday = fxRatesToday[priceCcy];
      if (fxYesterday && fxToday && priceInBase != null) {
        const prevCloseInBaseYesterday = priceRow.previous_close / fxYesterday;
        totalReturnPct = ((priceInBase - prevCloseInBaseYesterday) / prevCloseInBaseYesterday) * 100;
        dayChangeAbsBase = holding.quantity * (priceInBase - prevCloseInBaseYesterday);
        // Base currency strengthening (rate goes up) makes foreign assets
        // worth LESS in base terms, hence the inverted sign here.
        fxReturnPct = ((fxYesterday - fxToday) / fxToday) * 100;
      } else {
        flags.push("missing_fx_history"); // can't split return without yesterday's rate
      }
    }
  } else {
    flags.push("missing_previous_close");
  }

  return {
    ticker: holding.ticker,
    name: holding.name,
    assetType: holding.asset_type,
    quantity: holding.quantity,
    priceInBase,
    currentValue,
    costBasis,
    gainAbs,
    gainPct,
    dayChangePct: totalReturnPct,
    priceReturnPct,
    fxReturnPct,
    dayChangeAbsBase,
    isStale: !!priceRow.is_stale,
    error: false,
    flags,
  };
}

export function computePortfolioMetrics({ holdings, pricesByTicker, fxRatesToday, fxRatesYesterday, baseCurrency }) {
  const rows = holdings.map((h) =>
    computeHoldingMetrics(h, pricesByTicker[h.ticker], fxRatesToday, fxRatesYesterday, baseCurrency)
  );

  const valid = rows.filter((r) => !r.error && r.currentValue != null);
  const totalValue = valid.reduce((s, r) => s + r.currentValue, 0);
  const totalCost = valid.reduce((s, r) => s + (r.costBasis || 0), 0);
  const totalGainAbs = totalValue - totalCost;
  const totalGainPct = totalCost ? (totalGainAbs / totalCost) * 100 : null;

  const totalDayChangeAbs = valid.reduce((s, r) => s + (r.dayChangeAbsBase || 0), 0);
  const yesterdayTotal = totalValue - totalDayChangeAbs;
  const dayChangePct = yesterdayTotal ? (totalDayChangeAbs / yesterdayTotal) * 100 : null;

  for (const r of valid) r.weight = totalValue ? (r.currentValue / totalValue) * 100 : null;

  const movers = valid.filter((r) => r.dayChangePct != null).sort((a, b) => b.dayChangePct - a.dayChangePct);
  const best = movers[0] || null;
  const worst = movers.length ? movers[movers.length - 1] : null;

  const byAssetType = {};
  const byCurrency = {};
  for (const h of holdings) {
    const r = rows.find((x) => x.ticker === h.ticker);
    if (!r || r.currentValue == null) continue;
    byAssetType[h.asset_type] = (byAssetType[h.asset_type] || 0) + r.currentValue;
    byCurrency[h.buy_currency] = (byCurrency[h.buy_currency] || 0) + r.currentValue;
  }

  const flagged = rows.filter((r) => r.error || (r.flags && r.flags.length));

  return {
    baseCurrency,
    asOf: new Date().toISOString(),
    totalValue,
    totalCost,
    totalGainAbs,
    totalGainPct,
    dayChangeAbs: totalDayChangeAbs,
    dayChangePct,
    best,
    worst,
    holdings: rows,
    allocation: { byAssetType, byCurrency },
    flagged,
  };
}
