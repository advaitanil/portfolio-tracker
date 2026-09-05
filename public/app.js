// Front end: holdings CRUD + read-only valuation view.
// IMPORTANT: this page only ever READS from the `prices` and `fx_rates` caches.
// It never calls the market-data or FX APIs directly (see README: "cache
// prices in the database" is the single most important design decision here).
// The Cloudflare Worker is what refreshes those caches on a schedule.

// Day 26 ("PWA / add-to-homescreen"). Registers sw.js, which only ever
// caches the static app shell (see that file's own comment) — never
// Supabase/Worker responses, so this can't cause stale prices or holdings.
// Wrapped in a feature check + try/catch since this must never be able to
// break the app in a browser without service worker support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker registration failed (app still works normally):", err.message));
  });
}

// Day 24: "Remember me" toggle on the sign-in form. Supabase's client
// persists the session via whatever storage object it's given — by default
// always localStorage, which survives closing the browser entirely. This
// custom storage adapter reads a small (non-sensitive) boolean preference —
// "sb-remember-me" — to decide, PER CALL, whether the actual session token
// goes into localStorage (survives browser restart) or sessionStorage
// (cleared when the tab/browser closes). The preference itself always lives
// in localStorage (it's just a flag, not a credential) so it's still known
// the next time the adapter runs, before any session exists yet.
const REMEMBER_ME_KEY = "sb-remember-me";
const rememberMeStorage = {
  getItem: (key) => {
    const remember = localStorage.getItem(REMEMBER_ME_KEY) !== "false"; // default true — see login form checkbox default
    return (remember ? localStorage : sessionStorage).getItem(key);
  },
  setItem: (key, value) => {
    const remember = localStorage.getItem(REMEMBER_ME_KEY) !== "false";
    (remember ? localStorage : sessionStorage).setItem(key, value);
    // Clear the other store too, so a stale/duplicate token can't linger
    // there from a previous sign-in under the opposite setting.
    (remember ? sessionStorage : localStorage).removeItem(key);
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
  auth: { storage: rememberMeStorage, persistSession: true, autoRefreshToken: true },
});
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

// Day 24: show/hide password toggle — every `.password-field` wrapper in the
// static HTML (sign-in, reset-password) has one input + one
// `.show-password-toggle` button as siblings. Wired once at load since none
// of these are dynamically rendered later.
document.querySelectorAll(".show-password-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = btn.previousElementSibling;
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
    btn.setAttribute("aria-pressed", String(!showing));
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
});

// Day 25 ("Auto-clearing status messages"): any element with this class gets
// its text cleared a few seconds after it's set, so a success/status message
// doesn't sit there stale until the next unrelated action. Deliberately
// generic (a MutationObserver per element) instead of touching every call
// site that sets one of these — new call sites get the behavior for free.
// Two things are excluded from clearing: an element carrying the "negative"
// class (errors should stay until the user acts, not vanish on a timer),
// and text ending in "…" (this codebase's consistent convention for an
// in-progress message like "Importing…" — clearing that while the operation
// is still running would look like it silently failed).
document.querySelectorAll(".auto-clear-status").forEach((el) => {
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    const text = el.textContent.trim();
    if (!text || el.classList.contains("negative") || text.endsWith("…")) return;
    timer = setTimeout(() => {
      el.textContent = "";
    }, 5000);
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
});

// Day 25 ("Pinned last-synced freshness indicator"): the header itself is
// `position: sticky` (see style.css); this just toggles a border/shadow once
// it's actually stuck to the top, so it visually reads as "pinned" rather
// than looking identical whether you've scrolled or not.
const appHeaderEl = document.querySelector("#appContent > header");
if (appHeaderEl) {
  const toggleStuck = () => appHeaderEl.classList.toggle("is-stuck", window.scrollY > 4);
  window.addEventListener("scroll", toggleStuck, { passive: true });
  toggleStuck();
}

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

