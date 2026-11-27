import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { microToUsd } from "@/lib/money";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Your laptop-lane record: verified tasks, rejections, timeouts, earnings (paid to your balance). */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { data } = await supabaseAdmin().from("lane_worker_stats").select("*").eq("wallet", caller.wallet).maybeSingle();
  return Response.json({
    wallet: caller.wallet,
    verified: data?.verified ?? 0,
    rejected: data?.rejected ?? 0,
    timeouts: data?.timeouts ?? 0,
    earned_usd: microToUsd(data?.earned_micro ?? 0),
    banned: data?.banned ?? false,
  });
}
