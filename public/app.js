// Front end: holdings CRUD + read-only valuation view.
// IMPORTANT: this page only ever READS from the `prices` and `fx_rates` caches.
// It never calls the market-data or FX APIs directly (see README: "cache
// prices in the database" is the single most important design decision here).
// The Cloudflare Worker is what refreshes those caches on a schedule.

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const BASE_CURRENCY = window.BASE_CURRENCY || "USD";
const STALE_AFTER_MS = 1000 * 60 * 60 * 24; // flag a price as stale if older than 24h

const fmtMoney = (n) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString(undefined, { style: "currency", currency: BASE_CURRENCY, maximumFractionDigits: 2 });
const fmtPct = (n) => (n == null || Number.isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const pctClass = (n) => (n == null || Number.isNaN(n) ? "" : n >= 0 ? "positive" : "negative");

async function fetchLatestPrices(tickers) {
  if (tickers.length === 0) return {};
  const { data, error } = await sb
    .from("prices")
    .select("*")
    .in("ticker", tickers)
    .order("as_of", { ascending: false });
  if (error) throw error;
  const latest = {};
  for (const row of data) if (!latest[row.ticker]) latest[row.ticker] = row; // first = most recent
  return latest;
}

async function fetchLatestFx(currencies) {
  const needed = currencies.filter((c) => c !== BASE_CURRENCY);
  const rates = { [BASE_CURRENCY]: 1 };
  if (needed.length === 0) return rates;
  const { data, error } = await sb
    .from("fx_rates")
    .select("*")
    .eq("base", BASE_CURRENCY)
    .in("quote", needed)
    .order("as_of", { ascending: false });
  if (error) throw error;
  for (const row of data) {
    // fx_rates stores BASE->quote; we need quote->BASE, so invert.
    if (!(row.quote in rates)) rates[row.quote] = 1 / row.rate;
  }
  return rates;
}

function computeRow(holding, priceRow, fxRates) {
  const fx = fxRates[priceRow?.currency] ?? null;
  const priceInBase = priceRow && fx ? priceRow.price * fx : null;
  const buyFx = fxRates[holding.buy_currency] ?? null;
  const costBasis = buyFx ? holding.quantity * holding.buy_price * buyFx : null;
  const currentValue = priceInBase != null ? holding.quantity * priceInBase : null;
  const gainAbs = currentValue != null && costBasis != null ? currentValue - costBasis : null;
  const gainPct = gainAbs != null && costBasis ? (gainAbs / costBasis) * 100 : null;

  let dayChangePct = null;
  if (priceRow?.previous_close) {
    dayChangePct = ((priceRow.price - priceRow.previous_close) / priceRow.previous_close) * 100;
  }

  const isStale =
    !priceRow ||
    priceRow.is_stale ||
    Date.now() - new Date(priceRow.as_of).getTime() > STALE_AFTER_MS;

  return { currentValue, gainAbs, gainPct, dayChangePct, priceInBase, isStale, priceRow };
}

async function loadHoldings() {
  const tbody = document.getElementById("holdingsBody");
  const { data: holdings, error } = await sb.from("holdings").select("*").order("created_at");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="10">Failed to load holdings: ${error.message}</td></tr>`;
    return;
  }
  if (holdings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10">No holdings yet — add one below.</td></tr>`;
    resetSummary();
    return;
  }

  const tickers = [...new Set(holdings.map((h) => h.ticker))];
  const currencies = [...new Set(holdings.flatMap((h) => [h.buy_currency]))];
  const [prices, fxRates] = await Promise.all([
    fetchLatestPrices(tickers).catch(() => ({})),
    fetchLatestFx(currencies).catch(() => ({ [BASE_CURRENCY]: 1 })),
  ]);
  // also need FX for whatever currency prices come back in
  const priceCurrencies = Object.values(prices).map((p) => p.currency);
  const missing = priceCurrencies.filter((c) => !(c in fxRates));
  if (missing.length) Object.assign(fxRates, await fetchLatestFx(missing).catch(() => ({})));

  const rows = holdings.map((h) => ({ h, ...computeRow(h, prices[h.ticker], fxRates) }));
  const totalValue = rows.reduce((s, r) => s + (r.currentValue || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.gainAbs != null && r.currentValue != null ? r.currentValue - r.gainAbs : 0), 0);
  const totalGainAbs = totalValue - totalCost;
  const totalGainPct = totalCost ? (totalGainAbs / totalCost) * 100 : null;
  const weightedDayChange = rows.reduce((s, r) => {
    if (r.dayChangePct == null || r.currentValue == null || !totalValue) return s;
    return s + r.dayChangePct * (r.currentValue / totalValue);
  }, 0);

  document.getElementById("totalValue").textContent = fmtMoney(totalValue);
  const dayChangeEl = document.getElementById("dayChange");
  dayChangeEl.textContent = fmtPct(weightedDayChange);
  dayChangeEl.className = "value " + pctClass(weightedDayChange);
  const gainEl = document.getElementById("totalGain");
  gainEl.textContent = `${fmtMoney(totalGainAbs)} (${fmtPct(totalGainPct)})`;
  gainEl.className = "value " + pctClass(totalGainAbs);

  const latestAsOf = Object.values(prices).map((p) => new Date(p.as_of)).sort((a, b) => b - a)[0];
  document.getElementById("asOfLabel").textContent = latestAsOf
    ? `Prices as of: ${latestAsOf.toLocaleString()}`
    : "Prices as of: no data yet — run the Worker or wait for the next schedule";
  document.getElementById("baseCcyLabel").textContent = BASE_CURRENCY;

  renderAllocation(rows, totalValue);

  tbody.innerHTML = rows
    .map(({ h, currentValue, gainPct, dayChangePct, priceInBase, isStale }) => `
    <tr>
      <td>${h.ticker}</td>
      <td>${h.asset_type}</td>
      <td>${h.quantity}</td>
      <td>${priceInBase != null ? fmtMoney(priceInBase) : "—"}${isStale ? '<span class="stale">stale</span>' : ""}</td>
      <td>${fmtMoney(currentValue)}</td>
      <td class="${pctClass(dayChangePct)}">${fmtPct(dayChangePct)}</td>
      <td class="${pctClass(gainPct)}">${fmtPct(gainPct)}</td>
      <td>${totalValue ? fmtPct((currentValue / totalValue) * 100).replace("+", "") : "—"}</td>
      <td>${priceInBase != null ? "cached" : "no data"}</td>
      <td><button class="del-btn" data-id="${h.id}">Delete</button></td>
    </tr>`)
    .join("");

  tbody.querySelectorAll(".del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this holding?")) return;
      await sb.from("holdings").delete().eq("id", btn.dataset.id);
      loadHoldings();
    })
  );
}

