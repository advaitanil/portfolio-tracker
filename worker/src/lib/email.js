// Renders the daily email (Section 10 spec) and sends it via Resend.
const money = (n, ccy) => (n == null ? "—" : n.toLocaleString(undefined, { style: "currency", currency: ccy, maximumFractionDigits: 2 }));
const pct = (n) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

export function buildSubject(metrics) {
  const arrow = (metrics.dayChangePct ?? 0) >= 0 ? "▲" : "▼";
  const value = metrics.totalValue?.toLocaleString(undefined, { style: "currency", currency: metrics.baseCurrency, maximumFractionDigits: 0 }) ?? "—";
  const changePct = metrics.dayChangePct != null ? `${metrics.dayChangePct >= 0 ? "+" : ""}${metrics.dayChangePct.toFixed(1)}%` : "—";
  const date = new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  return `Portfolio ${value} ${arrow} ${changePct} — ${date}`;
}

export function renderEmail(metrics, news, commentary) {
  const arrow = (metrics.dayChangePct ?? 0) >= 0 ? "▲" : "▼";
  const headlineColor = (metrics.dayChangePct ?? 0) >= 0 ? "#1a9c6b" : "#c0392b";
  const ccy = metrics.baseCurrency;

  const rows = metrics.holdings
    .map((h) => {
      if (h.error) {
        return `<tr><td style="padding:6px 4px">${h.ticker}</td><td colspan="6" style="padding:6px 4px;color:#c0392b">Price unavailable — ${h.reason || "flagged"}</td></tr>`;
      }
      const flagNote = h.flags?.length ? ` <span style="color:#c0392b;font-size:10px">(${h.flags.join(", ")})</span>` : "";
      return `<tr>
        <td style="padding:6px 4px">${h.ticker}${flagNote}</td>
        <td style="padding:6px 4px">${h.quantity}</td>
        <td style="padding:6px 4px">${money(h.priceInBase, ccy)}</td>
        <td style="padding:6px 4px">${money(h.currentValue, ccy)}</td>
        <td style="padding:6px 4px;color:${(h.dayChangePct ?? 0) >= 0 ? "#1a9c6b" : "#c0392b"}">${pct(h.dayChangePct)}</td>
        <td style="padding:6px 4px;color:${(h.gainPct ?? 0) >= 0 ? "#1a9c6b" : "#c0392b"}">${pct(h.gainPct)}</td>
        <td style="padding:6px 4px">${h.weight != null ? h.weight.toFixed(1) + "%" : "—"}</td>
      </tr>`;
    })
    .join("");

  const newsHtml = news.length
    ? news.map((n) => `<li style="margin-bottom:6px"><a href="${n.url}" style="color:#5b8cff;text-decoration:none">${n.title}</a><br/><span style="color:#999;font-size:11px">${n.source}</span></li>`).join("")
    : `<li style="color:#999">No relevant headlines today.</li>`;

  const commentaryHtml = commentary
    ? `<p style="line-height:1.6;color:#222">${commentary}</p>`
    : `<p style="color:#999">Commentary unavailable today (AI call failed or was skipped) — the figures above are unaffected.</p>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Portfolio Tracker — Daily Summary</title>
  <style>
    /* Not all mail clients honour a <style> block, but the ones that do
       (Apple Mail, most mobile clients) get a noticeably better small-screen
       layout out of this — Day 14 "make the email readable on a phone". */
    @media (max-width: 480px) {
      .container { width: 100% !important; border-radius: 0 !important; }
      .headline-value { font-size: 22px !important; }
      .holdings-table { font-size: 11px !important; }
      .holdings-table th, .holdings-table td { padding: 5px 3px !important; }
    }
  </style>
</head>
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;background:#f4f5f7;padding:16px;margin:0">
  <div class="container" style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="padding:20px 24px;background:#111;color:#fff">
      <div style="font-size:13px;color:#aaa">Portfolio Tracker — Daily Summary</div>
      <div class="headline-value" style="font-size:26px;font-weight:700;margin-top:4px">${money(metrics.totalValue, ccy)}</div>
      <div style="font-size:15px;color:${headlineColor}">${arrow} ${pct(metrics.dayChangePct)} today · Gain/loss ${money(metrics.totalGainAbs, ccy)} (${pct(metrics.totalGainPct)})</div>
    </div>
    <div style="padding:20px 24px">
      <table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:8px">
        <tr><td style="color:#666;padding:4px 0">Best performer</td><td style="text-align:right">${metrics.best ? `${metrics.best.ticker} ${pct(metrics.best.dayChangePct)}` : "—"}</td></tr>
        <tr><td style="color:#666;padding:4px 0">Worst performer</td><td style="text-align:right">${metrics.worst ? `${metrics.worst.ticker} ${pct(metrics.worst.dayChangePct)}` : "—"}</td></tr>
      </table>

      <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Holdings</h3>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
        <table class="holdings-table" style="width:100%;min-width:420px;font-size:12px;border-collapse:collapse">
          <thead><tr style="color:#888;text-align:left;border-bottom:1px solid #eee"><th style="padding:4px">Ticker</th><th style="padding:4px">Qty</th><th style="padding:4px">Price</th><th style="padding:4px">Value</th><th style="padding:4px">Day %</th><th style="padding:4px">Gain %</th><th style="padding:4px">Wt</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="font-size:10px;color:#aaa;margin:4px 0 0">Swipe to see more columns on a small screen.</p>

      <h3 style="font-size:14px;color:#333;margin:20px 0 8px">News</h3>
      <ul style="font-size:13px;padding-left:18px;margin:0">${newsHtml}</ul>

      <h3 style="font-size:14px;color:#333;margin:20px 0 8px">Analysis</h3>
      ${commentaryHtml}

      <p style="font-size:11px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:12px">
        Prices as of ${new Date(metrics.asOf).toLocaleString()}. Sources: Twelve Data (prices), Frankfurter (FX), Marketaux (news), Claude (analysis).
        This is an internal tool for informational purposes only. It is not investment advice. Data may be delayed, cached, or inaccurate.
      </p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendEmail(html, subject, env) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: env.EMAIL_TO, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}
