// Shared retry-with-backoff helper (Day 13: "retries with exponential backoff
// on all external API calls" + "respect rate limits — back off rather than
// hammering when you hit one").
export async function withRetry(fn, { retries = 3, baseDelayMs = 500, label = "task" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 200;
      console.warn(`[retry] ${label} attempt ${attempt + 1}/${retries + 1} failed: ${err.message}. Retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastErr.message}`);
}
