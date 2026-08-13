// Front end: holdings CRUD + read-only valuation view.
// IMPORTANT: this page only ever READS from the `prices` and `fx_rates` caches.
// It never calls the market-data or FX APIs directly (see README: "cache
// prices in the database" is the single most important design decision here).
// The Cloudflare Worker is what refreshes those caches on a schedule.

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const BASE_CURRENCY = window.BASE_CURRENCY || "USD";

// Light/dark theme toggle (Day 18). The actual theme is applied by a tiny
// inline script in <head> (runs before first paint, avoids a flash of the
// wrong theme) — this just handles the click and remembers the choice.
// Chart colors (renderValueChart, below) read CSS custom properties via
// inline `style`, not hardcoded hex, so the chart repaints correctly on
// toggle with no extra work needed here.
document.getElementById("themeToggleBtn").addEventListener("click", () => {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
    localStorage.setItem("theme", "light");
  }
});
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

// In-app replacement for prompt()/confirm()/alert() — styled to match the
// dashboard instead of a native browser dialog. Promise-based so call sites
// can just `await showModal(...)` in place of the old synchronous calls.
//   type: "prompt"  -> resolves the trimmed input string, or null if cancelled/empty
//   type: "confirm" -> resolves true/false
//   type: "alert"   -> resolves undefined once dismissed (no Cancel button)
function showModal({ type = "alert", title = "", message = "", placeholder = "", defaultValue = "", danger = false, confirmLabel, cancelLabel = "Cancel" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modalOverlay");
    const titleEl = document.getElementById("modalTitle");
    const messageEl = document.getElementById("modalMessage");
    const inputEl = document.getElementById("modalInput");
    const cancelBtn = document.getElementById("modalCancelBtn");
    const confirmBtn = document.getElementById("modalConfirmBtn");

    titleEl.textContent = title;
    messageEl.textContent = message;
    messageEl.style.display = message ? "" : "none";
    inputEl.style.display = type === "prompt" ? "" : "none";
    inputEl.value = defaultValue;
    inputEl.placeholder = placeholder;
    cancelBtn.style.display = type === "alert" ? "none" : "";
    cancelBtn.textContent = cancelLabel;
    confirmBtn.textContent = confirmLabel || (type === "confirm" ? "Confirm" : type === "prompt" ? "Save" : "OK");
    confirmBtn.className = danger ? "del-btn" : "";

    function cleanup(result) {
      overlay.style.display = "none";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("keydown", onKeydown);
      overlay.removeEventListener("mousedown", onBackdrop);
      resolve(result);
    }
    function onConfirm() {
      cleanup(type === "prompt" ? inputEl.value.trim() || null : true);
    }
    function onCancel() {
      cleanup(type === "prompt" ? null : false);
    }
    function onKeydown(e) {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    }
    function onBackdrop(e) {
      if (e.target === overlay) onCancel();
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("keydown", onKeydown);
    overlay.addEventListener("mousedown", onBackdrop);

    overlay.style.display = "flex";
    if (type === "prompt") {
      inputEl.focus();
      inputEl.select();
    } else {
      confirmBtn.focus();
    }
  });
}

