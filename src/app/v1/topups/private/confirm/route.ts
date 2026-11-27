import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { ringConfig, ringReceiptView, scanRing, transferSigners } from "@/lib/ring";
import { isSignature } from "@/lib/solana";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Confirm a private top-up. Body: { signature }. Needs your API key, because the
 * answer contains the amount, which is private: only the wallet that signed the
 * transfer gets to see it.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const cfg = ringConfig();
  if (!cfg.enabled) return apiError(503, "not_configured", "Private top-ups are not open yet.");
  const body = await readJson<{ signature?: string }>(req);
  if (!isSignature(body?.signature)) return apiError(400, "invalid_request_error", "'signature' must be a Solana transaction signature.");
  const signature = body.signature;

  const db = supabaseAdmin();
  const mine = async () =>
    (await db.from("ring_receipts").select("*").eq("signature", signature).eq("sender_wallet", caller.wallet)).data ?? [];

  let receipts = await mine();
  if (receipts.length === 0) {
    const info = await transferSigners(signature, cfg.network).catch(() => null);
    if (!info) return apiError(404, "invalid_request_error", "Transaction not found yet. Wait a few seconds and try again.", "not_found");
    if (info.failed) return apiError(400, "invalid_request_error", "That transaction failed on-chain.", "failed_tx");
    if (!info.signers.includes(caller.wallet)) {
      return apiError(403, "invalid_request_error", "That transaction was not signed by the wallet this API key belongs to.", "not_your_transfer");
    }
    // Sync up to that slot. Another sync may be running: wait for it briefly.
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await scanRing(info.slot);
      if (r.ok || r.reason !== "busy") break;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    receipts = await mine();
  }
  if (receipts.length === 0) {
    return apiError(404, "invalid_request_error", "No private transfer to Fuel found in that transaction yet. If you just sent it, try again in a minute.", "no_ring_payment");
  }
  const views = receipts.map(ringReceiptView);
  return Response.json({
    signature,
    credited_usd: views.reduce((s, v) => s + v.credited_usd, 0),
    receipts: views,
  });
}
