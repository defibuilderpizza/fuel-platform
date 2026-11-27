import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { ringReceiptView } from "@/lib/ring";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Your private top-ups. Only you see these amounts. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { data } = await supabaseAdmin()
    .from("ring_receipts")
    .select("*")
    .eq("sender_wallet", caller.wallet)
    .order("created_at", { ascending: false })
    .limit(100);
  return Response.json({ data: (data ?? []).map(ringReceiptView) });
}
