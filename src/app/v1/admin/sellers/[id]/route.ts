import { requireAdmin } from "@/lib/admin";
import { apiError, readJson } from "@/lib/http";
import { autoReview, syncSellerRoutes } from "@/lib/sellers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { clearFuelOperatedCache } from "@/lib/providers";

/**
 * Review a seller. Body: { action: "approve" | "reject" | "pause" | "probe", note? }, or
 * { action: "fuel_operated", operated_by_fuel, locked_cost_hr?, locked_tps?, locked_until? }
 * to mark a listing as Fuel's own GPU and record its locked cost.
 * Sellers are approved automatically; this is the override (pause/reject stick until approved here).
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/admin/sellers/[id]">) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson<{ action?: string; note?: string; operated_by_fuel?: unknown; locked_cost_hr?: unknown; locked_tps?: unknown; locked_until?: unknown }>(req);
  const db = supabaseAdmin();
  const { data: s } = await db.from("sellers").select("id").eq("id", id).maybeSingle();
  if (!s) return apiError(404, "not_found", "No such seller.");
  if (body?.action === "fuel_operated") {
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const cost = num(body.locked_cost_hr);
    const tps = num(body.locked_tps);
    const until = body.locked_until ? new Date(String(body.locked_until)) : null;
    if (typeof body.operated_by_fuel !== "boolean") return apiError(400, "invalid_request_error", "'operated_by_fuel' must be true or false.");
    if ((cost !== null && !(cost >= 0)) || (tps !== null && !(tps > 0)) || (until && isNaN(until.getTime()))) {
      return apiError(400, "invalid_request_error", "locked_cost_hr ≥ 0, locked_tps > 0, locked_until a date.");
    }
    if (body.operated_by_fuel) {
      const { count } = await db.from("capacity_contracts").select("id", { count: "exact", head: true }).eq("seller_id", id).in("status", ["offered", "active"]);
      if (count) return apiError(409, "invalid_request_error", "This seller has an open capacity contract; close it first.");
    }
    await db
      .from("sellers")
      .update({ operated_by_fuel: body.operated_by_fuel, locked_cost_hr: cost, locked_tps: tps, locked_until: until?.toISOString() ?? null })
      .eq("id", id);
    clearFuelOperatedCache();
    return Response.json({ id, operated_by_fuel: body.operated_by_fuel });
  }
  if (body?.action === "probe") {
    const probes = await autoReview(id);
    return Response.json({ probes });
  }
  const status = { approve: "approved", reject: "rejected", pause: "paused" }[body?.action ?? ""];
  if (!status) return apiError(400, "invalid_request_error", "'action' must be approve, reject, pause or probe.");
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) || null : null;
  await db.from("sellers").update({ status, review_note: note, reviewed_at: new Date().toISOString() }).eq("id", id);
  const routed = await syncSellerRoutes(id);
  return Response.json({ id, status, routed });
}
