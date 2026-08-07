// Front end: holdings CRUD + read-only valuation view.
// IMPORTANT: this page only ever READS from the `prices` and `fx_rates` caches.
// It never calls the market-data or FX APIs directly (see README: "cache
// prices in the database" is the single most important design decision here).
// The Cloudflare Worker is what refreshes those caches on a schedule.

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const BASE_CURRENCY = window.BASE_CURRENCY || "USD";
const STALE_AFTER_MS = 1000 * 60 * 60 * 24; // stocks/ETFs trade intraday — flag stale after 24h
// Day 12: funds priced once/day (NAV) shouldn't be flagged stale on the same
// clock as an intraday stock quote. A NAV struck yesterday afternoon is still
// "today's price" from the fund's point of view, and a long weekend or a
// market holiday can easily put 60+ hours between two genuine NAV strikes.
// NOTE: Twelve Data's free tier doesn't expose true once-daily mutual-fund
// NAV as a distinct endpoint — "fund" here still reads the same quote
// endpoint as everything else, just interpreted with a more lenient clock.
const FUND_STALE_AFTER_MS = 1000 * 60 * 60 * 84; // 3.5 days

const fmtMoney = (n) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString(undefined, { style: "currency", currency: BASE_CURRENCY, maximumFractionDigits: 2 });
// Format in whatever currency the holding was actually bought in (e.g. the
// "Buy Price" column), rather than converting to the base currency — this is
// what the user typed in, so show it back to them as-is.
const fmtMoneyIn = (n, currency) =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString(undefined, { style: "currency", currency: currency || BASE_CURRENCY, maximumFractionDigits: 2 });
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

  const isFund = holding.asset_type === "fund";
  const staleThreshold = isFund ? FUND_STALE_AFTER_MS : STALE_AFTER_MS;
  const isStale =
    !priceRow ||
    priceRow.is_stale ||
    Date.now() - new Date(priceRow.as_of).getTime() > staleThreshold;

  return { currentValue, gainAbs, gainPct, dayChangePct, priceInBase, isStale, isFund, priceRow };
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

  // Keep the raw holding rows around so the Edit button can look one up by id
  // without a round trip — cheap since this is already the full list.
  window.__holdingsById = Object.fromEntries(holdings.map((h) => [h.id, h]));

  tbody.innerHTML = rows
    .map(({ h, currentValue, gainPct, dayChangePct, priceInBase, isStale, isFund }) => `
    <tr>
      <td>${h.ticker}</td>
      <td>${h.asset_type}</td>
      <td>${h.quantity}</td>
      <td>${fmtMoneyIn(h.buy_price, h.buy_currency)}</td>
      <td>${priceInBase != null ? fmtMoney(priceInBase) : "—"}${isFund ? '<span class="nav-tag">NAV</span>' : ""}${isStale ? '<span class="stale">stale</span>' : ""}</td>
      <td>${fmtMoney(currentValue)}</td>
      <td class="${pctClass(dayChangePct)}">${fmtPct(dayChangePct)}</td>
      <td class="${pctClass(gainPct)}">${fmtPct(gainPct)}</td>
      <td>${totalValue ? fmtPct((currentValue / totalValue) * 100).replace("+", "") : "—"}</td>
      <td>
        <button class="sell-btn" data-id="${h.id}">Sell</button>
        <button class="edit-btn" data-id="${h.id}">Edit</button>
        <button class="del-btn" data-id="${h.id}">Delete</button>
      </td>
    </tr>`)
    .join("");

  tbody.querySelectorAll(".del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this holding? This does NOT record a sale — use \"Sell\" instead if you actually disposed of it.")) return;
      await sb.from("holdings").delete().eq("id", btn.dataset.id);
      loadHoldings();
    })
  );

  tbody.querySelectorAll(".edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => startEdit(window.__holdingsById[btn.dataset.id]))
  );

  tbody.querySelectorAll(".sell-btn").forEach((btn) =>
    btn.addEventListener("click", () => startSell(window.__holdingsById[btn.dataset.id]))
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

// Day 13: "a visible log of recent runs (status, duration, errors)." The
// Worker's /status endpoint already returns this; this just gives it a face
// on the dashboard, scoped to the signed-in user's own runs via RLS.
async function loadRecentRuns() {
  const tbody = document.getElementById("recentRunsBody");
  const { data, error } = await sb
    .from("daily_reports")
    .select("report_date, status, duration_ms, total_value, error")
    .order("report_date", { ascending: false })
    .limit(10);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5">Could not load run history: ${error.message}</td></tr>`;
    return;
  }
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5">No runs yet — the scheduled Worker hasn't run for this account.</td></tr>`;
    return;
  }

  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td>${new Date(r.report_date).toLocaleDateString()}</td>
      <td class="${r.status === "sent" ? "positive" : r.status === "failed" ? "negative" : ""}">${r.status}</td>
      <td>${r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
      <td>${fmtMoney(r.total_value)}</td>
      <td>${r.error ? `<span class="negative">${r.error}</span>` : "—"}</td>
    </tr>`
    )
    .join("");
}

function resetSummary() {
  document.getElementById("totalValue").textContent = "—";
  document.getElementById("dayChange").textContent = "—";
  document.getElementById("totalGain").textContent = "—";
}

// Chart of real portfolio value over time — backfilled once from actual
// historical closing prices since each holding's buy_date, then appended to
// daily by the scheduled Worker. See worker/src/lib/history.js.
async function loadValueHistory() {
  const svg = document.getElementById("valueChart");
  const caption = document.getElementById("chartCaption");
  const { data, error } = await sb
    .from("portfolio_value_history")
    .select("date, total_value")
    .order("date", { ascending: true });

  if (error) {
    svg.innerHTML = "";
    caption.textContent = `Could not load history: ${error.message}`;
    return;
  }
  if (!data || data.length === 0) {
    svg.innerHTML = "";
    caption.textContent = "No history yet — visit <WORKER_URL>/backfill-history once to seed it from real historical prices, or check back after a few scheduled runs.";
    return;
  }

  renderValueChart(svg, data);
  const first = data[0];
  const last = data[data.length - 1];
  caption.textContent = `${new Date(first.date).toLocaleDateString()} – ${new Date(last.date).toLocaleDateString()} · ${data.length} day${data.length === 1 ? "" : "s"} of history`;
}

// Cap how many points get plotted — a long backfill can produce hundreds of
// daily rows, and plotting every single one makes the line look noisy/jagged
// without adding real information at typical chart widths. Downsampling
// picks evenly-spaced actual data points (never invented ones) and always
// keeps the first and last.
function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const result = [];
  for (let i = 0; i < maxPoints; i++) result.push(points[Math.round(i * step)]);
  return result;
}

// Catmull-Rom-to-Bezier spline through the exact plotted points — this only
// changes how the line is DRAWN between real data points (a smooth curve
// instead of sharp straight-line joints), it never alters or invents a
// value. Every vertex on the curve is still a real, exact data point.
function smoothPath(pts) {
  if (pts.length < 3) return `M ${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")}`;
  let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderValueChart(svg, rawPoints) {
  const points = downsample(rawPoints, 90);
  const width = 700;
  const height = 260; // taller than before — a wide-but-short chart is what made it look "stretched"
  const padX = 12;
  const padY = 30;

  const values = points.map((p) => p.total_value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1; // flat line (or single point): avoid divide-by-zero

  const xAt = (i) => (points.length === 1 ? width / 2 : padX + (i * (width - 2 * padX)) / (points.length - 1));
  const yAt = (v) => padY + (1 - (v - min) / range) * (height - 2 * padY);
  const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(p.total_value) }));

  const linePath = smoothPath(coords);
  const floorY = (height - padY).toFixed(1);
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)},${floorY} L ${coords[0].x.toFixed(1)},${floorY} Z`;

  const trendUp = values[values.length - 1] >= values[0];
  const stroke = trendUp ? "#3ddc97" : "#ff6b6b";

  // Dashed reference lines at 25/50/75% of the visible range, each labelled —
  // gives the eye something to measure against instead of just two numbers
  // floating at the top/bottom corners.
  const gridLines = [0.25, 0.5, 0.75]
    .map((f) => {
      const gy = padY + f * (height - 2 * padY);
      const val = max - f * range;
      const label = fmtMoney(val);
      // Rough monospace-ish width estimate so the backing pill fits the text —
      // good enough for a currency string, doesn't need to be exact.
      const labelWidth = label.length * 6.2 + 8;
      const boxX = width - padX - labelWidth;
      return `<line x1="${padX}" y1="${gy.toFixed(1)}" x2="${width - padX}" y2="${gy.toFixed(1)}" stroke="#2a2e3a" stroke-width="1" stroke-dasharray="3,4"></line>
        <rect x="${boxX.toFixed(1)}" y="${(gy - 15).toFixed(1)}" width="${labelWidth.toFixed(1)}" height="15" fill="#171a21" fill-opacity="0.9" rx="3"></rect>
        <text x="${(width - padX - 4).toFixed(1)}" y="${(gy - 4).toFixed(1)}" fill="#9aa0ac" font-size="10" text-anchor="end">${label}</text>`;
    })
    .join("");

  const maxLabel = fmtMoney(max);
  const minLabel = fmtMoney(min);
  const maxLabelWidth = maxLabel.length * 6.5 + 8;
  const minLabelWidth = minLabel.length * 6.5 + 8;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    ${gridLines}
    <path d="${areaPath}" fill="${stroke}" fill-opacity="0.12" stroke="none"></path>
    <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <rect x="${(padX - 4).toFixed(1)}" y="4" width="${maxLabelWidth.toFixed(1)}" height="16" fill="#171a21" fill-opacity="0.9" rx="3"></rect>
    <text x="${padX}" y="16" fill="#9aa0ac" font-size="11">${maxLabel}</text>
    <rect x="${(padX - 4).toFixed(1)}" y="${height - 22}" width="${minLabelWidth.toFixed(1)}" height="16" fill="#171a21" fill-opacity="0.9" rx="3"></rect>
    <text x="${padX}" y="${height - 8}" fill="#9aa0ac" font-size="11">${minLabel}</text>
  `;
}

