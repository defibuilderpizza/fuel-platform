import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { apiError, readJson } from "@/lib/http";
import { creditState } from "@/lib/credits";
import { tradingStats } from "@/lib/credit-market";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Reserve health and credit book. */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { data: events } = await supabaseAdmin().from("credit_events").select("at, kind, wallet, units_micro, usd_micro, level, note").order("at", { ascending: false }).limit(30);
  return Response.json({ ...(await creditState()), trading: await tradingStats(), events: events ?? [] });
}

const FIELDS = ["enabled", "require_locked_capacity", "cap_usd", "wallet_cap_usd", "fee_bps", "premium_max_bps", "mint_min_coverage", "redeem_limit_coverage", "redeem_daily_usd", "promise_share", "house_market", "house_credit_discount_bps", "trading_enabled", "trade_fee_bps", "trade_down_fee_bps"] as const;

/**
 * { action: "reserve", usd, note } moves treasury money into (+) or out of (−) the reserve.
 * { action: "config", ...fields } updates settings (expiry stays fixed at 90 days).
 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = await readJson<Record<string, unknown>>(req);
  const db = supabaseAdmin();
  if (b?.action === "reserve") {
    const usd = Number(b.usd);
    if (!Number.isFinite(usd) || usd === 0 || Math.abs(usd) > 1_000_000) return apiError(400, "invalid_request_error", "'usd' must be a non-zero number.");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 200) : usd > 0 ? "treasury top-up" : "treasury withdrawal";
    const { data, error } = await db.rpc("fuel_credit_reserve", { p_delta_micro: Math.round(usd * 1e6), p_note: note });
    if (error) return apiError(500, "server_error", "Could not update the reserve.");
    return Response.json({ reserve_usd: Number(data) / 1e6 });
  }
  if (b?.action === "config") {
    const patch: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (!(f in b)) continue;
      const v = b[f];
      if (f === "enabled" || f === "require_locked_capacity" || f === "house_market" || f === "trading_enabled") {
        if (typeof v !== "boolean") return apiError(400, "invalid_request_error", `'${f}' must be true or false.`);
        patch[f] = v;
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return apiError(400, "invalid_request_error", `'${f}' must be a number ≥ 0.`);
        patch[f] = n;
      }
    }
    if (!Object.keys(patch).length) return apiError(400, "invalid_request_error", "Nothing to update.");
    await db.from("credit_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
    return Response.json({ updated: Object.keys(patch) });
  }
  return apiError(400, "invalid_request_error", "'action' must be reserve or config.");
}
