// AI commentary via the Claude API (Section 9). Guardrails are enforced in
// the system prompt: no invented numbers, no investment advice, say so if
// data is missing. Your code owns the numbers — Claude only narrates them.
import { withRetry } from "./retry.js";

const GUARDRAIL_SYSTEM_PROMPT = `You are a financial data narrator for an internal portfolio-tracking tool.
Rules you must follow exactly, with no exceptions:
1. Use ONLY the numbers given to you in the JSON payload below. Never invent, estimate, or infer a figure that is not present in the payload.
2. If a number needed to explain something is missing or null, say so explicitly instead of guessing at it.
3. Never give investment advice. Do not recommend buying, selling, or holding anything, under any circumstance — even if the portfolio has fallen sharply. You explain what happened and why it may have happened, nothing more.
4. Write 100-150 words, plain language, no bullet points.
5. Do not add a disclaimer yourself — the app appends one separately.`;

export async function writeCommentary(metrics, news, env) {
  const payload = {
    base_currency: metrics.baseCurrency,
    total_value: round2(metrics.totalValue),
    day_change_pct: round2(metrics.dayChangePct),
    day_change_abs: round2(metrics.dayChangeAbs),
    total_gain_pct: round2(metrics.totalGainPct),
    best_performer: metrics.best ? { ticker: metrics.best.ticker, day_change_pct: round2(metrics.best.dayChangePct) } : null,
    worst_performer: metrics.worst ? { ticker: metrics.worst.ticker, day_change_pct: round2(metrics.worst.dayChangePct) } : null,
    flagged_holdings: metrics.flagged.map((f) => ({ ticker: f.ticker, issue: (f.flags && f.flags.join(",")) || "error" })),
    headlines: news.map((n) => ({ title: n.title, source: n.source, related_tickers: n.tickers })),
  };

  try {
    const result = await withRetry(
      async () => {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            // Day 11: start cost-efficient (Haiku), swap to Sonnet via this env
            // var and compare quality/latency/cost — write your findings in the README.
            model: env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
            max_tokens: 400,
            system: GUARDRAIL_SYSTEM_PROMPT,
            messages: [{ role: "user", content: `Here is today's computed data:\n${JSON.stringify(payload, null, 2)}` }],
          }),
        });
        if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
        return res.json();
      },
      { label: "writeCommentary", retries: 2 }
    );
    return result.content?.[0]?.text?.trim() || null;
  } catch (err) {
    // Day 10: "if the call fails, send the email with metrics and omit the
    // commentary — never block on the AI."
    console.error("writeCommentary failed — email will send without commentary:", err.message);
    return null;
  }
}

function round2(n) {
  return typeof n === "number" ? Math.round(n * 100) / 100 : n;
}