// Editing (Section 11 "Could": edit, not just delete) reuses the add-holding
// form rather than a separate inline editor — flip a mode flag, prefill the
// fields, and branch the submit handler between insert and update.
let editingHoldingId = null;

function startEdit(h) {
  if (!h) return;
  editingHoldingId = h.id;
  const form = document.getElementById("holdingForm");
  form.ticker.value = h.ticker;
  form.asset_type.value = h.asset_type;
  form.quantity.value = h.quantity;
  form.buy_price.value = h.buy_price;
  form.buy_currency.value = h.buy_currency;
  form.buy_date.value = h.buy_date;
  document.getElementById("holdingFormTitle").textContent = `Edit ${h.ticker}`;
  document.getElementById("formSubmitBtn").textContent = "Save changes";
  document.getElementById("cancelEditBtn").style.display = "";
  document.getElementById("tickerInput").focus();
}

function stopEdit() {
  editingHoldingId = null;
  document.getElementById("holdingFormTitle").textContent = "Add a holding";
  document.getElementById("formSubmitBtn").textContent = "Add holding";
  document.getElementById("cancelEditBtn").style.display = "none";
}

document.getElementById("cancelEditBtn").addEventListener("click", () => {
  stopEdit();
  document.getElementById("holdingForm").reset();
  setDateToToday();
});