// Attaches the signed-in user's Supabase access token as a Bearer header.
// The Worker now requires this on every route that costs API quota or
// touches user data (Day 19: /refresh-prices, /run, /search-symbols,
// /status used to be wide open to anyone who knew the URL) — see
// worker/src/index.js's getAuthedUser(). If there's no session for some
// reason, this still fires a plain unauthenticated request, which the
// Worker will just reject with 401 rather than silently doing nothing.
async function authedFetch(url, opts = {}) {
  const {
    data: { session },
  } = await sb.auth.getSession();
  const headers = { ...(opts.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  return fetch(url, { ...opts, headers });
}

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

// Historical FX lookup (Day 19): given a list of {currency, date} pairs,
// returns a Map of "currency|date" -> FX rate in effect ON OR BEFORE that
// date (quote->base convention, same as fetchLatestFx). Backed by whatever
// the Worker has cached in fx_rates (see ensureBuyDateFxCoverage in
// worker/src/index.js) — one query total, then an in-memory carry-forward
// scan per pair, same pattern as the Worker's own chart-backfill math.
// Pairs with no cached history yet (not backfilled) simply have no entry —
// callers fall back to the "now" rate exactly like before this feature.
async function fetchHistoricalFxForDates(pairs) {
  const currencies = [...new Set(pairs.map((p) => p.currency).filter((c) => c && c !== BASE_CURRENCY))];
  const result = new Map();
  if (!currencies.length) return result;

  const { data, error } = await sb
    .from("fx_rates")
    .select("quote, rate, as_of")
    .eq("base", BASE_CURRENCY)
    .in("quote", currencies)
    .order("as_of", { ascending: true });
  if (error || !data) return result;

  const byCurrency = {};
  for (const row of data) (byCurrency[row.quote] ??= []).push(row);

  for (const { currency, date } of pairs) {
    if (!currency || currency === BASE_CURRENCY || !date) continue;
    const rows = byCurrency[currency] || [];
    const cutoff = `${date}T23:59:59.999Z`;
    let match = null;
    for (const row of rows) {
      if (row.as_of > cutoff) break; // rows are sorted ascending — stop at the first one past the cutoff
      match = row;
    }
    if (match) result.set(`${currency}|${date}`, 1 / match.rate); // invert: fx_rates stores base->quote, we need quote->base
  }
  return result;
}

function computeRow(holding, priceRow, fxRates, buyFxOverride) {
  const fx = fxRates[priceRow?.currency] ?? null;
  const priceInBase = priceRow && fx ? priceRow.price * fx : null;
  // buyFxOverride, when present, is the ACTUAL rate on this holding's
  // buy_date (see fetchHistoricalFxForDates) — falls back to "now" when no
  // historical rate has been cached for that currency/date yet.
  const buyFx = buyFxOverride ?? fxRates[holding.buy_currency] ?? null;
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
    tbody.innerHTML = `<tr><td colspan="11">Failed to load holdings: ${error.message}</td></tr>`;
    return;
  }
  if (holdings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11">No holdings yet — add one below.</td></tr>`;
    resetSummary();
    return;
  }

  const tickers = [...new Set(holdings.map((h) => h.ticker))];
  const currencies = [...new Set(holdings.flatMap((h) => [h.buy_currency]))];
  const [prices, fxRates, buyFxByHolding] = await Promise.all([
    fetchLatestPrices(tickers).catch(() => ({})),
    fetchLatestFx(currencies).catch(() => ({ [BASE_CURRENCY]: 1 })),
    fetchHistoricalFxForDates(holdings.map((h) => ({ currency: h.buy_currency, date: h.buy_date }))).catch(() => new Map()),
  ]);
  // also need FX for whatever currency prices come back in
  const priceCurrencies = Object.values(prices).map((p) => p.currency);
  const missing = priceCurrencies.filter((c) => !(c in fxRates));
  if (missing.length) Object.assign(fxRates, await fetchLatestFx(missing).catch(() => ({})));

  // Computed over EVERY holding regardless of the portfolio filter — the
  // whole-account total feeds the "All portfolios" chart view below.
  const allRows = holdings.map((h) => ({
    h,
    ...computeRow(h, prices[h.ticker], fxRates, buyFxByHolding.get(`${h.buy_currency}|${h.buy_date}`)),
  }));
  const wholeAccountValue = allRows.reduce((s, r) => s + (r.currentValue || 0), 0);

  // Per-portfolio totals — feeds each portfolio's own chart view. Holdings
  // with no portfolio_id aren't part of any portfolio's series (only the
  // whole-account one above).
  const valueByPortfolio = {};
  for (const r of allRows) {
    if (!r.h.portfolio_id || !r.currentValue) continue;
    valueByPortfolio[r.h.portfolio_id] = (valueByPortfolio[r.h.portfolio_id] || 0) + r.currentValue;
  }

  // Portfolios (Day 15): "All portfolios" shows everything; a specific
  // selection filters down to just that portfolio's holdings for display.
  const rows = selectedPortfolioId === "__all__" ? allRows : allRows.filter((r) => r.h.portfolio_id === selectedPortfolioId);

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

  // Keep today's chart point(s) live: every time we recompute real totals (on
  // load, after add/edit/sell/delete, or the 5-min poll), upsert them so the
  // chart never lags a full day behind — you don't have to wait for
  // tomorrow's scheduled run to see today's add reflected. Writes BOTH the
  // whole-account point (portfolio_value_history) and one point per
  // portfolio (portfolio_history) every time, regardless of which filter is
  // currently selected — so switching the filter afterwards shows an
  // up-to-date chart immediately instead of only the portfolio you happened
  // to be looking at when you last edited something. RLS-scoped (auth.uid()
  // = user_id), safe from the browser with the anon key. Best-effort: a
  // failure here shouldn't block the rest of the dashboard from rendering.
  if (currentUserId) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const upserts = [];
    if (wholeAccountValue > 0) {
      upserts.push(
        sb.from("portfolio_value_history").upsert(
          { user_id: currentUserId, date: todayStr, total_value: wholeAccountValue, base_currency: BASE_CURRENCY, source: "live_update" },
          { onConflict: "user_id,date" }
        )
      );
    }
    for (const [portfolioId, value] of Object.entries(valueByPortfolio)) {
      upserts.push(
        sb.from("portfolio_history").upsert(
          { user_id: currentUserId, portfolio_id: portfolioId, date: todayStr, total_value: value, base_currency: BASE_CURRENCY, source: "live_update" },
          { onConflict: "portfolio_id,date" }
        )
      );
    }
    if (upserts.length) {
      Promise.all(upserts).then((results) => {
        const err = results.find((r) => r.error)?.error;
        if (err) console.warn("Could not update today's chart point:", err.message);
        loadValueHistory();
      });
    }
  }

  lastHoldingsRows = rows;
  lastHoldingsTotalValue = totalValue;
  renderHoldingsTable();
}

// Sort/search (Day 17) operate entirely on the last-computed rows — no
// refetch, since prices/rows are already in memory from loadHoldings above.
let lastHoldingsRows = [];
let lastHoldingsTotalValue = 0;
let holdingsSearchTerm = "";
let holdingsSortColumn = null;
let holdingsSortDirection = 1; // 1 = ascending, -1 = descending

function holdingsSortValue(row, col) {
  const { h, currentValue, gainPct, dayChangePct, priceInBase } = row;
  switch (col) {
    case "ticker":
      return h.ticker;
    case "portfolio":
      return h.portfolio_id ? allPortfolios.find((p) => p.id === h.portfolio_id)?.name || "" : "";
    case "type":
      return h.asset_type;
    case "qty":
      return Number(h.quantity);
    case "buyPrice":
      return Number(h.buy_price);
    case "price":
      return priceInBase;
    case "value":
    case "weight":
      return currentValue;
    case "day":
      return dayChangePct;
    case "gain":
      return gainPct;
    default:
      return null;
  }
}

