import { requireAdmin } from "@/lib/admin";
import { apiError, readJson } from "@/lib/http";
import { approvePayout, closePayout, payLink, settlePayout, type PayoutRow } from "@/lib/payouts";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Review a payout. Body: { action: "approve" } → returns the Solana Pay link to sign in your wallet;
 * { action: "reject", note } → the amount goes back to the account;
 * { action: "paid", signature } → checks that transfer on-chain and marks it paid
 * (the cron also finds transfers made from the pay link on its own).
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/admin/payouts/[id]">) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readJson<{ action?: string; note?: string; signature?: string }>(req);
  if (body?.action === "approve") {
    const p = await approvePayout(id);
    if (!p) return apiError(409, "invalid_request_error", "Only a requested payout can be approved.");
    return Response.json({ id, status: p.status, pay_link: payLink(p), reference: p.reference, wallet: p.wallet, amount_usd: p.amount_micro / 1e6 });
  }
  if (body?.action === "reject") {
    const r = await closePayout(id, "rejected", body.note);
    return r === "ok" ? Response.json({ id, status: "rejected" }) : apiError(409, "invalid_request_error", `Can't reject: ${r}.`);
  }
  if (body?.action === "paid") {
    const { data } = await supabaseAdmin().from("payouts").select("*").eq("id", id).maybeSingle();
    if (!data) return apiError(404, "not_found", "No such payout.");
    const r = await settlePayout(data as PayoutRow, String(body.signature ?? "")).catch(() => ({ ok: false, reason: "could not read the chain; try again" }));
    return r.ok ? Response.json({ id, status: "paid", signature: body.signature }) : apiError(400, "invalid_request_error", `Not marked paid: ${r.reason}.`);
  }
  return apiError(400, "invalid_request_error", "'action' must be approve, reject or paid.");
}