// --- Realized gains: selling records a closed position instead of just
// discarding the holding (distinct from Delete, which is for fixing a
// mistaken entry, not recording a real disposal). Supports partial sells —
// selling less than the full quantity reduces the holding rather than
// removing it.
let sellingHolding = null;

function startSell(h) {
  if (!h) return;
  sellingHolding = h;
  document.getElementById("sellTicker").textContent = h.ticker;
  document.getElementById("sellQuantityInput").max = h.quantity;
  document.getElementById("sellQuantityInput").value = h.quantity;
  document.getElementById("sellCurrencySelect").value = h.buy_currency;
  document.getElementById("sellDateInput").value = new Date().toISOString().slice(0, 10);
  document.getElementById("sellError").textContent = "";
  document.getElementById("sellSection").style.display = "";
  document.getElementById("sellSection").scrollIntoView({ behavior: "smooth", block: "center" });
}

function stopSell() {
  sellingHolding = null;
  document.getElementById("sellSection").style.display = "none";
  document.getElementById("sellForm").reset();
}

document.getElementById("cancelSellBtn").addEventListener("click", stopSell);

document.getElementById("sellForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("sellError");
  errEl.textContent = "";
  if (!sellingHolding || !currentUserId) {
    errEl.textContent = "Nothing selected to sell.";
    return;
  }

  const form = new FormData(e.target);
  const sellQuantity = Number(form.get("sell_quantity"));
  const sellPrice = Number(form.get("sell_price"));
  const sellCurrency = form.get("sell_currency");
  const sellDate = form.get("sell_date");

  if (!(sellQuantity > 0)) return (errEl.textContent = "Quantity must be positive.");
  if (sellQuantity > sellingHolding.quantity) return (errEl.textContent = `Can't sell more than the ${sellingHolding.quantity} you hold.`);
  if (!(sellPrice > 0)) return (errEl.textContent = "Sell price must be positive.");

  // Known limitation (documented in schema.sql/README): the buy side is
  // converted at whatever FX rate is cached right now, not the rate on
  // buy_date — same simplification the live unrealised-gain figures use.
  const fxRates = await fetchLatestFx([sellingHolding.buy_currency, sellCurrency]).catch(() => ({ [BASE_CURRENCY]: 1 }));
  const buyFx = fxRates[sellingHolding.buy_currency] ?? null;
  const sellFx = fxRates[sellCurrency] ?? null;

  // fxRates[currency] is "1 unit of that currency, expressed in base
  // currency" (see fetchLatestFx above) — so converting TO base means
  // multiplying, same as computeRow()'s priceInBase = price * fx.
  let realizedGainAbs = null;
  let realizedGainPct = null;
  if (buyFx && sellFx) {
    const buyValueBase = sellQuantity * sellingHolding.buy_price * buyFx;
    const sellValueBase = sellQuantity * sellPrice * sellFx;
    realizedGainAbs = sellValueBase - buyValueBase;
    realizedGainPct = buyValueBase ? (realizedGainAbs / buyValueBase) * 100 : null;
  }

  const { error: insertError } = await sb.from("realized_gains").insert({
    user_id: currentUserId,
    ticker: sellingHolding.ticker,
    asset_type: sellingHolding.asset_type,
    quantity: sellQuantity,
    buy_price: sellingHolding.buy_price,
    buy_currency: sellingHolding.buy_currency,
    buy_date: sellingHolding.buy_date,
    sell_price: sellPrice,
    sell_currency: sellCurrency,
    sell_date: sellDate,
    base_currency: BASE_CURRENCY,
    realized_gain_abs: realizedGainAbs,
    realized_gain_pct: realizedGainPct,
  });
  if (insertError) {
    errEl.textContent = `Could not record sale: ${insertError.message}`;
    return;
  }

  // Full sell removes the holding; partial sell just reduces its quantity.
  if (sellQuantity >= sellingHolding.quantity) {
    await sb.from("holdings").delete().eq("id", sellingHolding.id);
  } else {
    await sb
      .from("holdings")
      .update({ quantity: sellingHolding.quantity - sellQuantity })
      .eq("id", sellingHolding.id);
  }

  stopSell();
  loadHoldings();
  loadRealizedGains();
});