function renderHoldingsTable() {
  const tbody = document.getElementById("holdingsBody");
  const totalValue = lastHoldingsTotalValue;

  let rows = lastHoldingsRows;
  if (holdingsSearchTerm) {
    const term = holdingsSearchTerm.toLowerCase();
    rows = rows.filter(({ h }) => h.ticker.toLowerCase().includes(term));
  }

  if (rows.length === 0) {
    tbody.innerHTML =
      lastHoldingsRows.length === 0
        ? `<tr><td colspan="11">No holdings in this portfolio — add one below or switch to "All portfolios".</td></tr>`
        : `<tr><td colspan="11">No holdings match "${escapeHtml(holdingsSearchTerm)}".</td></tr>`;
    updateSortIndicators();
    return;
  }

  if (holdingsSortColumn) {
    rows = [...rows].sort((a, b) => {
      const av = holdingsSortValue(a, holdingsSortColumn);
      const bv = holdingsSortValue(b, holdingsSortColumn);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls/missing data always sort last
      if (bv == null) return -1;
      const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return cmp * holdingsSortDirection;
    });
  }

  const portfolioNameById = Object.fromEntries(allPortfolios.map((p) => [p.id, p.name]));

  tbody.innerHTML = rows
    .map(({ h, currentValue, gainPct, dayChangePct, priceInBase, isStale, isFund }) => `
    <tr>
      <td>${h.ticker}</td>
      <td>${h.portfolio_id ? escapeHtml(portfolioNameById[h.portfolio_id] || "—") : '<span class="nav-tag">unassigned</span>'}</td>
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
      const ok = await showModal({
        type: "confirm",
        title: "Delete holding?",
        message: 'This does NOT record a sale — use "Sell" instead if you actually disposed of it.',
        danger: true,
        confirmLabel: "Delete",
      });
      if (!ok) return;
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

  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll("#holdingsTable th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === holdingsSortColumn);
    const existingArrow = th.querySelector(".sort-arrow");
    if (existingArrow) existingArrow.remove();
    if (th.dataset.sort === holdingsSortColumn) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = holdingsSortDirection === 1 ? "▲" : "▼";
      th.appendChild(arrow);
    }
  });
}

document.querySelectorAll("#holdingsTable th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (holdingsSortColumn === col) holdingsSortDirection *= -1;
    else {
      holdingsSortColumn = col;
      holdingsSortDirection = 1;
    }
    renderHoldingsTable();
  });
});

document.getElementById("holdingsSearch").addEventListener("input", (e) => {
  holdingsSearchTerm = e.target.value.trim();
  renderHoldingsTable();
});

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

// Chart of real portfolio value over time — backfilled once from actual
// historical closing prices since each holding's buy_date, then appended to
// daily by the scheduled Worker. See worker/src/lib/history.js.
// Follows the portfolio filter (Day 16): "All portfolios" reads the
// whole-account series (portfolio_value_history); a specific portfolio reads
// its own series (portfolio_history, scoped by portfolio_id). Both tables are
// kept live by loadHoldings() above and by the Worker's daily job/backfill.
// The full (unfiltered) history for whatever's currently selected — kept
// around so the 1M/3M/1Y/All range buttons can just re-slice this in memory
// instead of re-querying every time you click one.
let fullHistoryData = [];
let chartRange = "all";

async function loadValueHistory() {
  const svg = document.getElementById("valueChart");
  const caption = document.getElementById("chartCaption");
  const heading = document.getElementById("chartHeading");

  const viewingAll = selectedPortfolioId === "__all__";
  const portfolioName = viewingAll ? null : allPortfolios.find((p) => p.id === selectedPortfolioId)?.name;
  heading.textContent = viewingAll ? "Portfolio Value Over Time" : `Portfolio Value Over Time — ${portfolioName || "…"}`;

  const query = viewingAll
    ? sb.from("portfolio_value_history").select("date, total_value").order("date", { ascending: true })
    : sb.from("portfolio_history").select("date, total_value").eq("portfolio_id", selectedPortfolioId).order("date", { ascending: true });

  const { data, error } = await query;

  if (error) {
    svg.innerHTML = "";
    caption.textContent = `Could not load history: ${error.message}`;
    fullHistoryData = [];
    return;
  }
  if (!data || data.length === 0) {
    svg.innerHTML = "";
    caption.textContent = viewingAll
      ? "No history yet — visit <WORKER_URL>/backfill-history once to seed it from real historical prices, or check back after a few scheduled runs."
      : "No history yet for this portfolio — it'll appear after your next edit/poll (live) or the next /backfill-history run (real historical prices).";
    fullHistoryData = [];
    return;
  }

  fullHistoryData = data;
  applyChartRange();
}

// Slices fullHistoryData down to the selected range (Day 17) and (re)draws.
// Falls back to showing everything if the selected range would leave fewer
// than 2 points to plot — a 1-point "line" isn't useful, and it's better to
// show the fuller picture than an empty chart.
function applyChartRange() {
  const svg = document.getElementById("valueChart");
  const caption = document.getElementById("chartCaption");
  if (!fullHistoryData.length) return;

  let data = fullHistoryData;
  if (chartRange !== "all") {
    const days = { "1M": 30, "3M": 90, "1Y": 365 }[chartRange];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const filtered = fullHistoryData.filter((p) => p.date >= cutoffStr);
    if (filtered.length >= 2) data = filtered;
  }

  renderValueChart(svg, data);
  const first = data[0];
  const last = data[data.length - 1];
  caption.textContent = `${new Date(first.date).toLocaleDateString()} – ${new Date(last.date).toLocaleDateString()} · ${data.length} day${data.length === 1 ? "" : "s"} of history`;
}

document.querySelectorAll("#chartRangeButtons button").forEach((btn) => {
  btn.addEventListener("click", () => {
    chartRange = btn.dataset.range;
    document.querySelectorAll("#chartRangeButtons button").forEach((b) => b.classList.toggle("active", b === btn));
    applyChartRange();
  });
});

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
  // CSS custom properties, not literal hex — these resolve through the
  // `style` attribute (SVG presentation attributes like a bare fill="..."
  // do NOT support var()), so the chart automatically repaints in the
  // right colors for whichever theme is active, light or dark, with no
  // JS re-render needed on theme toggle.
  const trendColor = trendUp ? "var(--green)" : "var(--red)";

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
      return `<line x1="${padX}" y1="${gy.toFixed(1)}" x2="${width - padX}" y2="${gy.toFixed(1)}" style="stroke:var(--border)" stroke-width="1" stroke-dasharray="3,4"></line>
        <rect x="${boxX.toFixed(1)}" y="${(gy - 15).toFixed(1)}" width="${labelWidth.toFixed(1)}" height="15" style="fill:var(--panel);fill-opacity:0.9" rx="3"></rect>
        <text x="${(width - padX - 4).toFixed(1)}" y="${(gy - 4).toFixed(1)}" style="fill:var(--muted)" font-size="10" text-anchor="end">${label}</text>`;
    })
    .join("");

  const maxLabel = fmtMoney(max);
  const minLabel = fmtMoney(min);
  const maxLabelWidth = maxLabel.length * 6.5 + 8;
  const minLabelWidth = minLabel.length * 6.5 + 8;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    ${gridLines}
    <path d="${areaPath}" style="fill:${trendColor};fill-opacity:0.12" stroke="none"></path>
    <path d="${linePath}" fill="none" style="stroke:${trendColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <rect x="${(padX - 4).toFixed(1)}" y="4" width="${maxLabelWidth.toFixed(1)}" height="16" style="fill:var(--panel);fill-opacity:0.9" rx="3"></rect>
    <text x="${padX}" y="16" style="fill:var(--muted)" font-size="11">${maxLabel}</text>
    <rect x="${(padX - 4).toFixed(1)}" y="${height - 22}" width="${minLabelWidth.toFixed(1)}" height="16" style="fill:var(--panel);fill-opacity:0.9" rx="3"></rect>
    <text x="${padX}" y="${height - 8}" style="fill:var(--muted)" font-size="11">${minLabel}</text>
    <line id="chartHoverLine" x1="0" y1="${padY}" x2="0" y2="${height - padY}" style="stroke:var(--muted); display: none" stroke-width="1" stroke-dasharray="2,3"></line>
    <circle id="chartHoverDot" r="4" style="fill:${trendColor}; stroke:var(--panel); display: none" stroke-width="1.5"></circle>
  `;

  // Hover/tap-to-inspect (Day 17): find the nearest plotted point to the
  // pointer and show its exact date/value — mouse for desktop, touch for
  // mobile. Coordinates convert from screen pixels into the SVG's own
  // viewBox units since the rendered box and the viewBox rarely match 1:1.
  const hoverLine = svg.querySelector("#chartHoverLine");
  const hoverDot = svg.querySelector("#chartHoverDot");
  const tooltip = document.getElementById("chartTooltip");
  if (tooltip) tooltip.style.display = "none"; // clear any stale tooltip left showing from before this (re)render

  function showHoverAt(clientX) {
    const rect = svg.getBoundingClientRect();
    const mouseX = ((clientX - rect.left) / rect.width) * width;
    let nearestIdx = 0;
    let minDist = Infinity;
    coords.forEach((c, i) => {
      const d = Math.abs(c.x - mouseX);
      if (d < minDist) {
        minDist = d;
        nearestIdx = i;
      }
    });
    const c = coords[nearestIdx];
    const p = points[nearestIdx];
    hoverLine.setAttribute("x1", c.x.toFixed(1));
    hoverLine.setAttribute("x2", c.x.toFixed(1));
    hoverLine.style.display = "";
    hoverDot.setAttribute("cx", c.x.toFixed(1));
    hoverDot.setAttribute("cy", c.y.toFixed(1));
    hoverDot.style.display = "";
    if (tooltip) {
      tooltip.style.display = "block";
      tooltip.style.left = `${(c.x / width) * 100}%`;
      tooltip.style.top = `${(c.y / height) * 100}%`;
      tooltip.textContent = `${new Date(p.date).toLocaleDateString()} · ${fmtMoney(p.total_value)}`;
    }
  }
  function hideHover() {
    hoverLine.style.display = "none";
    hoverDot.style.display = "none";
    if (tooltip) tooltip.style.display = "none";
  }

  svg.onmousemove = (e) => showHoverAt(e.clientX);
  svg.onmouseleave = hideHover;
  svg.ontouchmove = (e) => {
    if (e.touches[0]) {
      showHoverAt(e.touches[0].clientX);
      e.preventDefault(); // avoid scrolling the page while inspecting the chart
    }
  };
  svg.ontouchend = hideHover;
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
  form.portfolio_id.value = h.portfolio_id || "";
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

  // Day 19: the buy side now converts at the ACTUAL rate on buy_date (and
  // the sell side at the actual rate on sell_date), not just whatever's
  // cached "now" — falls back to the current rate for either side if no
  // historical rate has been cached yet for that currency/date.
  const [fxRates, histFx] = await Promise.all([
    fetchLatestFx([sellingHolding.buy_currency, sellCurrency]).catch(() => ({ [BASE_CURRENCY]: 1 })),
    fetchHistoricalFxForDates([
      { currency: sellingHolding.buy_currency, date: sellingHolding.buy_date },
      { currency: sellCurrency, date: sellDate },
    ]).catch(() => new Map()),
  ]);
  const buyFx = histFx.get(`${sellingHolding.buy_currency}|${sellingHolding.buy_date}`) ?? fxRates[sellingHolding.buy_currency] ?? null;
  const sellFx = histFx.get(`${sellCurrency}|${sellDate}`) ?? fxRates[sellCurrency] ?? null;

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
// Kept around so the CSV export button can reuse whatever's already loaded
// instead of firing a second query.
let lastRealizedGainsRows = [];

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
  lastRealizedGainsRows = data || [];
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

// --- CSV export --------------------------------------------------------
// Everything's client-side: the data's already in memory from the last
// load, so this just formats it and triggers a browser download — no Worker
// round trip needed.
function toCsv(rows, columns) {
  const escapeCsv = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escapeCsv(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => escapeCsv(c.value(r))).join(",")).join("\n");
  return `${header}\n${body}`;
}

function downloadCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("exportHoldingsBtn").addEventListener("click", () => {
  // Exports whatever's currently loaded, respecting the active portfolio
  // filter — "All portfolios" exports everything, a specific portfolio
  // exports just that one.
  if (!lastHoldingsRows.length) return;
  const columns = [
    { label: "Ticker", value: (r) => r.h.ticker },
    { label: "Portfolio", value: (r) => (r.h.portfolio_id ? allPortfolios.find((p) => p.id === r.h.portfolio_id)?.name || "" : "") },
    { label: "Type", value: (r) => r.h.asset_type },
    { label: "Quantity", value: (r) => r.h.quantity },
    { label: "Buy price", value: (r) => r.h.buy_price },
    { label: "Buy currency", value: (r) => r.h.buy_currency },
    { label: "Buy date", value: (r) => r.h.buy_date },
    { label: `Current price (${BASE_CURRENCY})`, value: (r) => r.priceInBase ?? "" },
    { label: `Value (${BASE_CURRENCY})`, value: (r) => r.currentValue ?? "" },
    { label: "Gain/loss %", value: (r) => r.gainPct ?? "" },
  ];
  downloadCsv(`holdings_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(lastHoldingsRows, columns));
});

document.getElementById("exportRealizedGainsBtn").addEventListener("click", () => {
  if (!lastRealizedGainsRows.length) return;
  const columns = [
    { label: "Ticker", value: (r) => r.ticker },
    { label: "Quantity", value: (r) => r.quantity },
    { label: "Buy price", value: (r) => r.buy_price },
    { label: "Buy currency", value: (r) => r.buy_currency },
    { label: "Buy date", value: (r) => r.buy_date },
    { label: "Sell price", value: (r) => r.sell_price },
    { label: "Sell currency", value: (r) => r.sell_currency },
    { label: "Sell date", value: (r) => r.sell_date },
    { label: `Realized gain (${BASE_CURRENCY})`, value: (r) => r.realized_gain_abs ?? "" },
    { label: "Realized gain %", value: (r) => r.realized_gain_pct ?? "" },
  ];
  downloadCsv(`realized_gains_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(lastRealizedGainsRows, columns));
});

// --- Portfolios: an optional grouping layer on top of holdings ------------
// Scope decision (see README/schema.sql): portfolios filter the holdings
// table, summary stats, allocation, and the value chart (loadValueHistory,
// below). The daily email and realized gains stay whole-account — splitting
// those too would mean multiple emails per user each morning, out of scope.
let allPortfolios = [];
let selectedPortfolioId = "__all__";

async function loadPortfolios() {
  const { data, error } = await sb.from("portfolios").select("*").order("created_at");
  if (error) {
    console.warn("Could not load portfolios:", error.message);
    return;
  }
  allPortfolios = data || [];

  const filterSelect = document.getElementById("portfolioFilterSelect");
  const keepFilter = selectedPortfolioId;
  filterSelect.innerHTML =
    `<option value="__all__">All portfolios</option>` +
    allPortfolios.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  // If the previously selected portfolio was deleted elsewhere, fall back to "All".
  filterSelect.value = allPortfolios.some((p) => p.id === keepFilter) || keepFilter === "__all__" ? keepFilter : "__all__";
  selectedPortfolioId = filterSelect.value;

  const formSelect = document.getElementById("portfolioFormSelect");
  formSelect.innerHTML =
    `<option value="">No portfolio</option>` + allPortfolios.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  setPortfolioFormDefault();

  updatePortfolioBarButtons();
}

// When adding a new holding, default its portfolio to whichever one you're
// currently filtered to — you're almost always adding to the portfolio
// you're looking at. Only applies when not mid-edit (startEdit sets its own value after this runs).
function setPortfolioFormDefault() {
  if (editingHoldingId) return;
  const formSelect = document.getElementById("portfolioFormSelect");
  formSelect.value = selectedPortfolioId === "__all__" ? "" : selectedPortfolioId;
}

function updatePortfolioBarButtons() {
  const hasSelection = selectedPortfolioId !== "__all__";
  document.getElementById("renamePortfolioBtn").style.display = hasSelection ? "" : "none";
  document.getElementById("deletePortfolioBtn").style.display = hasSelection ? "" : "none";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("portfolioFilterSelect").addEventListener("change", (e) => {
  selectedPortfolioId = e.target.value;
  updatePortfolioBarButtons();
  setPortfolioFormDefault();
  loadHoldings();
  loadValueHistory(); // don't wait on loadHoldings' async upsert chain — redraw for the new filter right away
});

document.getElementById("newPortfolioBtn").addEventListener("click", async () => {
  const name = await showModal({
    type: "prompt",
    title: "New portfolio",
    message: "Name this portfolio (e.g. Retirement, Trading):",
    placeholder: "Portfolio name",
  });
  if (!name) return;
  const { data, error } = await sb.from("portfolios").insert({ user_id: currentUserId, name }).select().single();
  if (error) {
    await showModal({ title: "Could not create portfolio", message: error.message });
    return;
  }
  await loadPortfolios();
  document.getElementById("portfolioFilterSelect").value = data.id;
  selectedPortfolioId = data.id;
  updatePortfolioBarButtons();
  setPortfolioFormDefault();
  loadHoldings();
  loadValueHistory();
});

document.getElementById("renamePortfolioBtn").addEventListener("click", async () => {
  if (selectedPortfolioId === "__all__") return;
  const current = allPortfolios.find((p) => p.id === selectedPortfolioId);
  const name = await showModal({
    type: "prompt",
    title: "Rename portfolio",
    defaultValue: current?.name || "",
    placeholder: "Portfolio name",
  });
  if (!name) return;
  const { error } = await sb.from("portfolios").update({ name }).eq("id", selectedPortfolioId);
  if (error) {
    await showModal({ title: "Could not rename portfolio", message: error.message });
    return;
  }
  await loadPortfolios();
  loadValueHistory(); // picks up the new name in the chart heading
});

document.getElementById("deletePortfolioBtn").addEventListener("click", async () => {
  if (selectedPortfolioId === "__all__") return;
  const current = allPortfolios.find((p) => p.id === selectedPortfolioId);
  const ok = await showModal({
    type: "confirm",
    title: `Delete "${current?.name}"?`,
    message: 'Its holdings are NOT deleted — they just become unassigned and stay visible under "All portfolios". Its chart history IS deleted.',
    danger: true,
    confirmLabel: "Delete",
  });
  if (!ok) return;
  const { error } = await sb.from("portfolios").delete().eq("id", selectedPortfolioId);
  if (error) {
    await showModal({ title: "Could not delete portfolio", message: error.message });
    return;
  }
  selectedPortfolioId = "__all__";
  await loadPortfolios();
  loadHoldings();
  loadValueHistory();
});

// --- Ticker search/autocomplete --------------------------------------------
// Proxies through the Worker (worker/src/index.js /search-symbols) so the
// Twelve Data API key stays server-side — same principle as never calling
// the price API directly from the browser.
let tickerSearchDebounce = null;
let tickerSearchActiveIndex = -1;
let tickerSearchResults = [];

function renderTickerSuggestions(results) {
  tickerSearchResults = results;
  tickerSearchActiveIndex = -1;
  const list = document.getElementById("tickerSuggestions");
  if (!results.length) {
    list.style.display = "none";
    list.innerHTML = "";
    return;
  }
  list.innerHTML = results
    .map(
      (r, i) => `
    <li data-index="${i}">
      <span class="sym">${escapeHtml(r.symbol)}</span>
      <span class="name">${escapeHtml(r.name || "")}${r.exchange ? ` · ${escapeHtml(r.exchange)}` : ""}</span>
    </li>`
    )
    .join("");
  list.style.display = "";
  list.querySelectorAll("li").forEach((li) =>
    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // fire before the input's blur hides the list
      selectTickerSuggestion(Number(li.dataset.index));
    })
  );
}