// Day 23 (a11y review, S-3.4 "Errors"): every <form> in the page now has
// novalidate, so a required/type/minlength/etc. mismatch no longer triggers
// the browser's own native validation bubble — which, in every browser we
// checked, is icon/outline-only until you hover or focus it, isn't
// consistently announced by screen readers, and (per the review) is exactly
// what read as "small red icons inside each field with no text message."
// This re-implements the SAME checks using the Constraint Validation API
// (checkValidity()/validationMessage — still fully populated from the
// required/type/minlength/pattern attributes already on each field, so
// there's no duplicated validation logic to maintain) but renders the
// message as real text in the form's existing error paragraph, which the
// caller should mark aria-live="polite" so screen readers announce it.
// Returns true if the form is valid (nothing to do), false if it stopped
// submission and showed a message.
function showValidationError(form, errEl) {
  if (form.checkValidity()) return true;
  const invalidEl = form.querySelector(":invalid");
  if (invalidEl) {
    errEl.textContent = invalidEl.validationMessage || "Please check the highlighted field.";
    invalidEl.focus();
  } else {
    errEl.textContent = "Please check the form and try again.";
  }
  return false;
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

// Day 24 (review P1: "no transaction ledger / audit history"). Best-effort,
// fire-and-forget: a failure here should never block the actual holdings
// mutation it's recording (the ledger is a nice-to-have audit trail, not a
// source of truth — `holdings`/`realized_gains` still are), so this never
// throws, only warns to the console. holdingId/portfolioId are passed
// through as plain values (not looked up again) since the caller always
// already has them at the point it's mutating a holding.
async function logTransaction({ holdingId = null, portfolioId = null, ticker, eventType, quantity = null, price = null, currency = null, eventDate, notes = null }) {
  if (!currentUserId) return;
  const { error } = await sb.from("transactions").insert({
    user_id: currentUserId,
    holding_id: holdingId,
    portfolio_id: portfolioId,
    ticker,
    event_type: eventType,
    quantity,
    price,
    currency,
    event_date: eventDate,
    notes,
  });
  if (error) console.warn("Could not log transaction (continuing anyway):", error.message);
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

// Day 24: the FX snapshot immediately BEFORE the latest one per currency —
// fx_rates is append-only (one new row per Worker refresh), so the second
// most recent row is the closest available proxy for "yesterday's rate",
// same simplification the Worker's own getFxRateBefore() makes server-side.
// Used only to split price return from FX return for display — never for
// any actual money math (cost basis / current value keep using "today's"
// single latest rate from fetchLatestFx, unchanged).
async function fetchPreviousFx(currencies) {
  const needed = currencies.filter((c) => c !== BASE_CURRENCY);
  const rates = {};
  if (needed.length === 0) return rates;
  const { data, error } = await sb
    .from("fx_rates")
    .select("quote, rate, as_of")
    .eq("base", BASE_CURRENCY)
    .in("quote", needed)
    .order("as_of", { ascending: false });
  if (error || !data) return rates;
  const latestAsOfByQuote = {};
  for (const row of data) {
    if (!(row.quote in latestAsOfByQuote)) {
      latestAsOfByQuote[row.quote] = row.as_of; // first row per currency = "today"
      continue;
    }
    if (!(row.quote in rates) && row.as_of !== latestAsOfByQuote[row.quote]) {
      rates[row.quote] = 1 / row.rate; // first DIFFERENT snapshot = "yesterday"
    }
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

// Day 24 (review P1: "gain/loss blends price & FX return"). Worker-side
// metrics.js already computed this split for the (unused-in-the-UI) email
// math — this mirrors that same logic client-side for the dashboard, which
// has always had its own separate implementation (see README "Known
// limitations" on the metrics duplication). fxRatesYesterday, when available,
// is the previous cached FX snapshot per currency (see fetchPreviousFx) —
// without it, this falls back to the old price-only day change exactly like
// before this feature existed.
function computeRow(holding, priceRow, fxRates, buyFxOverride, fxRatesYesterday) {
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
  let priceReturnPct = null;
  let fxReturnPct = null;
  const priceCcy = priceRow?.currency;
  if (priceRow?.previous_close) {
    // Price return: the instrument's own move, in its own currency — never
    // affected by FX at all.
    priceReturnPct = ((priceRow.price - priceRow.previous_close) / priceRow.previous_close) * 100;

    if (!priceCcy || priceCcy === BASE_CURRENCY) {
      dayChangePct = priceReturnPct;
      fxReturnPct = 0;
    } else {
      const fxYesterday = fxRatesYesterday?.[priceCcy];
      const fxToday = fxRates[priceCcy];
      if (fxYesterday && fxToday && priceInBase != null) {
        const prevCloseInBaseYesterday = priceRow.previous_close * fxYesterday;
        // True blended return, computed directly from base-currency values —
        // NOT priceReturnPct + fxReturnPct, which would only approximate it
        // (the two compound rather than add for anything but tiny moves).
        dayChangePct = ((priceInBase - prevCloseInBaseYesterday) / prevCloseInBaseYesterday) * 100;
        // How much the holding's currency itself moved against the base
        // currency, isolated from the instrument's own price move.
        fxReturnPct = ((fxToday - fxYesterday) / fxYesterday) * 100;
      } else {
        // No FX history cached yet for this currency — same graceful
        // degrade as before this feature existed: show price-only change
        // rather than block on missing data.
        dayChangePct = priceReturnPct;
      }
    }
  }

  const isFund = holding.asset_type === "fund";
  const staleThreshold = isFund ? FUND_STALE_AFTER_MS : STALE_AFTER_MS;
  const isStale =
    !priceRow ||
    priceRow.is_stale ||
    Date.now() - new Date(priceRow.as_of).getTime() > staleThreshold;

  return { currentValue, costBasis, gainAbs, gainPct, dayChangePct, priceReturnPct, fxReturnPct, priceInBase, isStale, isFund, priceRow };
}

async function loadHoldings() {
  const tbody = document.getElementById("holdingsBody");
  // Day 26 ("view-only sharing"): explicit user_id filter. Without it, once
  // ANY share exists, the additive "shared viewers can read shared
  // holdings" RLS policy would mix another account's rows into your own
  // normal dashboard load — this is what actually switches between "my
  // data" and "the portfolio someone shared with me", not just a UI toggle.
  const viewingUserId = sharedViewOwnerId || currentUserId;
  const { data: holdings, error } = await sb.from("holdings").select("*").eq("user_id", viewingUserId).order("created_at");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="12">Failed to load holdings: ${error.message}</td></tr>`;
    return;
  }
  if (holdings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12">No holdings yet — add one below.</td></tr>`;
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
  // Day 24: previous FX snapshot for every currency a price might come back
  // in, purely for the price-vs-FX return split below (see computeRow) —
  // best-effort, missing entries just mean that holding's split falls back
  // to price-only day change.
  const fxRatesYesterday = await fetchPreviousFx([...new Set([...currencies, ...priceCurrencies])]).catch(() => ({}));

  // Computed over EVERY holding regardless of the portfolio filter — the
  // whole-account total feeds the "All portfolios" chart view below.
  const allRows = holdings.map((h) => ({
    h,
    ...computeRow(h, prices[h.ticker], fxRates, buyFxByHolding.get(`${h.buy_currency}|${h.buy_date}`), fxRatesYesterday),
  }));
  const wholeAccountValue = allRows.reduce((s, r) => s + (r.currentValue || 0), 0);
  // Cost basis (Day 22, for the chart's "total buy-in" line) doesn't depend
  // on price data at all, so it's summed independently of currentValue — a
  // holding with a missing/stale price still contributes its buy-in.
  const wholeAccountCost = allRows.reduce((s, r) => s + (r.costBasis || 0), 0);

  // Per-portfolio totals — feeds each portfolio's own chart view. Holdings
  // with no portfolio_id aren't part of any portfolio's series (only the
  // whole-account one above).
  const valueByPortfolio = {};
  const costByPortfolio = {};
  for (const r of allRows) {
    if (!r.h.portfolio_id) continue;
    if (r.currentValue) valueByPortfolio[r.h.portfolio_id] = (valueByPortfolio[r.h.portfolio_id] || 0) + r.currentValue;
    if (r.costBasis) costByPortfolio[r.h.portfolio_id] = (costByPortfolio[r.h.portfolio_id] || 0) + r.costBasis;
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
  // Day 23 (a11y/UX review, "no data-source attribution/freshness"): name
  // the actual provider and the expected refresh cadence, not just a bare
  // timestamp — so a stale-looking price reads as "expected lag" rather
  // than "is this thing broken?". Individual rows also carry their own
  // per-ticker "as of" in a hover title (see renderHoldingsTable).
  document.getElementById("asOfLabel").textContent = latestAsOf
    ? `Prices as of: ${latestAsOf.toLocaleString()} · Source: Twelve Data · stocks/ETFs refresh ~daily, funds ~every 3.5 days`
    : "Prices as of: no data yet — run the Worker or wait for the next schedule · Source: Twelve Data";
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
          {
            user_id: currentUserId,
            date: todayStr,
            total_value: wholeAccountValue,
            total_cost: wholeAccountCost || null,
            base_currency: BASE_CURRENCY,
            source: "live_update",
          },
          { onConflict: "user_id,date" }
        )
      );
    }
    for (const [portfolioId, value] of Object.entries(valueByPortfolio)) {
      upserts.push(
        sb.from("portfolio_history").upsert(
          {
            user_id: currentUserId,
            portfolio_id: portfolioId,
            date: todayStr,
            total_value: value,
            total_cost: costByPortfolio[portfolioId] || null,
            base_currency: BASE_CURRENCY,
            source: "live_update",
          },
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
// Day 25 ("Sort persistence across reloads"): remembered in localStorage so
// the table doesn't reset to insertion order every time you reload — just a
// column name + direction, nothing sensitive.
let holdingsSortColumn = localStorage.getItem("holdingsSortColumn") || null;
let holdingsSortDirection = localStorage.getItem("holdingsSortDirection") === "-1" ? -1 : 1; // 1 = ascending, -1 = descending

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

  // Built up here (not just below, where it was originally only needed for
  // rendering) so the search filter below can also match on portfolio name.
  // Day 26 ("view-only sharing"): while viewing someone else's shared
  // portfolio, `allPortfolios` is still YOUR OWN list (loadPortfolios never
  // mixes the two, see its comment) — the owner's portfolio names live in
  // sharedOwnerPortfolioNameById instead, fetched once in viewSharedPortfolio.
  const portfolioNameById = sharedViewOwnerId ? sharedOwnerPortfolioNameById : Object.fromEntries(allPortfolios.map((p) => [p.id, p.name]));

  let rows = lastHoldingsRows;
  if (holdingsSearchTerm) {
    const term = holdingsSearchTerm.toLowerCase();
    // Day 25 ("Search across portfolio name too"): matches ticker OR the
    // holding's portfolio name (unassigned holdings just never match on the
    // portfolio half) — searching "retirement" now finds every holding in
    // that portfolio, not just ones whose ticker happens to contain it.
    rows = rows.filter(({ h }) => {
      const portfolioName = h.portfolio_id ? portfolioNameById[h.portfolio_id] || "" : "";
      return h.ticker.toLowerCase().includes(term) || portfolioName.toLowerCase().includes(term);
    });
  }

  if (rows.length === 0) {
    tbody.innerHTML =
      lastHoldingsRows.length === 0
        ? `<tr><td colspan="12">No holdings in this portfolio — add one below or switch to "All portfolios".</td></tr>`
        : `<tr><td colspan="12">No holdings match "${escapeHtml(holdingsSearchTerm)}".</td></tr>`;
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

  // Day 24 (review P1: "duplicate/un-aggregated holdings"). Adding/editing a
  // holding already auto-merges same-ticker rows when portfolio AND currency
  // both match exactly (see weightedMerge, Day 16) — but a ticker split
  // across different portfolios or currencies is a real, deliberate case the
  // app supports and doesn't (and shouldn't) silently combine. What was
  // missing was any visibility that it's happening at all. This groups the
  // currently-displayed rows by ticker and flags every ticker appearing more
  // than once with a small "×N lots" badge, hover-explained.
  const tickerGroups = {};
  for (const r of rows) (tickerGroups[r.h.ticker] ??= []).push(r);

  tbody.innerHTML = rows
    .map(({ h, currentValue, gainPct, dayChangePct, priceReturnPct, fxReturnPct, priceInBase, isStale, isFund, priceRow }) => {
      const lots = tickerGroups[h.ticker];
      const lotBadge =
        lots.length > 1
          ? (() => {
              const breakdown = lots
                .map((r) => `${r.h.quantity} @ ${fmtMoneyIn(r.h.buy_price, r.h.buy_currency)} (${r.h.portfolio_id ? portfolioNameById[r.h.portfolio_id] || "—" : "unassigned"})`)
                .join("; ");
              return ` <span class="lot-badge" title="${escapeHtml(h.ticker)} is split across ${lots.length} lots — ${escapeHtml(breakdown)}">×${lots.length} lots</span>`;
            })()
          : "";
      // Day 23 (a11y/UX review, "no data-source attribution/freshness"): the
      // "stale" flag alone doesn't say WHEN a price is from — this title
      // gives the exact fetch timestamp per row on hover/focus, not just a
      // single global "as of" figure in the header.
      const asOfTitle = priceRow?.as_of
        ? `Price as of ${new Date(priceRow.as_of).toLocaleString()} · Source: Twelve Data`
        : "No price data yet";
      // Day 24 (review P1: "gain/loss blends price & FX return") — a hover
      // title breaking the blended Day Δ % into its two components. Only
      // worth showing when there's an actual FX component to isolate (a
      // base-currency holding has fxReturnPct === 0 by definition).
      const dayChangeTitle =
        fxReturnPct != null && fxReturnPct !== 0
          ? `Price: ${fmtPct(priceReturnPct)} · FX: ${fmtPct(fxReturnPct)}`
          : priceReturnPct != null
            ? `Price: ${fmtPct(priceReturnPct)} (no FX component)`
            : "";
      // Day 26 ("Mobile card layout for holdings table"): every cell carries
      // a data-label matching its column header. On wide screens this is
      // unused (the CSS is scoped to the same @media breakpoint that turns
      // the table into stacked cards); on narrow screens a td::before reads
      // it, so each card shows "Qty  12" etc. instead of relying on a
      // header row that's no longer visible.
      return `
    <tr>
      <td data-label="Ticker">${h.ticker}${lotBadge}${h.notes ? `<span class="notes-badge" title="${escapeHtml(h.notes)}" aria-label="Note: ${escapeHtml(h.notes)}">📝</span>` : ""}</td>
      <td data-label="Portfolio">${h.portfolio_id ? escapeHtml(portfolioNameById[h.portfolio_id] || "—") : '<span class="nav-tag">unassigned</span>'}</td>
      <td data-label="Type">${h.asset_type}</td>
      <td class="editable-cell" data-label="Qty" data-field="quantity" data-id="${h.id}" tabindex="0" role="button" aria-label="Edit quantity for ${escapeHtml(h.ticker)}, currently ${h.quantity}">${h.quantity}</td>
      <td class="editable-cell" data-label="Buy Price" data-field="buy_price" data-id="${h.id}" data-currency="${escapeHtml(h.buy_currency)}" tabindex="0" role="button" aria-label="Edit buy price for ${escapeHtml(h.ticker)}, currently ${fmtMoneyIn(h.buy_price, h.buy_currency)}">${fmtMoneyIn(h.buy_price, h.buy_currency)}</td>
      <td data-label="Current Price" title="${escapeHtml(asOfTitle)}">${priceInBase != null ? fmtMoney(priceInBase) : "—"}${isFund ? '<span class="nav-tag">NAV</span>' : ""}${isStale ? '<span class="stale">stale</span>' : ""}</td>
      <td data-label="Trend" class="sparkline-cell" data-ticker="${escapeHtml(h.ticker)}"><span class="sparkline-placeholder" aria-hidden="true">…</span></td>
      <td data-label="Value">${fmtMoney(currentValue)}</td>
      <td data-label="Day %" class="${pctClass(dayChangePct)}"${dayChangeTitle ? ` title="${escapeHtml(dayChangeTitle)}"` : ""}>${fmtPct(dayChangePct)}</td>
      <td data-label="Gain/Loss %" class="${pctClass(gainPct)}">${fmtPct(gainPct)}</td>
      <td data-label="Weight">${totalValue ? fmtPct((currentValue / totalValue) * 100).replace("+", "") : "—"}</td>
      <td data-label="Actions">
        <button class="sell-btn" data-id="${h.id}" aria-label="Sell ${escapeHtml(h.ticker)}">Sell</button>
        <button class="edit-btn" data-id="${h.id}" aria-label="Edit ${escapeHtml(h.ticker)}">Edit</button>
        <button class="del-btn" data-id="${h.id}" aria-label="Delete ${escapeHtml(h.ticker)}">Delete</button>
      </td>
    </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const target = window.__holdingsById[btn.dataset.id];
      const ok = await showModal({
        type: "confirm",
        title: `Delete ${target?.ticker || "holding"}?`,
        message: 'This does NOT record a sale — use "Sell" instead if you actually disposed of it.',
        danger: true,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      await sb.from("holdings").delete().eq("id", btn.dataset.id);
      if (target) {
        // Day 25 ("Undo for delete"): event_date stores the ORIGINAL buy_date
        // (not today's deletion date) and asset_type rides along in a small
        // bracket tag in notes — neither has its own column on `transactions`,
        // and this is enough for the "Restore" button in Transaction History
        // to fully reconstruct the row. The tag is stripped before display
        // (see loadTransactions) so it doesn't look odd in the ledger.
        logTransaction({
          holdingId: target.id,
          portfolioId: target.portfolio_id,
          ticker: target.ticker,
          eventType: "delete",
          quantity: target.quantity,
          price: target.buy_price,
          currency: target.buy_currency,
          eventDate: target.buy_date,
          notes: `Deleted (not a sale) — no realized gain recorded. [asset_type:${target.asset_type}]`,
        });
      }
      loadHoldings();
      loadTransactions();
    })
  );

  tbody.querySelectorAll(".edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => startEdit(window.__holdingsById[btn.dataset.id]))
  );

  tbody.querySelectorAll(".sell-btn").forEach((btn) =>
    btn.addEventListener("click", () => startSell(window.__holdingsById[btn.dataset.id]))
  );

  // Day 26 ("Inline quantity/price editing"): click (or Enter/Space when
  // focused) turns the quantity or buy-price cell into a small number input,
  // in place, instead of always requiring the full Edit modal. Ticker,
  // currency, portfolio, and asset type still go through Edit — this only
  // covers the two fields someone is most likely to need to nudge after a
  // stock split, a data-entry typo, or a partial fill.
  tbody.querySelectorAll(".editable-cell").forEach((cell) => {
    cell.addEventListener("click", () => startInlineEdit(cell));
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startInlineEdit(cell);
      }
    });
  });

  updateSortIndicators();
  loadSparklines(rows.map((r) => r.h.ticker));
}

// Day 26 ("Sparklines in holdings table"). Reuses the shared `prices` cache
// (the same table computeRow reads "latest of" from) — this just also reads
// its last ~30 days of appended snapshots per ticker, instead of only the
// newest row. PostgREST has no clean "top N per group" query, so this pulls
// every row in the date window for the tickers on screen (cheap: normal use
// appends at most a few rows/ticker/day) and groups client-side. Best-effort
// and non-blocking — a failure here just leaves the "…" placeholder in place,
// it never breaks the rest of the holdings table.
async function loadSparklines(tickers) {
  const unique = [...new Set(tickers)];
  if (!unique.length) return;
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const { data, error } = await sb
    .from("prices")
    .select("ticker, price, as_of")
    .in("ticker", unique)
    .gte("as_of", since.toISOString())
    .not("price", "is", null)
    .order("as_of", { ascending: true });
  if (error || !data) return;

  const byTicker = {};
  for (const row of data) (byTicker[row.ticker] ??= []).push(row.price);

  document.querySelectorAll(".sparkline-cell").forEach((cell) => {
    const ticker = cell.dataset.ticker;
    const series = byTicker[ticker];
    if (!series || series.length < 2) {
      cell.innerHTML = '<span class="sparkline-empty" title="Not enough price history yet for a trend line">—</span>';
      return;
    }
    cell.innerHTML = renderSparklineSvg(series);
  });
}

// A tiny inline-SVG line chart — deliberately not reusing renderValueChart's
// smoothing/downsampling machinery (built for a big interactive chart with
// tooltips/axes); a sparkline is just "shape of the last 30 days," a plain
// straight-segment polyline through min/max-normalized points is enough.
function renderSparklineSvg(series) {
  const width = 64;
  const height = 24;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1; // flat line (min === max) — avoid divide-by-zero
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  const points = series.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(" ");
  const trendUp = series[series.length - 1] >= series[0];
  const color = trendUp ? "var(--green, #1a9c6b)" : "var(--red, #c0392b)";
  const title = `${trendUp ? "Up" : "Down"} over the last ${series.length} cached price point${series.length === 1 ? "" : "s"} (~30 days)`;
  return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" /></svg>`;
}

// Tracks the currently-open inline editor so a click elsewhere (or opening a
// second one) cleanly cancels the first rather than leaving two live inputs.
let activeInlineEdit = null;

function startInlineEdit(cell) {
  // Day 26 ("view-only sharing"): the Sell/Edit/Delete buttons are hidden
  // entirely via CSS while viewing someone else's shared portfolio (see
  // .shared-view-active in style.css), but this cell has no such visual
  // affordance to hide without breaking the table's column alignment — so
  // it needs its own explicit read-only guard instead.
  if (sharedViewOwnerId) return;
  if (cell.querySelector("input")) return; // already editing this cell
  if (activeInlineEdit && activeInlineEdit !== cell) cancelInlineEdit(activeInlineEdit);

  const holdingId = cell.dataset.id;
  const field = cell.dataset.field;
  const holding = window.__holdingsById?.[holdingId];
  if (!holding) return;

  const rawValue = field === "quantity" ? holding.quantity : holding.buy_price;
  cell.dataset.originalHtml = cell.innerHTML;
  activeInlineEdit = cell;

  const currencySuffix = field === "buy_price" ? ` <span class="inline-edit-currency">${escapeHtml(cell.dataset.currency || "")}</span>` : "";
  cell.innerHTML = `<input type="number" step="any" min="0" class="inline-edit-input" value="${rawValue}" aria-label="${field === "quantity" ? "Quantity" : "Buy price"}">${currencySuffix}`;
  const input = cell.querySelector("input");
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    activeInlineEdit = null;
    if (!commit) {
      cancelInlineEdit(cell);
      return;
    }
    const newValue = Number(input.value);
    if (!(newValue > 0) || newValue === rawValue) {
      cancelInlineEdit(cell);
      return;
    }
    await commitInlineEdit(cell, holding, field, newValue);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function cancelInlineEdit(cell) {
  if (cell.dataset.originalHtml != null) cell.innerHTML = cell.dataset.originalHtml;
  delete cell.dataset.originalHtml;
  if (activeInlineEdit === cell) activeInlineEdit = null;
}

async function commitInlineEdit(cell, holding, field, newValue) {
  const statusEl = document.getElementById("formStatus");
  const oldValue = field === "quantity" ? holding.quantity : holding.buy_price;
  const payload = { [field]: newValue };

  const { error } = await sb.from("holdings").update(payload).eq("id", holding.id);
  if (error) {
    if (statusEl) {
      statusEl.textContent = `Could not update ${field === "quantity" ? "quantity" : "buy price"}: ${error.message}`;
      statusEl.classList.add("negative");
    }
    cancelInlineEdit(cell);
    return;
  }
  if (statusEl) {
    statusEl.classList.remove("negative");
    statusEl.textContent = `Updated ${holding.ticker} ${field === "quantity" ? "quantity" : "buy price"} to ${field === "quantity" ? newValue : fmtMoneyIn(newValue, holding.buy_currency)}.`;
  }
  logTransaction({
    holdingId: holding.id,
    portfolioId: holding.portfolio_id,
    ticker: holding.ticker,
    eventType: "edit",
    quantity: field === "quantity" ? newValue : holding.quantity,
    price: field === "buy_price" ? newValue : holding.buy_price,
    currency: holding.buy_currency,
    eventDate: holding.buy_date,
    notes:
      field === "quantity"
        ? `Quantity changed inline from ${oldValue} to ${newValue}.`
        : `Buy price changed inline from ${fmtMoneyIn(oldValue, holding.buy_currency)} to ${fmtMoneyIn(newValue, holding.buy_currency)}.`,
  });
  delete cell.dataset.originalHtml;
  loadHoldings();
  loadTransactions();
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
    localStorage.setItem("holdingsSortColumn", holdingsSortColumn);
    localStorage.setItem("holdingsSortDirection", String(holdingsSortDirection));
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
  const twrEl = document.getElementById("twrValue");

  // Day 26 ("view-only sharing"): same explicit user_id filter as
  // loadHoldings — a shared viewer stays forced to "all portfolios" (see
  // viewSharedPortfolio), so this always reads the OWNER's whole-account
  // history via portfolio_value_history in that mode; RLS's own
  // "shared_viewers can read shared portfolio_value_history" policy still
  // only allows that when the share itself is whole-account (portfolio_id
  // is null) — a share scoped to one portfolio will correctly show no chart
  // here rather than a wrong one (documented limitation, not a bug).
  const viewingUserId = sharedViewOwnerId || currentUserId;
  const viewingAll = sharedViewOwnerId ? true : selectedPortfolioId === "__all__";
  const portfolioName = viewingAll ? null : allPortfolios.find((p) => p.id === selectedPortfolioId)?.name;
  heading.textContent = viewingAll ? "Portfolio Value Over Time" : `Portfolio Value Over Time — ${portfolioName || "…"}`;

  const query = viewingAll
    ? sb.from("portfolio_value_history").select("date, total_value, total_cost").eq("user_id", viewingUserId).order("date", { ascending: true })
    : sb
        .from("portfolio_history")
        .select("date, total_value, total_cost")
        .eq("user_id", viewingUserId)
        .eq("portfolio_id", selectedPortfolioId)
        .order("date", { ascending: true });

  const { data, error } = await query;

  if (error) {
    svg.innerHTML = "";
    caption.textContent = `Could not load history: ${error.message}`;
    fullHistoryData = [];
    if (twrEl) twrEl.textContent = "—";
    return;
  }
  if (!data || data.length === 0) {
    svg.innerHTML = "";
    svg.removeAttribute("aria-label");
    const tableBody = document.getElementById("chartDataTableBody");
    if (tableBody) tableBody.innerHTML = "";
    caption.textContent = viewingAll
      ? "No history yet — visit <WORKER_URL>/backfill-history once to seed it from real historical prices, or check back after a few scheduled runs."
      : "No history yet for this portfolio — it'll appear after your next edit/poll (live) or the next /backfill-history run (real historical prices).";
    fullHistoryData = [];
    if (twrEl) twrEl.textContent = "—";
    return;
  }

  fullHistoryData = data;
  if (twrEl) {
    const twr = computeTWR(fullHistoryData);
    twrEl.textContent = twr == null ? "—" : fmtPct(twr);
    twrEl.className = "value " + pctClass(twr);
  }
  if (benchmarkTicker) await ensureBenchmarkData(fullHistoryData[0].date);
  applyChartRange();
}

// Day 26 ("Time-weighted return"). Approximates each day's real market
// return by treating that day's CHANGE in cost basis (a buy raises it, a
// sell lowers it) as an external cash flow, backs that flow out of the
// day's value change, then geometrically links the daily returns. This is
// deliberately an approximation, not a textbook TWR: a true TWR needs the
// EXACT time of each cash flow within the period (a buy at market open vs.
// market close on the same day changes the answer), and this app only has
// one total_cost snapshot per day — same "closest available proxy, not a
// true point-in-time reconstruction" tradeoff already documented elsewhere
// in this codebase (e.g. buy-date FX, portfolio membership in history.js).
// Skips any day with missing total_cost on either side (treats that day's
// cash flow as zero) rather than guessing.
function computeTWR(history) {
  if (!history || history.length < 2) return null;
  let cumulative = 1;
  let any = false;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    if (!prev.total_value || prev.total_value <= 0) continue;
    const cf = curr.total_cost != null && prev.total_cost != null ? curr.total_cost - prev.total_cost : 0;
    const r = (curr.total_value - cf - prev.total_value) / prev.total_value;
    if (!Number.isFinite(r)) continue;
    cumulative *= 1 + r;
    any = true;
  }
  return any ? (cumulative - 1) * 100 : null;
}

// Day 26 ("Benchmark overlay") — a display preference, not account data, so
// it lives in localStorage rather than a table: it doesn't need to be
// shared across devices or visible to anyone else, and keeping it
// client-side means no schema/RLS surface for something this low-stakes.
let benchmarkTicker = localStorage.getItem("benchmarkTicker") || "";
let benchmarkRawSeriesCache = {}; // { [ticker]: { currency, series: {date: close}, since } }

async function ensureBenchmarkData(sinceDate) {
  if (!benchmarkTicker || !window.WORKER_URL) return;
  const cached = benchmarkRawSeriesCache[benchmarkTicker];
  if (cached && cached.since <= sinceDate) return; // already covers this range
  try {
    const res = await authedFetch(`${window.WORKER_URL}/benchmark-history?ticker=${encodeURIComponent(benchmarkTicker)}&since=${sinceDate}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    benchmarkRawSeriesCache[benchmarkTicker] = { currency: json.currency, series: json.series || {}, since: sinceDate };
  } catch (err) {
    console.warn(`Could not load benchmark history for ${benchmarkTicker}:`, err.message);
  }
}

const benchmarkSelectEl = document.getElementById("benchmarkSelect");
const benchmarkCustomInputEl = document.getElementById("benchmarkCustomInput");
// Restore whatever was picked last time — "custom" needs its text field
// shown and populated too, since <select> alone can't represent an
// arbitrary saved ticker.
if (benchmarkTicker && benchmarkSelectEl && ![...benchmarkSelectEl.options].some((o) => o.value === benchmarkTicker)) {
  benchmarkSelectEl.value = "custom";
  if (benchmarkCustomInputEl) {
    benchmarkCustomInputEl.style.display = "";
    benchmarkCustomInputEl.value = benchmarkTicker;
  }
} else if (benchmarkSelectEl) {
  benchmarkSelectEl.value = benchmarkTicker;
}

benchmarkSelectEl?.addEventListener("change", () => {
  if (benchmarkSelectEl.value === "custom") {
    benchmarkCustomInputEl.style.display = "";
    benchmarkCustomInputEl.focus();
    return; // wait for the custom ticker to actually be typed in (see below)
  }
  benchmarkCustomInputEl.style.display = "none";
  benchmarkTicker = benchmarkSelectEl.value;
  localStorage.setItem("benchmarkTicker", benchmarkTicker);
  loadValueHistory();
});

benchmarkCustomInputEl?.addEventListener("change", () => {
  const ticker = benchmarkCustomInputEl.value.trim().toUpperCase();
  if (!ticker) return;
  benchmarkTicker = ticker;
  localStorage.setItem("benchmarkTicker", benchmarkTicker);
  loadValueHistory();
});

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

// Day 26 ("Benchmark overlay") — carry-forward lookup into a { 'YYYY-MM-DD':
// price } series, same convention as history.js's server-side carryForward:
// markets are closed weekends/holidays, so any given plotted date uses the
// most recent trading-day close on or before it.
function carryForwardBenchmark(sortedDates, series, targetDate) {
  let result = null;
  for (const d of sortedDates) {
    if (d > targetDate) break;
    result = series[d];
  }
  return result;
}

// Rescales the benchmark's own closing-price series onto the SAME dollar
// axis as the portfolio-value line, indexed so both start from the same
// point on the chart's first plotted date — i.e. "if this ticker started at
// your actual starting value, where would it be now." This is what makes
// "which grew faster" readable as two lines sharing one y-axis, at the cost
// of the benchmark line no longer meaning "dollars actually invested in it."
function computeBenchmarkOverlay(points) {
  if (!benchmarkTicker || !points.length) return null;
  const entry = benchmarkRawSeriesCache[benchmarkTicker];
  if (!entry || !entry.series || !Object.keys(entry.series).length) return null;
  const sortedDates = Object.keys(entry.series).sort();
  const basePrice = carryForwardBenchmark(sortedDates, entry.series, points[0].date);
  const baseValue = points[0].total_value;
  if (!basePrice || !baseValue) return null;
  return points.map((p) => {
    const price = carryForwardBenchmark(sortedDates, entry.series, p.date);
    return price != null ? baseValue * (price / basePrice) : null;
  });
}

function renderValueChart(svg, rawPoints) {
  const points = downsample(rawPoints, 90);
  const width = 700;
  const height = 260; // taller than before — a wide-but-short chart is what made it look "stretched"
  const padX = 12;
  const padY = 30;

  const benchmarkValues = computeBenchmarkOverlay(points);
  const benchmarkLegendItem = document.getElementById("benchmarkLegendItem");
  if (benchmarkLegendItem) {
    benchmarkLegendItem.style.display = benchmarkValues ? "" : "none";
    const label = document.getElementById("benchmarkLegendLabel");
    if (label) label.textContent = `${benchmarkTicker} (indexed to your starting value)`;
  }

  const values = points.map((p) => p.total_value);
  // Day 22: the y-domain has to cover the cost-basis ("total buy-in") line
  // too, not just market value — otherwise a portfolio deep in the red would
  // clip its own buy-in line off the top of the chart. Day 26: same idea for
  // the benchmark overlay, when one's active.
  const costValues = points.map((p) => p.total_cost).filter((v) => v != null);
  const benchmarkValuesValid = (benchmarkValues || []).filter((v) => v != null);
  const allValues = values.concat(costValues, benchmarkValuesValid);
  // Axis floors at $0 (Day 22) rather than the lowest plotted value — with
  // two lines being compared directly (value vs. buy-in), a zoomed-in axis
  // exaggerates the visual size of any gap/step between them. Math.min(0, …)
  // just guards against an actual negative value ever showing up.
  const min = Math.min(0, ...allValues);
  const max = Math.max(...allValues);
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

  // Cost-basis ("total buy-in") line: dashed, muted, no fill — a reference
  // line rather than the headline series. Only draws through points that
  // actually have a total_cost (older backfilled rows from before this
  // column existed, or dates with no buy-date FX coverage yet, are left out
  // rather than guessed — same philosophy as the price/FX carry-forward
  // logic in history.js). In practice this is almost always every point.
  const costIndices = points.map((p, i) => i).filter((i) => points[i].total_cost != null);
  const costCoords = costIndices.map((i) => ({ x: xAt(i), y: yAt(points[i].total_cost) }));
  const costPath = costCoords.length >= 2 ? smoothPath(costCoords) : "";

  // Day 26 ("Benchmark overlay") — same dashed-reference-line treatment as
  // the cost-basis line above, just a different color so it's visually
  // distinct from both the market-value area and the buy-in line.
  const benchmarkIndices = benchmarkValues ? benchmarkValues.map((v, i) => i).filter((i) => benchmarkValues[i] != null) : [];
  const benchmarkCoords = benchmarkIndices.map((i) => ({ x: xAt(i), y: yAt(benchmarkValues[i]) }));
  const benchmarkPath = benchmarkCoords.length >= 2 ? smoothPath(benchmarkCoords) : "";

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
    ${costPath ? `<path d="${costPath}" fill="none" style="stroke:var(--muted)" stroke-width="1.75" stroke-dasharray="5,4" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
    ${benchmarkPath ? `<path d="${benchmarkPath}" fill="none" style="stroke:var(--accent)" stroke-width="1.75" stroke-dasharray="2,3" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
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
      // Day 22: second line shows the buy-in and the gap between it and
      // market value (i.e. unrealised profit/loss) as of that specific date
      // — only when this point actually has a cost-basis figure.
      let html = `${new Date(p.date).toLocaleDateString()} · ${fmtMoney(p.total_value)}`;
      if (p.total_cost != null) {
        const profit = p.total_value - p.total_cost;
        const profitColor = profit >= 0 ? "var(--green)" : "var(--red)";
        html += `<br><span style="color:var(--muted)">Buy-in: ${fmtMoney(p.total_cost)}</span> <span style="color:${profitColor}">(${profit >= 0 ? "+" : ""}${fmtMoney(profit)})</span>`;
      }
      tooltip.innerHTML = html;
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

  // Accessible name (WCAG 1.1.1): the SVG has no alt text of its own, so a
  // screen reader would otherwise announce nothing but "image". Summarize
  // the trend in one sentence — same information a sighted user gets at a
  // glance from the line's slope and colour.
  const startVal = values[0];
  const endVal = values[values.length - 1];
  const changePct = startVal ? (((endVal - startVal) / Math.abs(startVal)) * 100).toFixed(1) : null;
  const trendWord = trendUp ? "up" : "down";
  const rangeDesc = points.length ? `from ${new Date(points[0].date).toLocaleDateString()} to ${new Date(points[points.length - 1].date).toLocaleDateString()}` : "";
  svg.setAttribute(
    "aria-label",
    `Line chart of portfolio value ${rangeDesc}. Value ${trendWord} from ${fmtMoney(startVal)} to ${fmtMoney(endVal)}${changePct != null ? ` (${changePct >= 0 ? "+" : ""}${changePct}%)` : ""}. Full data is available in the table below the chart.`
  );

  // Text-table fallback (WCAG 1.1.1) — same points the SVG plots, as real
  // DOM text a screen reader can read row by row instead of relying on the
  // visual line shape.
  const tableBody = document.getElementById("chartDataTableBody");
  if (tableBody) {
    tableBody.innerHTML = points
      .map((p) => {
        const dateStr = new Date(p.date).toLocaleDateString();
        const costStr = p.total_cost != null ? fmtMoney(p.total_cost) : "—";
        return `<tr><td>${dateStr}</td><td>${fmtMoney(p.total_value)}</td><td>${costStr}</td></tr>`;
      })
      .join("");
  }
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
  form.notes.value = h.notes || "";
  document.getElementById("holdingFormTitle").textContent = `Edit ${h.ticker}`;
  document.getElementById("formSubmitBtn").textContent = "Save changes";
  document.getElementById("cancelEditBtn").style.display = "";
  form.scrollIntoView({ behavior: "smooth", block: "center" });
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
  holdingFormDirty = false;
  setDateToToday();
});

// Day 25 ("Unsaved-changes guard"): warns before closing the tab/reloading
// if the Add/Edit Holding form has input that was never submitted. Scoped to
// just this one form (not every form in the app) since it's the one people
// are most likely to spend real time filling in before getting interrupted.
let holdingFormDirty = false;
const holdingFormEl = document.getElementById("holdingForm");
holdingFormEl.addEventListener("input", () => {
  holdingFormDirty = true;
});
holdingFormEl.addEventListener("change", () => {
  holdingFormDirty = true;
});
window.addEventListener("beforeunload", (e) => {
  if (!holdingFormDirty) return;
  e.preventDefault();
  e.returnValue = ""; // required for the confirmation dialog to appear in most browsers
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
  document.getElementById("sellQuantityInput").focus();
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
  if (!showValidationError(e.target, errEl)) return;
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

  await withButtonLoading(document.getElementById("sellSubmitBtn"), "Recording…", async () => {
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

    logTransaction({
      holdingId: sellingHolding.id,
      portfolioId: sellingHolding.portfolio_id,
      ticker: sellingHolding.ticker,
      eventType: "sell",
      quantity: sellQuantity,
      price: sellPrice,
      currency: sellCurrency,
      eventDate: sellDate,
      notes:
        realizedGainAbs != null
          ? `Realized ${realizedGainAbs >= 0 ? "gain" : "loss"} of ${fmtMoney(realizedGainAbs)} (${fmtPct(realizedGainPct)}).`
          : null,
    });

    stopSell();
    loadHoldings();
    loadRealizedGains();
    loadTransactions();
  });
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

// Day 24 (review P1: "no transaction ledger / audit history"). Read-only —
// every row here comes from logTransaction() calls at the actual mutation
// points (add/edit/merge/sell/delete/import); this table never writes
// anything itself, same as Realized Gains above.
let lastTransactionRows = [];
const EVENT_TYPE_LABELS = { buy: "Buy", sell: "Sell", edit: "Edit", merge: "Merge", delete: "Delete", import: "Import" };

async function loadTransactions() {
  const tbody = document.getElementById("transactionsBody");
  if (!tbody) return;
  const { data, error } = await sb
    .from("transactions")
    .select("*")
    .order("event_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7">Could not load transaction history: ${error.message}</td></tr>`;
    return;
  }
  lastTransactionRows = data || [];
  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">No recorded activity yet — every buy, edit, sell, delete, and import will show up here.</td></tr>`;
    return;
  }

  // Day 25 ("Undo for delete"): the asset_type tag stashed in a delete
  // event's notes (see the del-btn handler) is machine-readable, not meant
  // for the human-facing ledger — strip it before display.
  const ASSET_TYPE_TAG_RE = /\s*\[asset_type:(\w+)\]/;

  tbody.innerHTML = data
    .map((r) => {
      const tagMatch = r.notes?.match(ASSET_TYPE_TAG_RE);
      const displayNotes = r.notes ? r.notes.replace(ASSET_TYPE_TAG_RE, "") : "—";
      const canRestore = r.event_type === "delete";
      return `
    <tr>
      <td>${new Date(r.event_date).toLocaleDateString()}</td>
      <td><span class="event-tag event-tag-${escapeHtml(r.event_type)}">${escapeHtml(EVENT_TYPE_LABELS[r.event_type] || r.event_type)}</span></td>
      <td>${escapeHtml(r.ticker)}</td>
      <td>${r.quantity ?? "—"}</td>
      <td>${r.price != null && r.currency ? fmtMoneyIn(r.price, r.currency) : "—"}</td>
      <td>${escapeHtml(displayNotes) || "—"}</td>
      <td>${
        canRestore
          ? `<button type="button" class="restore-btn" data-id="${r.id}" data-ticker="${escapeHtml(r.ticker)}" data-quantity="${r.quantity ?? ""}" data-price="${r.price ?? ""}" data-currency="${escapeHtml(r.currency || "")}" data-date="${r.event_date}" data-portfolio="${r.portfolio_id || ""}" data-asset-type="${tagMatch ? escapeHtml(tagMatch[1]) : "stock"}" aria-label="Restore deleted ${escapeHtml(r.ticker)}">Restore</button>`
          : ""
      }</td>
    </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".restore-btn").forEach((btn) => btn.addEventListener("click", () => restoreDeletedHolding(btn.dataset)));
}

// Day 25 ("Undo for delete"): reconstructs a holding row from a delete-type
// transaction's stashed fields, then runs it through the SAME merge-or-insert
// path as adding a holding normally (so restoring into a portfolio/currency
// that already holds this ticker merges correctly instead of creating a
// stray duplicate). Client-side only guard against double-restoring the same
// row twice in one page view — disables the button immediately on click;
// a genuine double-restore after a reload would just add the position twice,
// same as manually re-adding it, recoverable by deleting once more.
async function restoreDeletedHolding(data) {
  if (!currentUserId) return;
  const btn = document.querySelector(`.restore-btn[data-id="${data.id}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Restoring…";
  }
  const payload = {
    ticker: data.ticker,
    asset_type: ["stock", "etf", "fund"].includes(data.assetType) ? data.assetType : "stock",
    quantity: Number(data.quantity),
    buy_price: Number(data.price),
    buy_currency: data.currency || BASE_CURRENCY,
    buy_date: data.date,
    portfolio_id: data.portfolio || null,
  };
  if (!(payload.quantity > 0) || !(payload.buy_price > 0)) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Restore";
    }
    return;
  }

  const sameTicker = await findSameTickerHoldings(payload.ticker, payload.portfolio_id, null);
  const existing = sameTicker.find((h) => h.buy_currency === payload.buy_currency);
  if (existing) {
    const merged = weightedMerge(existing, payload);
    await sb.from("holdings").update(merged).eq("id", existing.id);
  } else {
    payload.user_id = currentUserId;
    await sb.from("holdings").insert(payload);
  }

  logTransaction({
    portfolioId: payload.portfolio_id,
    ticker: payload.ticker,
    eventType: "buy",
    quantity: payload.quantity,
    price: payload.buy_price,
    currency: payload.buy_currency,
    eventDate: payload.buy_date,
    notes: "Restored after being deleted.",
  });

  await loadHoldings();
  loadTransactions();
  await triggerPriceRefresh();
  loadHoldings();
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

document.getElementById("exportTransactionsBtn")?.addEventListener("click", () => {
  if (!lastTransactionRows.length) return;
  const columns = [
    { label: "Date", value: (r) => r.event_date },
    { label: "Event", value: (r) => EVENT_TYPE_LABELS[r.event_type] || r.event_type },
    { label: "Ticker", value: (r) => r.ticker },
    { label: "Quantity", value: (r) => r.quantity ?? "" },
    { label: "Price", value: (r) => r.price ?? "" },
    { label: "Currency", value: (r) => r.currency ?? "" },
    { label: "Notes", value: (r) => r.notes ?? "" },
  ];
  downloadCsv(`transaction_history_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(lastTransactionRows, columns));
});

// --- CSV import (Day 24, review P1: "no import") --------------------------
// Symmetric with Export CSV: same column set (Ticker/Portfolio/Type/
// Quantity/Buy price/Buy currency/Buy date — the computed columns Export
// also writes, like Current price/Value/Gain-loss %, are simply ignored on
// the way back in). Header matching is case-insensitive with a few common
// aliases per column (symbol/qty/shares/etc.) so a reasonably-shaped export
// from elsewhere has a decent chance of working too, without hand-coding
// any specific broker's exact format.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const IMPORT_HEADER_ALIASES = {
  ticker: ["ticker", "symbol"],
  portfolio: ["portfolio"],
  asset_type: ["type", "asset_type", "asset type"],
  quantity: ["quantity", "qty", "shares"],
  buy_price: ["buy price", "price", "buy_price", "cost", "cost basis"],
  buy_currency: ["buy currency", "currency", "buy_currency"],
  buy_date: ["buy date", "date", "buy_date", "purchase date"],
};

document.getElementById("importHoldingsBtn").addEventListener("click", () => {
  document.getElementById("importHoldingsFile").click();
});

document.getElementById("importHoldingsFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const statusEl = document.getElementById("importStatus");
  e.target.value = ""; // reset so re-selecting the same file still fires "change"
  if (!file) return;
  if (!currentUserId) {
    statusEl.className = "import-status negative";
    statusEl.textContent = "Not signed in — please sign in again.";
    return;
  }

  statusEl.className = "import-status";
  statusEl.textContent = "Reading file…";

  let text;
  try {
    text = await file.text();
  } catch (err) {
    statusEl.className = "import-status negative";
    statusEl.textContent = `Could not read file: ${err.message}`;
    return;
  }

  const rows = parseCsv(text);
  if (rows.length < 2) {
    statusEl.className = "import-status negative";
    statusEl.textContent = "No data rows found in that file.";
    return;
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colIndex = {};
  for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) colIndex[field] = idx;
  }
  if (colIndex.ticker == null || colIndex.quantity == null || colIndex.buy_price == null) {
    statusEl.className = "import-status negative";
    statusEl.textContent = 'CSV needs at least "Ticker", "Quantity", and "Buy price" columns (matches the Export CSV format).';
    return;
  }

  statusEl.textContent = "Importing…";

  let imported = 0;
  let merged = 0;
  let skipped = 0;
  const errors = [];
  const portfolioIdByName = {}; // cache within this one import run

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ticker = (r[colIndex.ticker] || "").trim().toUpperCase();
    const quantity = Number(r[colIndex.quantity]);
    const buyPrice = Number(r[colIndex.buy_price]);
    const assetTypeRaw = colIndex.asset_type != null ? (r[colIndex.asset_type] || "").trim().toLowerCase() : "stock";
    const assetType = ["stock", "etf", "fund"].includes(assetTypeRaw) ? assetTypeRaw : "stock";
    const buyCurrency = (colIndex.buy_currency != null ? (r[colIndex.buy_currency] || "").trim().toUpperCase() : "") || BASE_CURRENCY;
    const buyDateRaw = colIndex.buy_date != null ? (r[colIndex.buy_date] || "").trim() : "";
    const buyDate = /^\d{4}-\d{2}-\d{2}$/.test(buyDateRaw) ? buyDateRaw : null;
    const portfolioName = colIndex.portfolio != null ? (r[colIndex.portfolio] || "").trim() : "";

    if (!ticker || !(quantity > 0) || !(buyPrice > 0) || !buyDate) {
      skipped++;
      errors.push(`Row ${i + 1}: missing/invalid ticker, quantity, buy price, or buy date (expects YYYY-MM-DD).`);
      continue;
    }

    let portfolioId = null;
    if (portfolioName) {
      const key = portfolioName.toLowerCase();
      if (!(key in portfolioIdByName)) {
        const existingP = allPortfolios.find((p) => p.name.toLowerCase() === key);
        if (existingP) {
          portfolioIdByName[key] = existingP.id;
        } else {
          const { data: newP, error: pErr } = await sb.from("portfolios").insert({ user_id: currentUserId, name: portfolioName }).select().single();
          if (pErr) {
            errors.push(`Row ${i + 1}: could not create portfolio "${portfolioName}": ${pErr.message}`);
            portfolioIdByName[key] = null;
          } else {
            portfolioIdByName[key] = newP.id;
            allPortfolios.push(newP);
          }
        }
      }
      portfolioId = portfolioIdByName[key];
    }

    const payload = { ticker, asset_type: assetType, quantity, buy_price: buyPrice, buy_currency: buyCurrency, buy_date: buyDate, portfolio_id: portfolioId };

    const sameTicker = await findSameTickerHoldings(ticker, portfolioId, null);
    const existing = sameTicker.find((h) => h.buy_currency === buyCurrency);
    if (existing) {
      const mergedRow = weightedMerge(existing, payload);
      const { error } = await sb.from("holdings").update(mergedRow).eq("id", existing.id);
      if (error) {
        skipped++;
        errors.push(`Row ${i + 1} (${ticker}): ${error.message}`);
        continue;
      }
      merged++;
      logTransaction({
        holdingId: existing.id,
        portfolioId,
        ticker,
        eventType: "import",
        quantity,
        price: buyPrice,
        currency: buyCurrency,
        eventDate: buyDate,
        notes: "Imported via CSV — merged into an existing lot.",
      });
    } else {
      payload.user_id = currentUserId;
      const { error } = await sb.from("holdings").insert(payload);
      if (error) {
        skipped++;
        errors.push(`Row ${i + 1} (${ticker}): ${error.message}`);
        continue;
      }
      imported++;
      logTransaction({ portfolioId, ticker, eventType: "import", quantity, price: buyPrice, currency: buyCurrency, eventDate: buyDate });
    }
  }

  statusEl.className = imported + merged > 0 ? "import-status positive" : "import-status negative";
  let summary = `Imported ${imported} new, merged ${merged}, skipped ${skipped}.`;
  if (errors.length) summary += ` First issue: ${errors[0]}`;
  statusEl.textContent = summary;

  await loadPortfolios();
  loadTransactions();
  await triggerPriceRefresh();
  loadHoldings();
});

// --- Account: data export + self-serve deletion (Day 24) -----------------
function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("exportAllDataBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const errEl = document.getElementById("accountError");
  const hintEl = document.getElementById("accountHint");
  errEl.textContent = "";
  hintEl.textContent = "";
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Exporting…";
  try {
    // Every query below is scoped to this account by RLS (auth.uid() =
    // user_id) exactly like the rest of the app — no extra filtering needed
    // here, same guarantee already verified live (Day 23, S-2).
    const tables = ["holdings", "portfolios", "realized_gains", "transactions", "portfolio_value_history", "portfolio_history"];
    const results = await Promise.all(tables.map((t) => sb.from(t).select("*")));
    const bundle = { exported_at: new Date().toISOString(), base_currency: BASE_CURRENCY };
    tables.forEach((t, i) => {
      if (results[i].error) throw new Error(`${t}: ${results[i].error.message}`);
      bundle[t] = results[i].data;
    });
    downloadJson(`portfolio_tracker_export_${new Date().toISOString().slice(0, 10)}.json`, bundle);
    hintEl.textContent = "Export downloaded.";
  } catch (err) {
    errEl.textContent = `Export failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById("deleteAccountBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const errEl = document.getElementById("accountError");
  const hintEl = document.getElementById("accountHint");
  errEl.textContent = "";
  hintEl.textContent = "";

  const typed = await showModal({
    type: "prompt",
    title: "Delete your account?",
    message:
      'This permanently deletes your account and ALL of your data — holdings, portfolios, realized gains, transaction history, and value history. This cannot be undone. Type DELETE to confirm.',
    placeholder: "DELETE",
    danger: true,
    confirmLabel: "Delete my account",
  });
  if (typed == null) return; // cancelled
  if (typed !== "DELETE") {
    errEl.textContent = 'Account not deleted — you need to type "DELETE" exactly to confirm.';
    return;
  }
  if (!window.WORKER_URL) {
    errEl.textContent = "Can't reach the Worker (WORKER_URL not configured) — account not deleted.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Deleting…";
  try {
    const res = await authedFetch(`${window.WORKER_URL}/delete-account`, { method: "POST" });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    await sb.auth.signOut();
    showLogin();
    document.getElementById("loginHint").textContent = "Your account and all associated data have been deleted.";
  } catch (err) {
    errEl.textContent = `Could not delete account: ${err.message}`;
    btn.disabled = false;
    btn.textContent = "Delete my account";
  }
});

// --- Portfolios: an optional grouping layer on top of holdings ------------
// Scope decision (see README/schema.sql): portfolios filter the holdings
// table, summary stats, allocation, and the value chart (loadValueHistory,
// below). The daily email and realized gains stay whole-account — splitting
// those too would mean multiple emails per user each morning, out of scope.
let allPortfolios = [];
let selectedPortfolioId = "__all__";

async function loadPortfolios() {
  // Day 26 ("view-only sharing"): explicit user_id filter — without it, if
  // anyone has shared a portfolio with you, RLS's additive "shared viewers
  // can read shared portfolios" policy would mix THEIR portfolio names into
  // YOUR OWN filter dropdown/add-holding form. This list is always your own
  // portfolios; a shared owner's portfolio names are looked up separately
  // (see viewSharedPortfolio / sharedOwnerPortfolioNameById) and never go
  // through this function or the `allPortfolios` global.
  const { data, error } = await sb.from("portfolios").select("*").eq("user_id", currentUserId).order("created_at");
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

  // Day 26 ("view-only sharing") — lets you scope an invite to one specific
  // portfolio instead of always sharing everything.
  const shareSelect = document.getElementById("sharePortfolioSelect");
  if (shareSelect) {
    const keepShareSelection = shareSelect.value;
    shareSelect.innerHTML =
      `<option value="">All portfolios</option>` + allPortfolios.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    if (allPortfolios.some((p) => p.id === keepShareSelection)) shareSelect.value = keepShareSelection;
  }

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

// Day 24 (review P1: duplicate/un-aggregated holdings) — warn on blur if
// this ticker already exists under a different portfolio/currency, so it's
// clear BEFORE submitting that this will land as a separate lot rather than
// merge (see weightedMerge/findSameTickerHoldings, which only auto-merge on
// an EXACT ticker+portfolio+currency match). Reads from the already-loaded
// lastHoldingsRows — no extra round trip.
tickerInputEl.addEventListener("blur", () => {
  const hintEl = document.getElementById("tickerDuplicateHint");
  const ticker = tickerInputEl.value.trim().toUpperCase();
  if (!ticker) {
    hintEl.textContent = "";
    return;
  }
  const portfolioId = document.getElementById("portfolioFormSelect").value || null;
  const buyCurrency = document.querySelector('#holdingForm select[name="buy_currency"]')?.value;
  const others = lastHoldingsRows.filter(
    (r) => r.h.ticker === ticker && r.h.id !== editingHoldingId && !(r.h.portfolio_id === portfolioId && r.h.buy_currency === buyCurrency)
  );
  if (others.length) {
    const portfolioNameById = Object.fromEntries(allPortfolios.map((p) => [p.id, p.name]));
    const breakdown = others
      .map((r) => `${r.h.quantity} @ ${fmtMoneyIn(r.h.buy_price, r.h.buy_currency)} in ${r.h.portfolio_id ? portfolioNameById[r.h.portfolio_id] || "—" : "unassigned"}`)
      .join("; ");
    hintEl.textContent = `You already hold ${ticker} elsewhere (${breakdown}) — this will be added as a separate lot, not merged, since the portfolio/currency don't match exactly.`;
  } else {
    hintEl.textContent = "";
  }
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
  // Day 26 ("view-only sharing"): explicit user_id filter, not just RLS —
  // now that a shared viewer's SELECT policy can return ANOTHER account's
  // holdings too, an unfiltered query here would let someone else's shared
  // tickers wrongly count as "you already own this" duplicates.
  let q = sb.from("holdings").select("*").eq("ticker", ticker).eq("user_id", currentUserId);
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
  if (!showValidationError(e.target, errEl)) return;
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
    notes: form.get("notes")?.trim() || null,
  };
  if (!payload.ticker) return (errEl.textContent = "Ticker is required.");
  if (!(payload.quantity > 0)) return (errEl.textContent = "Quantity must be positive.");
  if (!(payload.buy_price > 0)) return (errEl.textContent = "Buy price must be positive.");

  await withButtonLoading(document.getElementById("formSubmitBtn"), editingHoldingId ? "Saving…" : "Adding…", async () => {
    if (editingHoldingId) {
      const before = window.__holdingsById?.[editingHoldingId] || null;
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
          logTransaction({
            holdingId: collision.id,
            portfolioId: payload.portfolio_id,
            ticker: payload.ticker,
            eventType: "edit",
            quantity: payload.quantity,
            price: payload.buy_price,
            currency: payload.buy_currency,
            eventDate: payload.buy_date,
            notes: `Edited and merged into an existing lot — now ${merged.quantity} @ weighted avg ${fmtMoneyIn(merged.buy_price, payload.buy_currency)}.`,
          });
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
        logTransaction({
          holdingId: editingHoldingId,
          portfolioId: payload.portfolio_id,
          ticker: payload.ticker,
          eventType: "edit",
          quantity: payload.quantity,
          price: payload.buy_price,
          currency: payload.buy_currency,
          eventDate: payload.buy_date,
          notes: before
            ? `Changed from ${before.quantity} @ ${fmtMoneyIn(before.buy_price, before.buy_currency)} (${before.buy_date}) to ${payload.quantity} @ ${fmtMoneyIn(payload.buy_price, payload.buy_currency)} (${payload.buy_date}).`
            : null,
        });
      }
      stopEdit();
      e.target.reset();
      holdingFormDirty = false;
      setDateToToday();
      setPortfolioFormDefault();
      loadHoldings();
      loadTransactions();
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
      logTransaction({
        holdingId: existing.id,
        portfolioId: payload.portfolio_id,
        ticker: payload.ticker,
        eventType: "buy",
        quantity: payload.quantity,
        price: payload.buy_price,
        currency: payload.buy_currency,
        eventDate: payload.buy_date,
        notes: `Merged into an existing lot — now ${merged.quantity} @ weighted avg ${fmtMoneyIn(merged.buy_price, payload.buy_currency)}.`,
      });
    } else {
      const { error } = await sb.from("holdings").insert(payload);
      if (error) {
        errEl.textContent = `Could not save: ${error.message}`;
        return;
      }
      if (sameTicker.length) {
        statusEl.textContent = `Added as its own row — an existing ${payload.ticker} holding in this portfolio is in ${sameTicker[0].buy_currency}, so it wasn't merged.`;
      }
      logTransaction({
        portfolioId: payload.portfolio_id,
        ticker: payload.ticker,
        eventType: "buy",
        quantity: payload.quantity,
        price: payload.buy_price,
        currency: payload.buy_currency,
        eventDate: payload.buy_date,
      });
    }

    e.target.reset();
    holdingFormDirty = false;
    setDateToToday(); // form.reset() clears the date field back to blank — refill it
    setPortfolioFormDefault(); // form.reset() also clears this back to "No portfolio" — refill from the active filter
    loadHoldings(); // show the new/merged row immediately (price will say "no data" until the refresh below lands)
    loadTransactions();
    await triggerPriceRefresh();
    loadHoldings(); // reload once the Worker has cached a price for the new ticker
  });
});

// Default the buy-date field to today so adding a holding usually needs zero
// typing in that field — click the calendar icon only if you bought it on a
// different day.
function setDateToToday() {
  const input = document.getElementById("buyDateInput");
  if (input) input.value = new Date().toISOString().slice(0, 10);
}

// ── Day 26: Watchlist ────────────────────────────────────────────────────
// Tickers you don't own — separate table (schema.sql), never touches
// quantity/cost-basis math. Prices come from the same shared `prices` cache
// the holdings table reads (fetchLatestPrices, defined near the top of this
// file), just displayed in the ticker's own trading currency rather than
// converted to base — there's no quantity here to make a base-currency total
// meaningful.
async function loadWatchlist() {
  const tbody = document.getElementById("watchlistBody");
  const { data, error } = await sb.from("watchlist").select("*").order("created_at");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="5">Failed to load watchlist: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5">Nothing on your watchlist yet.</td></tr>`;
    return;
  }
  const tickers = [...new Set(data.map((w) => w.ticker))];
  const prices = await fetchLatestPrices(tickers).catch(() => ({}));
  tbody.innerHTML = data
    .map((w) => {
      const p = prices[w.ticker];
      const dayPct = p && p.price != null && p.previous_close ? ((p.price - p.previous_close) / p.previous_close) * 100 : null;
      return `<tr>
        <td data-label="Ticker">${escapeHtml(w.ticker)}</td>
        <td data-label="Price">${p && p.price != null ? fmtMoneyIn(p.price, p.currency || "") : "—"}</td>
        <td data-label="Day %" class="${pctClass(dayPct)}">${fmtPct(dayPct)}</td>
        <td data-label="Notes">${escapeHtml(w.notes || "")}</td>
        <td data-label="Actions"><button type="button" class="del-btn watchlist-del-btn" data-id="${w.id}" aria-label="Remove ${escapeHtml(w.ticker)} from watchlist">Remove</button></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll(".watchlist-del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await sb.from("watchlist").delete().eq("id", btn.dataset.id);
      loadWatchlist();
    })
  );
}

document.getElementById("watchlistForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("watchlistError");
  errEl.textContent = "";
  if (!currentUserId) {
    errEl.textContent = "Not signed in — please sign in again.";
    return;
  }
  const form = new FormData(e.target);
  const ticker = form.get("ticker").trim().toUpperCase();
  const notes = form.get("notes")?.trim() || null;
  if (!ticker) {
    errEl.textContent = "Ticker is required.";
    return;
  }
  await withButtonLoading(document.getElementById("watchlistSubmitBtn"), "Adding…", async () => {
    const { error } = await sb.from("watchlist").insert({ user_id: currentUserId, ticker, notes });
    if (error) {
      // idx_watchlist_user_ticker (schema.sql) — same ticker added twice.
      errEl.textContent = error.message.includes("duplicate") ? `${ticker} is already on your watchlist.` : error.message;
      return;
    }
    e.target.reset();
    loadWatchlist();
    triggerPriceRefresh(); // make sure a brand-new ticker gets a price cached soon
  });
});

// ── Day 26: Price alerts ─────────────────────────────────────────────────
// Checked once per scheduled/manual Worker run (see worker/src/index.js
// processUserDailyJob), NOT continuously — this section just manages the
// list of thresholds and shows whether/when each one fired.
async function loadPriceAlerts() {
  const tbody = document.getElementById("priceAlertsBody");
  const { data, error } = await sb.from("price_alerts").select("*").order("created_at", { ascending: false });
  if (error) {
    tbody.innerHTML = `<tr><td colspan="5">Failed to load alerts: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5">No price alerts set yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = data
    .map((a) => {
      const status = a.active
        ? "Active"
        : a.triggered_at
          ? `Triggered ${new Date(a.triggered_at).toLocaleDateString()} at ${a.triggered_price}`
          : "Inactive";
      return `<tr>
        <td data-label="Ticker">${escapeHtml(a.ticker)}</td>
        <td data-label="Condition">${a.condition === "above" ? "Rises above" : "Falls below"}</td>
        <td data-label="Target">${a.target_price}</td>
        <td data-label="Status">${escapeHtml(status)}</td>
        <td data-label="Actions"><button type="button" class="del-btn alert-del-btn" data-id="${a.id}" aria-label="Delete alert for ${escapeHtml(a.ticker)}">Delete</button></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll(".alert-del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await sb.from("price_alerts").delete().eq("id", btn.dataset.id);
      loadPriceAlerts();
    })
  );
}

document.getElementById("priceAlertForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("priceAlertError");
  errEl.textContent = "";
  if (!currentUserId) {
    errEl.textContent = "Not signed in — please sign in again.";
    return;
  }
  const form = new FormData(e.target);
  const ticker = form.get("ticker").trim().toUpperCase();
  const condition = form.get("condition");
  const targetPrice = Number(form.get("target_price"));
  if (!ticker) {
    errEl.textContent = "Ticker is required.";
    return;
  }
  if (!(targetPrice > 0)) {
    errEl.textContent = "Target price must be positive.";
    return;
  }
  await withButtonLoading(document.getElementById("priceAlertSubmitBtn"), "Setting…", async () => {
    const { error } = await sb.from("price_alerts").insert({ user_id: currentUserId, ticker, condition, target_price: targetPrice });
    if (error) {
      errEl.textContent = error.message;
      return;
    }
    e.target.reset();
    loadPriceAlerts();
  });
});

// ── Day 26: Dividend log ─────────────────────────────────────────────────
// Manual entry — see schema.sql's dividends comment for why (no free
// dividends data source is wired up). Purely informational: doesn't feed
// into any gain/loss math elsewhere in the app.
async function loadDividends() {
  const tbody = document.getElementById("dividendsBody");
  const totalHint = document.getElementById("dividendTotalHint");
  const { data, error } = await sb.from("dividends").select("*").order("pay_date", { ascending: false });
  if (error) {
    tbody.innerHTML = `<tr><td colspan="5">Failed to load dividends: ${escapeHtml(error.message)}</td></tr>`;
    totalHint.textContent = "";
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5">No dividends logged yet.</td></tr>`;
    totalHint.textContent = "";
    return;
  }
  // Summed per currency rather than converted to one total — converting
  // would need an FX rate per dividend's pay_date, which this feature
  // doesn't fetch (same "keep it simple, manual entry" scope as the rest of
  // this table).
  const totalsByCurrency = {};
  for (const d of data) totalsByCurrency[d.currency] = (totalsByCurrency[d.currency] || 0) + d.amount;
  totalHint.textContent = `Total received: ${Object.entries(totalsByCurrency)
    .map(([ccy, amt]) => fmtMoneyIn(amt, ccy))
    .join(" + ")}`;
  tbody.innerHTML = data
    .map(
      (d) => `<tr>
        <td data-label="Date">${d.pay_date}</td>
        <td data-label="Ticker">${escapeHtml(d.ticker)}</td>
        <td data-label="Amount">${fmtMoneyIn(d.amount, d.currency)}</td>
        <td data-label="Notes">${escapeHtml(d.notes || "")}</td>
        <td data-label="Actions"><button type="button" class="del-btn dividend-del-btn" data-id="${d.id}" aria-label="Delete dividend entry for ${escapeHtml(d.ticker)} on ${d.pay_date}">Delete</button></td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll(".dividend-del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await sb.from("dividends").delete().eq("id", btn.dataset.id);
      loadDividends();
    })
  );
}

document.getElementById("dividendForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("dividendError");
  errEl.textContent = "";
  if (!currentUserId) {
    errEl.textContent = "Not signed in — please sign in again.";
    return;
  }
  const form = new FormData(e.target);
  const ticker = form.get("ticker").trim().toUpperCase();
  const amount = Number(form.get("amount"));
  const currency = form.get("currency");
  const payDate = form.get("pay_date");
  const notes = form.get("notes")?.trim() || null;
  if (!ticker) {
    errEl.textContent = "Ticker is required.";
    return;
  }
  if (!(amount > 0)) {
    errEl.textContent = "Amount must be positive.";
    return;
  }
  if (!payDate) {
    errEl.textContent = "Pay date is required.";
    return;
  }
  await withButtonLoading(document.getElementById("dividendSubmitBtn"), "Logging…", async () => {
    const { error } = await sb.from("dividends").insert({ user_id: currentUserId, ticker, amount, currency, pay_date: payDate, notes });
    if (error) {
      errEl.textContent = error.message;
      return;
    }
    e.target.reset();
    document.getElementById("dividendDateInput").value = new Date().toISOString().slice(0, 10);
    loadDividends();
  });
});

// ── Day 26: Target allocation + rebalancing hints ───────────────────────
// "Current %" is read from lastHoldingsRows/lastHoldingsTotalValue — the
// SAME already-computed, portfolio-filter-aware rows the holdings table and
// Allocation section use — so this respects whatever portfolio filter is
// currently selected without a separate query.
async function loadTargetAllocations() {
  const tbody = document.getElementById("targetAllocationBody");
  const { data, error } = await sb.from("target_allocations").select("*").order("created_at");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="5">Failed to load targets: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5">No targets set yet — add one above.</td></tr>`;
    return;
  }

  const totalValue = lastHoldingsTotalValue;
  const currentByAssetType = {};
  const currentByTicker = {};
  for (const r of lastHoldingsRows) {
    if (!r.currentValue || !totalValue) continue;
    const w = (r.currentValue / totalValue) * 100;
    currentByAssetType[r.h.asset_type] = (currentByAssetType[r.h.asset_type] || 0) + w;
    currentByTicker[r.h.ticker] = (currentByTicker[r.h.ticker] || 0) + w;
  }

  tbody.innerHTML = data
    .map((t) => {
      const current = t.key_type === "asset_type" ? currentByAssetType[t.key_value] || 0 : currentByTicker[t.key_value] || 0;
      const gap = t.target_pct - current;
      const label = t.key_type === "asset_type" ? `${t.key_value} (asset type)` : t.key_value;
      return `<tr>
        <td data-label="Target">${escapeHtml(label)}</td>
        <td data-label="Target %">${t.target_pct.toFixed(1)}%</td>
        <td data-label="Current %">${current.toFixed(1)}%</td>
        <td data-label="Gap" class="${pctClass(gap)}">${gap >= 0 ? "+" : ""}${gap.toFixed(1)}%</td>
        <td data-label="Actions"><button type="button" class="del-btn target-del-btn" data-id="${t.id}" aria-label="Remove target for ${escapeHtml(label)}">Remove</button></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll(".target-del-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await sb.from("target_allocations").delete().eq("id", btn.dataset.id);
      loadTargetAllocations();
    })
  );
}

document.getElementById("targetKeyType").addEventListener("change", (e) => {
  const isTicker = e.target.value === "ticker";
  document.getElementById("targetKeyValueSelect").style.display = isTicker ? "none" : "";
  document.getElementById("targetKeyValueTicker").style.display = isTicker ? "" : "none";
});

document.getElementById("targetAllocationForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("targetAllocationError");
  errEl.textContent = "";
  if (!currentUserId) {
    errEl.textContent = "Not signed in — please sign in again.";
    return;
  }
  const form = new FormData(e.target);
  const keyType = form.get("key_type");
  const keyValue = keyType === "ticker" ? form.get("key_value_ticker").trim().toUpperCase() : form.get("key_value");
  const targetPct = Number(form.get("target_pct"));
  if (!keyValue) {
    errEl.textContent = "Pick an asset type or enter a ticker.";
    return;
  }
  if (!(targetPct >= 0 && targetPct <= 100)) {
    errEl.textContent = "Target % must be between 0 and 100.";
    return;
  }
  await withButtonLoading(document.getElementById("targetAllocationSubmitBtn"), "Saving…", async () => {
    // Upsert-by-key (idx_target_allocations_user_key, schema.sql): setting a
    // target for the same key twice replaces it rather than duplicating.
    const { error } = await sb
      .from("target_allocations")
      .upsert({ user_id: currentUserId, key_type: keyType, key_value: keyValue, target_pct: targetPct }, { onConflict: "user_id,key_type,key_value" });
    if (error) {
      errEl.textContent = error.message;
      return;
    }
    e.target.reset();
    document.getElementById("targetKeyValueTicker").style.display = "none";
    document.getElementById("targetKeyValueSelect").style.display = "";
    loadTargetAllocations();
  });
});

// ── Day 26: Multi-account/household view — view-only sharing ───────────
// Inviting by email needs the invitee's Supabase Auth user id, which the
// anon key can't resolve on its own — see the Worker's /find-user-by-email
// route (worker/src/index.js). Everything after that (inserting the
// portfolio_shares row) is a normal RLS-scoped write, same as everywhere
// else in this file.
async function loadSharing() {
  const grantedBody = document.getElementById("sharesGrantedBody");
  const receivedBody = document.getElementById("sharesReceivedBody");

  const [{ data: granted, error: grantedErr }, { data: received, error: receivedErr }] = await Promise.all([
    sb.from("portfolio_shares").select("*").eq("owner_user_id", currentUserId).order("created_at"),
    sb.from("portfolio_shares").select("*").neq("owner_user_id", currentUserId).order("created_at"),
  ]);

  const scopeLabel = (share) => (share.portfolio_id ? allPortfolios.find((p) => p.id === share.portfolio_id)?.name || "One portfolio" : "All portfolios");

  if (grantedErr) {
    grantedBody.innerHTML = `<tr><td colspan="3">Failed to load: ${escapeHtml(grantedErr.message)}</td></tr>`;
  } else if (!granted.length) {
    grantedBody.innerHTML = `<tr><td colspan="3">You haven't shared your portfolio with anyone.</td></tr>`;
  } else {
    grantedBody.innerHTML = granted
      .map(
        (s) => `<tr>
          <td data-label="Email">${escapeHtml(s.shared_with_email)}</td>
          <td data-label="Scope">${escapeHtml(scopeLabel(s))}</td>
          <td data-label="Actions"><button type="button" class="del-btn share-revoke-btn" data-id="${s.id}" aria-label="Revoke access for ${escapeHtml(s.shared_with_email)}">Revoke</button></td>
        </tr>`
      )
      .join("");
    grantedBody.querySelectorAll(".share-revoke-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await sb.from("portfolio_shares").delete().eq("id", btn.dataset.id);
        loadSharing();
      })
    );
  }

  if (receivedErr) {
    receivedBody.innerHTML = `<tr><td colspan="3">Failed to load: ${escapeHtml(receivedErr.message)}</td></tr>`;
  } else if (!received.length) {
    receivedBody.innerHTML = `<tr><td colspan="3">No one has shared a portfolio with you.</td></tr>`;
  } else {
    receivedBody.innerHTML = received
      .map(
        (s) => `<tr>
          <td data-label="Owner">${escapeHtml(s.owner_email || s.owner_user_id)}</td>
          <td data-label="Scope">${escapeHtml(scopeLabel(s))}</td>
          <td data-label="Actions">
            <button type="button" class="view-shared-btn" data-owner="${s.owner_user_id}" data-portfolio="${s.portfolio_id || ""}" data-label="${escapeHtml(s.owner_email || "")}">View</button>
            <button type="button" class="del-btn share-leave-btn" data-id="${s.id}" aria-label="Stop viewing ${escapeHtml(s.owner_email || "this")}'s portfolio">Leave</button>
          </td>
        </tr>`
      )
      .join("");
    receivedBody.querySelectorAll(".share-leave-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await sb.from("portfolio_shares").delete().eq("id", btn.dataset.id);
        loadSharing();
      })
    );
    receivedBody.querySelectorAll(".view-shared-btn").forEach((btn) =>
      btn.addEventListener("click", () => viewSharedPortfolio(btn.dataset.owner, btn.dataset.label))
    );
  }
}

document.getElementById("shareForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("shareError");
  const hintEl = document.getElementById("shareHint");
  errEl.textContent = "";
  hintEl.textContent = "";
  if (!currentUserId) {
    errEl.textContent = "Not signed in — please sign in again.";
    return;
  }
  if (!window.WORKER_URL) {
    errEl.textContent = "Can't reach the Worker (WORKER_URL not configured) — can't resolve that email to an account.";
    return;
  }
  const form = new FormData(e.target);
  const email = form.get("email").trim();
  const portfolioId = form.get("portfolio_id") || null;
  if (!email) {
    errEl.textContent = "Enter an email address.";
    return;
  }
  await withButtonLoading(document.getElementById("shareSubmitBtn"), "Sharing…", async () => {
    let lookup;
    try {
      const res = await authedFetch(`${window.WORKER_URL}/find-user-by-email?email=${encodeURIComponent(email)}`);
      lookup = await res.json();
      if (!res.ok) throw new Error(lookup.error || `HTTP ${res.status}`);
    } catch (err) {
      errEl.textContent = `Could not look up that email: ${err.message}`;
      return;
    }
    if (!lookup.found) {
      errEl.textContent = `No Portfolio Tracker account found for ${email} — they need to sign up first.`;
      return;
    }
    if (lookup.id === currentUserId) {
      errEl.textContent = "You can't share your portfolio with yourself.";
      return;
    }
    const { error } = await sb.from("portfolio_shares").insert({
      owner_user_id: currentUserId,
      shared_with_user_id: lookup.id,
      shared_with_email: lookup.email,
      owner_email: currentUserEmail,
      portfolio_id: portfolioId,
    });
    if (error) {
      errEl.textContent = error.message.includes("duplicate") ? "Already shared with that person at that scope." : error.message;
      return;
    }
    hintEl.textContent = `Shared with ${lookup.email}.`;
    e.target.reset();
    loadSharing();
  });
});

// Switches the whole dashboard into a read-only view of someone else's
// shared holdings/value history. Deliberately narrow: it swaps out
// loadHoldings/loadValueHistory's data source and hides every mutating
// control (Add Holding, Sell, Edit, Delete, inline editing), rather than
// building a second parallel UI — the numbers are what's being shared, not
// a separate app experience.
let sharedViewOwnerId = null;
// Day 26 ("view-only sharing"): the owner's OWN portfolio id -> name map,
// kept entirely separate from `allPortfolios` (which stays your own list at
// all times — see loadPortfolios). Populated once per viewSharedPortfolio
// call via the "shared viewers can read shared portfolios" RLS policy.
let sharedOwnerPortfolioNameById = {};
// Remembers your own filter selection from before you switched into shared
// view, so exiting restores it instead of silently leaving you on "All
// portfolios" if you had a specific one selected.
let preSharedViewPortfolioId = null;

async function viewSharedPortfolio(ownerId, ownerLabel) {
  sharedViewOwnerId = ownerId;
  preSharedViewPortfolioId = selectedPortfolioId;
  // Shared view is always "all of what was shared" — see loadValueHistory's
  // comment on why per-portfolio filtering isn't offered here.
  selectedPortfolioId = "__all__";

  const { data: ownerPortfolios, error } = await sb.from("portfolios").select("id, name").eq("user_id", ownerId);
  sharedOwnerPortfolioNameById = error ? {} : Object.fromEntries((ownerPortfolios || []).map((p) => [p.id, p.name]));

  const banner = document.getElementById("sharedViewBanner");
  const label = document.getElementById("sharedViewLabel");
  if (label) label.textContent = `Viewing ${ownerLabel || "a shared portfolio"}'s holdings — read-only.`;
  if (banner) banner.style.display = "";
  document.body.classList.add("shared-view-active");
  await loadHoldings();
  await loadValueHistory();
  banner?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function exitSharedView() {
  sharedViewOwnerId = null;
  sharedOwnerPortfolioNameById = {};
  selectedPortfolioId = preSharedViewPortfolioId || "__all__";
  const banner = document.getElementById("sharedViewBanner");
  if (banner) banner.style.display = "none";
  document.body.classList.remove("shared-view-active");
  loadHoldings();
  loadValueHistory();
}

document.getElementById("exitSharedViewBtn").addEventListener("click", exitSharedView);

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
let currentUserEmail = null; // Day 26 ("view-only sharing"): needed for portfolio_shares.owner_email

function showApp(user) {
  currentUserId = user.id;
  currentUserEmail = user.email;
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("forgotPasswordSection").style.display = "none";
  document.getElementById("appContent").style.display = "";
  setDateToToday();
  document.getElementById("dividendDateInput").value = new Date().toISOString().slice(0, 10);
  // loadTargetAllocations reads lastHoldingsRows/lastHoldingsTotalValue
  // (set by loadHoldings) for its "Current %" column, so it's chained after
  // rather than fired off independently like the rest of this batch.
  loadPortfolios().then(loadHoldings).then(loadTargetAllocations);
  loadValueHistory();
  loadRealizedGains();
  loadTransactions();
  loadWatchlist();
  loadPriceAlerts();
  loadDividends();
  loadSharing();
  if (!window.__pollingStarted) {
    window.__pollingStarted = true;
    setInterval(() => {
      loadPortfolios().then(loadHoldings).then(loadTargetAllocations);
      loadValueHistory();
      loadRealizedGains();
      loadTransactions();
      loadWatchlist();
      loadPriceAlerts();
      loadDividends();
      loadSharing();
    }, 5 * 60 * 1000); // refresh the view every 5 min from cache (not the API)
  }
}

function showLogin() {
  currentUserId = null;
  currentUserEmail = null;
  document.getElementById("appContent").style.display = "none";
  document.getElementById("resetPasswordSection").style.display = "none";
  document.getElementById("forgotPasswordSection").style.display = "none";
  document.getElementById("loginSection").style.display = "";
  // Always land back on "Sign in" mode, not whatever mode was left active.
  const actionInput = document.getElementById("loginActionInput");
  if (actionInput && actionInput.value !== "signin") {
    document.getElementById("toggleSignupBtn").click();
  }
}

function showResetPassword() {
  document.getElementById("appContent").style.display = "none";
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("forgotPasswordSection").style.display = "none";
  document.getElementById("resetPasswordSection").style.display = "";
  document.querySelector('#resetPasswordForm input[name="password"]')?.focus();
}

// Day 23 (a11y/UX review): dedicated "forgot password" screen with its own
// email field — see the HTML comment above #forgotPasswordSection for why
// this replaced reusing the sign-in form's email input.
function showForgotPassword() {
  document.getElementById("appContent").style.display = "none";
  document.getElementById("resetPasswordSection").style.display = "none";
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("forgotPasswordSection").style.display = "";
  document.getElementById("forgotPasswordError").textContent = "";
  document.getElementById("forgotPasswordHint").textContent = "";
  document.getElementById("forgotPasswordForm").reset();
  document.querySelector('#forgotPasswordForm input[name="email"]').focus();
}

// Day 23 (a11y/UX review): toggles the sign-in form between "Sign in" and
// "Sign up" modes. Replaces the old pair of adjacent, equally-weighted
// submit buttons (easy to mis-click) with one primary button whose label
// and hidden action value flip together, plus this lower-emphasis link.
document.getElementById("toggleSignupBtn").addEventListener("click", () => {
  const actionInput = document.getElementById("loginActionInput");
  const submitBtn = document.getElementById("loginSubmitBtn");
  const modeText = document.getElementById("loginModeText");
  const toggleBtn = document.getElementById("toggleSignupBtn");
  const passwordInput = document.querySelector('#loginForm input[name="password"]');
  const errEl = document.getElementById("loginError");
  const hintEl = document.getElementById("loginHint");
  errEl.textContent = "";
  hintEl.textContent = "";

  const nowSignup = actionInput.value !== "signup";
  actionInput.value = nowSignup ? "signup" : "signin";
  submitBtn.textContent = nowSignup ? "Sign up" : "Sign in";
  modeText.textContent = nowSignup ? "Already have an account?" : "New here?";
  toggleBtn.textContent = nowSignup ? "Sign in" : "Create an account";
  passwordInput.autocomplete = nowSignup ? "new-password" : "current-password";
});

// Day 24 (review P1: "generic auth errors; enable rate limits"). Two parts:
//
// 1. sanitizeAuthError masks the one genuinely enumeration-relevant message
//    Supabase returns in this project's configuration (email confirmation
//    is OFF, so signUp on an already-registered email returns an explicit
//    error rather than the silent no-op Supabase uses when confirmation is
//    on) — without this, someone could probe arbitrary emails against
//    /signup and learn who has an account here just from the error text.
//    Genuinely useful messages (weak password, malformed email, wrong
//    credentials) pass through unchanged — those aren't enumeration risks
//    and hiding them would just make the form worse to use.
//
// 2. A client-side attempt throttle on THIS form — not a substitute for
//    real server-side rate limiting (that's enforced by Supabase Auth
//    itself, which applies default per-project rate limits to sign-in/
//    sign-up regardless of what this app does), but real defense-in-depth
//    against a script hammering this one browser tab. State is in-memory
//    only (resets on reload) — see README for what this does and doesn't
//    cover, including why a full CAPTCHA integration wasn't added here.
// Day 25 ("Consistent button loading states"): a small helper wrapping a
// submit button's disabled+text state around an async block, via try/finally
// so the button is ALWAYS re-enabled — whichever of a handler's several
// early-return paths ends up firing, a normal success, or a thrown error.
// Kept generic instead of hand-writing this in every handler since several
// of them (sign-in, add/edit holding) have multiple branches where it'd be
// easy to miss re-enabling on one path.
async function withButtonLoading(btn, loadingText, fn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingText;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function sanitizeAuthError(message) {
  const lower = (message || "").toLowerCase();
  if (lower.includes("already registered") || lower.includes("already exists") || lower.includes("user already")) {
    return "Could not create an account with those details. If you already have one, try signing in instead.";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "Too many attempts — please wait a bit before trying again.";
  }
  return message;
}

const LOGIN_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_THROTTLE_MAX_ATTEMPTS = 5;
const LOGIN_THROTTLE_COOLDOWN_MS = 60 * 1000;
let loginFailureTimestamps = [];

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("loginError");
  const hintEl = document.getElementById("loginHint");
  errEl.textContent = "";
  hintEl.textContent = "";
  if (!showValidationError(e.target, errEl)) return;

  const now = Date.now();
  loginFailureTimestamps = loginFailureTimestamps.filter((t) => now - t < LOGIN_THROTTLE_WINDOW_MS);
  if (loginFailureTimestamps.length >= LOGIN_THROTTLE_MAX_ATTEMPTS) {
    const oldestInWindow = loginFailureTimestamps[0];
    const waitMs = LOGIN_THROTTLE_COOLDOWN_MS - (now - oldestInWindow);
    if (waitMs > 0) {
      errEl.textContent = `Too many attempts — please wait ${Math.ceil(waitMs / 1000)}s before trying again.`;
      return;
    }
  }

  const form = new FormData(e.target);
  const email = form.get("email");
  const password = form.get("password");
  const action = form.get("action"); // set by the Sign in/Sign up toggle link

  // Day 24: write the "remember me" preference BEFORE signing in, so
  // rememberMeStorage (see top of file) already knows which backing store to
  // use by the time Supabase's client writes the resulting session token.
  localStorage.setItem(REMEMBER_ME_KEY, form.get("remember") ? "true" : "false");

  await withButtonLoading(document.getElementById("loginSubmitBtn"), action === "signup" ? "Creating account…" : "Signing in…", async () => {
    if (action === "signup") {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) {
        loginFailureTimestamps.push(Date.now());
        errEl.textContent = sanitizeAuthError(error.message);
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
      loginFailureTimestamps.push(Date.now());
      errEl.textContent = sanitizeAuthError(error.message);
      return;
    }
    loginFailureTimestamps = []; // successful sign-in clears the count
    showApp(data.user);
  });
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
document.getElementById("forgotPasswordBtn").addEventListener("click", showForgotPassword);

document.getElementById("cancelForgotPasswordBtn").addEventListener("click", showLogin);

document.getElementById("forgotPasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("forgotPasswordError");
  const hintEl = document.getElementById("forgotPasswordHint");
  errEl.textContent = "";
  hintEl.textContent = "";
  if (!showValidationError(e.target, errEl)) return;

  await withButtonLoading(document.getElementById("forgotSubmitBtn"), "Sending…", async () => {
    const email = new FormData(e.target).get("email").trim();
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    // Day 23 (a11y/UX review): neutral confirmation copy regardless of
    // whether the email matched an account. Supabase's
    // resetPasswordForEmail doesn't error on an unknown address anyway (it
    // wouldn't want to be an account-enumeration oracle either), but we
    // phrase this defensively so the behaviour stays correct even if that
    // ever changes — no message here should let someone infer whether a
    // given email has an account.
    if (error) {
      // Only network/rate-limit-type failures should reach here in practice.
      errEl.textContent = sanitizeAuthError(error.message);
      return;
    }
    hintEl.textContent = "If an account exists for that email, we've sent a link to reset your password. Check your inbox.";
  });
});

document.getElementById("resetPasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("resetPasswordError");
  const hintEl = document.getElementById("resetPasswordHint");
  errEl.textContent = "";
  hintEl.textContent = "";
  if (!showValidationError(e.target, errEl)) return;

  const form = new FormData(e.target);
  const password = form.get("password");
  const confirmPassword = form.get("confirmPassword");
  if (password !== confirmPassword) {
    errEl.textContent = "Passwords don't match.";
    return;
  }

  await withButtonLoading(document.getElementById("resetSubmitBtn"), "Updating…", async () => {
    const { data, error } = await sb.auth.updateUser({ password });
    if (error) {
      errEl.textContent = error.message;
      return;
    }
    inPasswordRecovery = false;
    hintEl.textContent = "Password updated — signing you in…";
    showApp(data.user);
  });
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
