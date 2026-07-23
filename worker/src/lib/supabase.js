// Minimal PostgREST client for Supabase — avoids bundling @supabase/supabase-js
// in the Worker. Uses the service_role key (set via `wrangler secret put`, never
// committed) so writes bypass Row Level Security. Never expose this key to the
// browser — the front end uses the anon key instead (see public/config.js).

export function makeSupabase(env) {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const authHeaders = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  async function req(path, opts = {}) {
    const res = await fetch(`${base}${path}`, { ...opts, headers: { ...authHeaders, ...(opts.headers || {}) } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Supabase ${opts.method || "GET"} ${path} failed: ${res.status} ${body}`);
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    getHoldings: () => req("/holdings?select=*&order=created_at.asc"),

    insertRows: (table, rows) =>
      req(`/${table}`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) }),

    // Most recent FX snapshot strictly before `beforeIso` — used to separate
    // FX return from price return (Day 12).
    getFxRateBefore: async (base_, quote, beforeIso) => {
      const q = `base=eq.${base_}&quote=eq.${quote}&as_of=lt.${beforeIso}&order=as_of.desc&limit=1`;
      const rows = await req(`/fx_rates?${q}`);
      return rows[0]?.rate ?? null;
    },

    getRecentReports: async (limit = 10) => req(`/daily_reports?select=*&order=report_date.desc&limit=${limit}`),
  };
}
