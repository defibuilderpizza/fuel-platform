// Imported first by every test script: refuses to run against production.
// Tests switch credits on and off, reset the reserve and create/delete wallets, so they must
// only ever touch the dev database (.env.local) and a local dev server.
// Operator tools that are meant for production (sync-together, sync-closed-models, sellers,
// sanctions-sync) don't import this; run them with --env-file=.env.prod.local.

// Your production Supabase project ref(s), comma-separated, so tests refuse to run against them.
const PROD_SUPABASE_REFS = (process.env.FUEL_PROD_SUPABASE_REFS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const db = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const base = process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? "http://localhost:3000";
const stop = (why) => {
  console.error(`\nREFUSED: ${why}\nTests only run against the dev database and a local server (see scripts/test-guard.mjs).\n`);
  process.exit(2);
};

if (!db) stop("NEXT_PUBLIC_SUPABASE_URL isn't set (run with --env-file=.env.local).");
if (PROD_SUPABASE_REFS.some((ref) => db.includes(ref))) stop(`${db} is the production database.`);
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(base)) stop(`${base} isn't a local server.`);
