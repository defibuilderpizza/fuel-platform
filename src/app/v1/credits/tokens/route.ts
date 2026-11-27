import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { tokenInfo } from "@/lib/credit-bridge";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Credit tokens: one SPL token per monthly series (6 decimals, 1 token = 1 credit).
 * Public: whether they're on, the network and each series' mint. With a key: your bridge history.
 */
export async function GET(req: Request) {
  await connection();
  const info = await tokenInfo();
  if (!req.headers.get("authorization")) return Response.json(info);
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { data } = await supabaseAdmin().from("credit_bridge").select("id, series_id, direction, units_micro, status, signature, created_at, done_at").eq("wallet", caller.wallet).order("created_at", { ascending: false }).limit(50);
  return Response.json({
    ...info,
    history: (data ?? []).map((b) => ({ id: b.id, series: b.series_id, direction: b.direction, credits: Number(b.units_micro) / 1e6, status: b.status, signature: b.signature, created_at: b.created_at, done_at: b.done_at })),
  });
}
