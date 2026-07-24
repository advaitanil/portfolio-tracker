// Copy this file to config.js (config.js is gitignored) and fill in your own
// Supabase project values. The anon key is safe to expose in the browser —
// it only grants what your Row Level Security policies allow (see schema.sql).
window.SUPABASE_URL = "https://awnlpgsbgswhohttniso.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_PUHIYxipAKXdRQH6pQmlMQ_ZF3RQzoz";
window.BASE_CURRENCY = "USD"; // must match the base currency used by the Worker
window.WORKER_URL = "https://portfolio-tracker-worker.rexorot64.workers.dev"; // used to trigger an on-demand price refresh after adding a holding
