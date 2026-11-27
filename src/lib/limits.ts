import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Request rate limits per wallet, counted from rows Fuel already writes (jobs, sign-in nonces),
// so they hold across every server instance without extra infrastructure.
//   FUEL_RATE_LIMIT_JOBS_PER_MIN  jobs a wallet may start per minute (default 300)
//   FUEL_RATE_LIMIT_SIGNINS_PER_MIN  sign-in nonces a wallet may request per minute (default 10)

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export type Limited = { limited: true; limit: number; retryAfter: number } | { limited: false };

async function countSince(table: "jobs" | "auth_nonces", wallet: string, limit: number): Promise<Limited> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabaseAdmin().from(table).select("wallet", { count: "exact", head: true }).eq("wallet", wallet).gte("created_at", since);
  if (error || count === null) return { limited: false }; // never block on a counting failure
  return count >= limit ? { limited: true, limit, retryAfter: 60 } : { limited: false };
}

export const jobRateLimit = (wallet: string) => countSince("jobs", wallet, num(process.env.FUEL_RATE_LIMIT_JOBS_PER_MIN, 300));
export const signInRateLimit = (wallet: string) => countSince("auth_nonces", wallet, num(process.env.FUEL_RATE_LIMIT_SIGNINS_PER_MIN, 10));