function renderAllocation(rows, totalValue) {
  const byType = {};
  const byCurrency = {};
  for (const { h, currentValue } of rows) {
    if (!currentValue) continue;
    byType[h.asset_type] = (byType[h.asset_type] || 0) + currentValue;
    byCurrency[h.buy_currency] = (byCurrency[h.buy_currency] || 0) + currentValue;
  }
  const renderList = (el, map) => {
    el.innerHTML = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<li><span>${k}</span><span>${fmtMoney(v)} (${((v / totalValue) * 100).toFixed(1)}%)</span></li>`)
      .join("") || "<li>No data</li>";
  };
  renderList(document.getElementById("allocByType"), byType);
  renderList(document.getElementById("allocByCurrency"), byCurrency);
}

function resetSummary() {
  document.getElementById("totalValue").textContent = "—";
  document.getElementById("dayChange").textContent = "—";
  document.getElementById("totalGain").textContent = "—";
}

document.getElementById("holdingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  errEl.textContent = "";
  const form = new FormData(e.target);
  const payload = {
    ticker: form.get("ticker").trim().toUpperCase(),
    asset_type: form.get("asset_type"),
    quantity: Number(form.get("quantity")),
    buy_price: Number(form.get("buy_price")),
    buy_currency: form.get("buy_currency"),
    buy_date: form.get("buy_date"),
  };
  if (!payload.ticker) return (errEl.textContent = "Ticker is required.");
  if (!(payload.quantity > 0)) return (errEl.textContent = "Quantity must be positive.");
  if (!(payload.buy_price > 0)) return (errEl.textContent = "Buy price must be positive.");

  const { error } = await sb.from("holdings").insert(payload);
  if (error) {
    errEl.textContent = `Could not save: ${error.message}`;
    return;
  }
  e.target.reset();
  loadHoldings();
});

loadHoldings();
setInterval(loadHoldings, 5 * 60 * 1000); // refresh the view every 5 min from cache (not the API)
