import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { payLink, payoutView, type PayoutRow } from "@/lib/payouts";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Open payouts (requested, approved) plus the 20 most recent closed ones. Approved ones carry their pay link. */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  const db = supabaseAdmin();
  const [{ data: open }, { data: recent }] = await Promise.all([
    db.from("payouts").select("*").in("status", ["requested", "approved"]).order("requested_at"),
    db.from("payouts").select("*").in("status", ["paid", "rejected", "cancelled"]).order("requested_at", { ascending: false }).limit(20),
  ]);
  const row = (p: PayoutRow) => ({ ...payoutView(p), wallet: p.wallet, ...(p.status === "approved" ? { pay_link: payLink(p), reference: p.reference } : {}) });
  return Response.json({ open: ((open ?? []) as PayoutRow[]).map(row), recent: ((recent ?? []) as PayoutRow[]).map(row) });
}