// Day 11-style "Could" addition: a record of every closed position, not just
// what you currently hold.
async function loadRealizedGains() {
  const tbody = document.getElementById("realizedGainsBody");
  const { data, error } = await sb
    .from("realized_gains")
    .select("*")
    .order("sell_date", { ascending: false });

  const totalEl = document.getElementById("totalRealizedGain");

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6">Could not load realized gains: ${error.message}</td></tr>`;
    totalEl.textContent = "—";
    return;
  }
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">No closed positions yet — use "Sell" on a holding to record one.</td></tr>`;
    totalEl.textContent = fmtMoney(0);
    totalEl.className = "value";
    return;
  }

  // Running total across every closed position — "how much am I up from
  // sales", distinct from the unrealised gain/loss stat (which only covers
  // what's still held).
  const totalRealized = data.reduce((s, r) => s + (r.realized_gain_abs || 0), 0);
  totalEl.textContent = fmtMoney(totalRealized);
  totalEl.className = "value " + pctClass(totalRealized);

  tbody.innerHTML = data
    .map(
      (r) => `
    <tr>
      <td>${r.ticker}</td>
      <td>${r.quantity}</td>
      <td>${fmtMoneyIn(r.buy_price, r.buy_currency)}</td>
      <td>${fmtMoneyIn(r.sell_price, r.sell_currency)}</td>
      <td>${new Date(r.sell_date).toLocaleDateString()}</td>
      <td class="${pctClass(r.realized_gain_abs)}">${r.realized_gain_abs != null ? fmtMoney(r.realized_gain_abs) : "—"}${r.realized_gain_pct != null ? ` (${fmtPct(r.realized_gain_pct)})` : ""}</td>
    </tr>`
    )
    .join("");
}

