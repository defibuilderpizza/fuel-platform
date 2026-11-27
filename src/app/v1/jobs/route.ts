import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { receiptView } from "@/lib/jobs";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Your receipts, newest first. ?limit=50 (max 200) &before=<ISO time> to page. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  let q = supabaseAdmin().from("jobs").select("*").eq("wallet", caller.wallet).order("created_at", { ascending: false }).limit(limit);
  const before = url.searchParams.get("before");
  if (before) q = q.lt("created_at", before);
  const { data } = await q;
  return Response.json({ data: (data ?? []).map(receiptView) });
}