function selectTickerSuggestion(index) {
  const r = tickerSearchResults[index];
  if (!r) return;
  const tickerInput = document.getElementById("tickerInput");
  tickerInput.value = r.symbol;
  // Best-effort: default the currency dropdown to match the exchange's
  // currency if it's one of the options we support.
  const form = document.getElementById("holdingForm");
  if (r.currency && [...form.buy_currency.options].some((o) => o.value === r.currency)) {
    form.buy_currency.value = r.currency;
  }
  if (r.type && /etf/i.test(r.type)) form.asset_type.value = "etf";
  else if (r.type && /fund/i.test(r.type)) form.asset_type.value = "fund";
  else if (r.type && /(common stock|equity)/i.test(r.type)) form.asset_type.value = "stock";
  document.getElementById("tickerSuggestions").style.display = "none";
}

const tickerInputEl = document.getElementById("tickerInput");
tickerInputEl.addEventListener("input", () => {
  const q = tickerInputEl.value.trim();
  clearTimeout(tickerSearchDebounce);
  if (q.length < 1 || !window.WORKER_URL) {
    renderTickerSuggestions([]);
    return;
  }
  tickerSearchDebounce = setTimeout(async () => {
    try {
      const res = await authedFetch(`${window.WORKER_URL}/search-symbols?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      renderTickerSuggestions(json.data || []);
    } catch (err) {
      console.warn("Ticker search failed:", err.message);
    }
  }, 300);
});

tickerInputEl.addEventListener("keydown", (e) => {
  const list = document.getElementById("tickerSuggestions");
  if (list.style.display === "none" || !tickerSearchResults.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    tickerSearchActiveIndex = Math.min(tickerSearchActiveIndex + 1, tickerSearchResults.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    tickerSearchActiveIndex = Math.max(tickerSearchActiveIndex - 1, 0);
  } else if (e.key === "Enter" && tickerSearchActiveIndex >= 0) {
    e.preventDefault();
    selectTickerSuggestion(tickerSearchActiveIndex);
    return;
  } else if (e.key === "Escape") {
    renderTickerSuggestions([]);
    return;
  } else {
    return;
  }
  list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === tickerSearchActiveIndex));
});

tickerInputEl.addEventListener("blur", () => {
  setTimeout(() => renderTickerSuggestions([]), 150); // delay so a click on a suggestion still registers
});

// --- Manual "Run now" button ------------------------------------------------
// Wires the Worker's /run?user_id= endpoint (scoped to just this user — see
// worker/src/index.js runDailyJobForUser) to a button instead of requiring
// curl. Sends a real email and writes a daily_reports row (Worker-side audit
// trail; no longer surfaced in the UI — see removed "Recent Runs" section),
// same as a scheduled run would for this account.
document.getElementById("runNowBtn").addEventListener("click", async () => {
  const btn = document.getElementById("runNowBtn");
  const statusEl = document.getElementById("quickActionsStatus");
  if (!currentUserId || !window.WORKER_URL) return;

  btn.disabled = true;
  btn.textContent = "Running…";
  statusEl.className = "quick-actions-status";
  statusEl.textContent = "Refreshing prices and sending your daily email now — this can take a few seconds…";

  try {
    const res = await authedFetch(`${window.WORKER_URL}/run?user_id=${encodeURIComponent(currentUserId)}`);
    const result = await res.json();
    if (!res.ok) {
      statusEl.className = "quick-actions-status negative";
      statusEl.textContent = `Failed: ${result.error || `HTTP ${res.status}`}`;
    } else if (result.status === "completed" && result.user?.status !== "failed") {
      statusEl.className = "quick-actions-status positive";
      statusEl.textContent = `Done — email sent (${result.user?.status || "sent"}), took ${(result.duration_ms / 1000).toFixed(1)}s.`;
    } else if (result.status === "skipped") {
      statusEl.className = "quick-actions-status";
      statusEl.textContent = `Skipped: ${result.reason}`;
    } else {
      statusEl.className = "quick-actions-status negative";
      statusEl.textContent = `Failed: ${result.error || result.user?.error || "unknown error"}`;
    }
  } catch (err) {
    statusEl.className = "quick-actions-status negative";
    statusEl.textContent = `Could not reach the Worker: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run now";
    loadHoldings();
    loadValueHistory();
  }
});

// "Fetch prices" — same underlying /refresh-prices endpoint the app already
// calls automatically after every add/edit, just exposed as a visible,
// on-demand button with feedback: refreshes the shared price/FX cache with
// NO email side effect (unlike "Run now", which sends your daily email).
document.getElementById("fetchPricesBtn").addEventListener("click", async () => {
  const btn = document.getElementById("fetchPricesBtn");
  const statusEl = document.getElementById("quickActionsStatus");
  if (!window.WORKER_URL) return;

  btn.disabled = true;
  btn.textContent = "Fetching…";
  statusEl.className = "quick-actions-status";
  statusEl.textContent = "Refreshing prices — no email sent…";

  try {
    const result = await triggerPriceRefresh({ silent: false });
    if (result?.skipped) {
      statusEl.className = "quick-actions-status";
      statusEl.textContent = `Skipped: ${result.reason}`;
    } else if (result?.error) {
      statusEl.className = "quick-actions-status negative";
      statusEl.textContent = `Failed: ${result.error}`;
    } else {
      statusEl.className = "quick-actions-status positive";
      statusEl.textContent = "Prices refreshed.";
    }
  } catch (err) {
    statusEl.className = "quick-actions-status negative";
    statusEl.textContent = `Could not reach the Worker: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch prices";
    loadHoldings();
    loadValueHistory();
  }
});

// Weighted-average cost basis (Day 16): adding to (or editing into) a ticker
// you already hold IN THE SAME PORTFOLIO merges into that one row instead of
// leaving two rows for the same position — quantity sums, buy_price becomes
// the quantity-weighted average of the two, buy_date keeps the EARLIER of
// the two (preserves how long you've actually held the position). Matching
// is scoped to (ticker, portfolio_id) — the same ticker in a DIFFERENT
// portfolio is a deliberately separate position, not merged. Only merges
// when buy_currency also matches: averaging cost basis across currencies
// would need the historical FX rate at each individual purchase, which this
// app doesn't track (same simplification already used for cost-basis FX
// elsewhere) — a currency mismatch is added/kept as its own row instead,
// with a status message explaining why.
async function findSameTickerHoldings(ticker, portfolioId, excludeId) {
  let q = sb.from("holdings").select("*").eq("ticker", ticker);
  q = portfolioId ? q.eq("portfolio_id", portfolioId) : q.is("portfolio_id", null);
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) {
    console.warn("Could not check for an existing holding to merge with:", error.message);
    return [];
  }
  return data || [];
}

function weightedMerge(existing, incoming) {
  const newQuantity = Number(existing.quantity) + Number(incoming.quantity);
  const buyPrice = (Number(existing.quantity) * Number(existing.buy_price) + Number(incoming.quantity) * Number(incoming.buy_price)) / newQuantity;
  const buyDate = incoming.buy_date < existing.buy_date ? incoming.buy_date : existing.buy_date;
  return { quantity: newQuantity, buy_price: buyPrice, buy_date: buyDate };
}

document.getElementById("holdingForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("formError");
  const statusEl = document.getElementById("formStatus");
  errEl.textContent = "";
  statusEl.textContent = "";
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
    portfolio_id: form.get("portfolio_id") || null,
  };
  if (!payload.ticker) return (errEl.textContent = "Ticker is required.");
  if (!(payload.quantity > 0)) return (errEl.textContent = "Quantity must be positive.");
  if (!(payload.buy_price > 0)) return (errEl.textContent = "Buy price must be positive.");

  if (editingHoldingId) {
    const sameTicker = await findSameTickerHoldings(payload.ticker, payload.portfolio_id, editingHoldingId);
    const collision = sameTicker.find((h) => h.buy_currency === payload.buy_currency);

    if (collision) {
      // The edit now matches another existing row exactly (ticker +
      // portfolio + currency) — merge into that row and remove this one,
      // rather than leaving two rows for the same position.
      const merged = weightedMerge(collision, payload);
      const { error: mergeError } = await sb.from("holdings").update(merged).eq("id", collision.id);
      if (mergeError) {
        errEl.textContent = `Could not merge: ${mergeError.message}`;
        return;
      }
      const { error: delError } = await sb.from("holdings").delete().eq("id", editingHoldingId);
      if (delError) {
        errEl.textContent = `Merged, but could not remove the old duplicate row: ${delError.message}`;
      } else {
        statusEl.textContent = `Merged into your existing ${payload.ticker} position — now ${merged.quantity} @ weighted avg ${fmtMoneyIn(merged.buy_price, payload.buy_currency)}.`;
      }
    } else {
      const { error } = await sb.from("holdings").update(payload).eq("id", editingHoldingId);
      if (error) {
        errEl.textContent = `Could not save changes: ${error.message}`;
        return;
      }
      if (sameTicker.length) {
        statusEl.textContent = `Saved as its own row — an existing ${payload.ticker} holding in this portfolio is in ${sameTicker[0].buy_currency}, so it wasn't merged.`;
      }
    }
    stopEdit();
    e.target.reset();
    setDateToToday();
    setPortfolioFormDefault();
    loadHoldings();
    await triggerPriceRefresh(); // ticker may have changed
    loadHoldings();
    return;
  }

  payload.user_id = currentUserId; // required by RLS: with check (auth.uid() = user_id)

  const sameTicker = await findSameTickerHoldings(payload.ticker, payload.portfolio_id, null);
  const existing = sameTicker.find((h) => h.buy_currency === payload.buy_currency);

  if (existing) {
    const merged = weightedMerge(existing, payload);
    const { error } = await sb.from("holdings").update(merged).eq("id", existing.id);
    if (error) {
      errEl.textContent = `Could not merge into existing holding: ${error.message}`;
      return;
    }
    statusEl.textContent = `Merged into your existing ${payload.ticker} position — now ${merged.quantity} @ weighted avg ${fmtMoneyIn(merged.buy_price, payload.buy_currency)}.`;
  } else {
    const { error } = await sb.from("holdings").insert(payload);
    if (error) {
      errEl.textContent = `Could not save: ${error.message}`;
      return;
    }
    if (sameTicker.length) {
      statusEl.textContent = `Added as its own row — an existing ${payload.ticker} holding in this portfolio is in ${sameTicker[0].buy_currency}, so it wasn't merged.`;
    }
  }

  e.target.reset();
  setDateToToday(); // form.reset() clears the date field back to blank — refill it
  setPortfolioFormDefault(); // form.reset() also clears this back to "No portfolio" — refill from the active filter
  loadHoldings(); // show the new/merged row immediately (price will say "no data" until the refresh below lands)
  await triggerPriceRefresh();
  loadHoldings(); // reload once the Worker has cached a price for the new ticker
});

// Default the buy-date field to today so adding a holding usually needs zero
// typing in that field — click the calendar icon only if you bought it on a
// different day.
function setDateToToday() {
  const input = document.getElementById("buyDateInput");
  if (input) input.value = new Date().toISOString().slice(0, 10);
}

// Ask the Worker to fetch+cache a price for anything missing (like a
// just-added holding) without waiting for tomorrow's scheduled run. This is
// a cache-only refresh — no email gets sent — and the Worker throttles it
// server-side so repeated clicks don't burn through the market-data rate limit.
// `silent: true` (the default, used automatically after add/edit) swallows
// errors and just logs them; the "Fetch prices" button passes `silent: false`
// so it can show the failure to you directly instead of failing invisibly.
async function triggerPriceRefresh({ silent = true } = {}) {
  if (!window.WORKER_URL) return null;
  try {
    const res = await authedFetch(`${window.WORKER_URL}/refresh-prices`);
    if (!res.ok) {
      const msg = `Price refresh request failed: HTTP ${res.status}`;
      if (!silent) throw new Error(msg);
      console.warn(`${msg} (check WORKER_URL in config.js is correct)`);
      return null;
    }
    const result = await res.json();
    if (result.skipped) console.log("Price refresh skipped:", result.reason);
    if (result.error) console.warn("Price refresh failed:", result.error);
    return result;
  } catch (err) {
    if (!silent) throw err;
    console.warn("Could not reach the Worker to refresh prices:", err.message);
    return null;
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
  loadPortfolios().then(loadHoldings);
  loadValueHistory();
  loadRealizedGains();
  if (!window.__pollingStarted) {
    window.__pollingStarted = true;
    setInterval(() => {
      loadPortfolios();
      loadHoldings();
      loadValueHistory();
      loadRealizedGains();
    }, 5 * 60 * 1000); // refresh the view every 5 min from cache (not the API)
  }
}

function showLogin() {
  currentUserId = null;
  document.getElementById("appContent").style.display = "none";
  document.getElementById("resetPasswordSection").style.display = "none";
  document.getElementById("loginSection").style.display = "";
}

function showResetPassword() {
  document.getElementById("appContent").style.display = "none";
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("resetPasswordSection").style.display = "";
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

// --- Sign in with Google (OAuth) ---
// Needs the Google provider turned on in Supabase (Auth > Providers) with a
// Google Cloud OAuth Client ID/Secret, plus this site's URL added under
// Auth > URL Configuration > Redirect URLs — see README "Google sign-in
// setup". redirectTo sends the browser back to wherever this page is
// currently hosted (works for both the *.pages.dev URL and a custom domain
// without hardcoding either).
document.getElementById("googleSignInBtn").addEventListener("click", async () => {
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  // A successful call navigates the browser away to Google immediately —
  // this only returns/shows an error if the redirect itself couldn't start
  // (e.g. the provider isn't enabled yet in Supabase).
  if (error) errEl.textContent = error.message;
});

// --- Forgot password ---
// Reuses whatever's currently typed into the email field above. Supabase
// emails a link back to redirectTo with a one-time recovery token in the URL
// hash; the Supabase client auto-detects that on load and fires the
// PASSWORD_RECOVERY event handled below, rather than this page parsing the
// token itself.
document.getElementById("forgotPasswordBtn").addEventListener("click", async () => {
  const errEl = document.getElementById("loginError");
  const hintEl = document.getElementById("loginHint");
  errEl.textContent = "";
  hintEl.textContent = "";
  const email = document.querySelector('#loginForm input[name="email"]').value.trim();
  if (!email) {
    errEl.textContent = 'Enter your email above first, then click "Forgot password?".';
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) {
    errEl.textContent = error.message;
    return;
  }
  hintEl.textContent = `Password reset email sent to ${email} — check your inbox for the link.`;
});

document.getElementById("resetPasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("resetPasswordError");
  const hintEl = document.getElementById("resetPasswordHint");
  errEl.textContent = "";
  hintEl.textContent = "";

  const form = new FormData(e.target);
  const password = form.get("password");
  const confirmPassword = form.get("confirmPassword");
  if (password !== confirmPassword) {
    errEl.textContent = "Passwords don't match.";
    return;
  }

  const { data, error } = await sb.auth.updateUser({ password });
  if (error) {
    errEl.textContent = error.message;
    return;
  }
  inPasswordRecovery = false;
  hintEl.textContent = "Password updated — signing you in…";
  showApp(data.user);
});

document.getElementById("cancelResetBtn").addEventListener("click", async () => {
  inPasswordRecovery = false;
  await sb.auth.signOut(); // the recovery link issues a real (if temporary) session — drop it
  showLogin();
});

// Supabase's client detects a password-recovery link in the URL on load and
// fires this event (with a valid, if temporary, session already attached) —
// route to the "set a new password" screen instead of straight into the
// dashboard. inPasswordRecovery guards the getSession() check just below,
// since both can resolve in either order.
let inPasswordRecovery = false;
sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    inPasswordRecovery = true;
    showResetPassword();
  }
});

// On load, pick up an existing session (Supabase persists it in
// localStorage) so you're not asked to log in again on every visit.
sb.auth.getSession().then(({ data: { session } }) => {
  if (inPasswordRecovery) return; // already routed to showResetPassword() above
  if (session) showApp(session.user);
  else showLogin();
});