document.getElementById("holdingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  errEl.textContent = "";
  if (!currentUserId) {
    errEl.textContent = "Not signed in — please sign in again.";
    return;
  }
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

  if (editingHoldingId) {
    const { error } = await sb.from("holdings").update(payload).eq("id", editingHoldingId);
    if (error) {
      errEl.textContent = `Could not save changes: ${error.message}`;
      return;
    }
    stopEdit();
    e.target.reset();
    setDateToToday();
    loadHoldings();
    await triggerPriceRefresh(); // ticker may have changed
    loadHoldings();
    return;
  }

  payload.user_id = currentUserId; // required by RLS: with check (auth.uid() = user_id)
  const { error } = await sb.from("holdings").insert(payload);
  if (error) {
    errEl.textContent = `Could not save: ${error.message}`;
    return;
  }
  e.target.reset();
  setDateToToday(); // form.reset() clears the date field back to blank — refill it
  loadHoldings(); // show the new row immediately (price will say "no data" until the refresh below lands)
  await triggerPriceRefresh();
  loadHoldings(); // reload once the Worker has cached a price for the new ticker
});

// Default the buy-date field to today so adding a holding usually needs zero
// typing in that field — click the calendar icon only if you bought it on a
// different day. The "Today" button resets it back if you've changed it.
function setDateToToday() {
  const input = document.getElementById("buyDateInput");
  if (input) input.value = new Date().toISOString().slice(0, 10);
}
document.getElementById("todayBtn").addEventListener("click", setDateToToday);

// Ask the Worker to fetch+cache a price for anything missing (like a
// just-added holding) without waiting for tomorrow's scheduled run. This is
// a cache-only refresh — no email gets sent — and the Worker throttles it
// server-side so repeated clicks don't burn through the market-data rate limit.
async function triggerPriceRefresh() {
  if (!window.WORKER_URL) return;
  try {
    const res = await fetch(`${window.WORKER_URL}/refresh-prices`);
    if (!res.ok) {
      console.warn(`Price refresh request failed: HTTP ${res.status} (check WORKER_URL in config.js is correct)`);
      return;
    }
    const result = await res.json();
    if (result.skipped) console.log("Price refresh skipped:", result.reason);
    if (result.error) console.warn("Price refresh failed:", result.error);
  } catch (err) {
    console.warn("Could not reach the Worker to refresh prices:", err.message);
  }
}

// --- Login gate ---
// Intentional deviation from the assignment brief (Section 2: "single
// portfolio, no login, keep it simple") — this is a full multi-user app now,
// each person with their own portfolio, added on request. Real enforcement
// happens via Supabase RLS policies scoped to auth.uid() = user_id (see
// schema.sql), not just this UI toggle — the anon key is public, so a
// client-side-only gate would be trivial to bypass otherwise.
let currentUserId = null; // set from whichever auth call succeeds — never re-fetched separately

function showApp(user) {
  currentUserId = user.id;
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("appContent").style.display = "";
  setDateToToday();
  loadHoldings();
  loadValueHistory();
  loadRecentRuns();
  loadRealizedGains();
  if (!window.__pollingStarted) {
    window.__pollingStarted = true;
    setInterval(() => {
      loadHoldings();
      loadValueHistory();
      loadRecentRuns();
      loadRealizedGains();
    }, 5 * 60 * 1000); // refresh the view every 5 min from cache (not the API)
  }
}

function showLogin() {
  currentUserId = null;
  document.getElementById("appContent").style.display = "none";
  document.getElementById("loginSection").style.display = "";
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginError");
  const hintEl = document.getElementById("loginHint");
  errEl.textContent = "";
  hintEl.textContent = "";

  const form = new FormData(e.target);
  const email = form.get("email");
  const password = form.get("password");
  const action = e.submitter?.value || form.get("action"); // which button was clicked

  if (action === "signup") {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) {
      errEl.textContent = error.message;
      return;
    }
    if (data.session) {
      // Email confirmation is off in this project's Auth settings — signed in right away.
      showApp(data.user);
    } else {
      // Email confirmation is on — Supabase created the account but won't issue a
      // session until the confirmation link is clicked.
      hintEl.textContent = "Account created — check your email to confirm it, then sign in above.";
    }
    return;
  }

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message;
    return;
  }
  showApp(data.user);
});

document.getElementById("signOutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  showLogin();
});

// On load, pick up an existing session (Supabase persists it in
// localStorage) so you're not asked to log in again on every visit.
sb.auth.getSession().then(({ data: { session } }) => {
  if (session) showApp(session.user);
  else showLogin();
});
