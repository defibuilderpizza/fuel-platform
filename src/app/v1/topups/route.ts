import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { confirmDeposit, depositView } from "@/lib/deposits";
import { apiError, readJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Confirm a public deposit. Body: { signature }.
 * No API key needed: the wallet that paid is the wallet credited, read from the chain,
 * unless the transaction carries a "fuel:<agent>" memo: then that agent is credited.
 */
export async function POST(req: Request) {
  const body = await readJson<{ signature?: string }>(req);
  const r = await confirmDeposit(String(body?.signature ?? ""));
  if (!r.ok) return apiError(r.status, r.code === "not_configured" ? "not_configured" : r.status >= 500 ? "server_error" : "invalid_request_error", r.message, r.code);
  return Response.json(r.deposit, { status: r.status });
}

/** Your deposit history: top-ups to you, and community top-ups you paid for other agents. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { data } = await supabaseAdmin()
    .from("deposits")
    .select("*")
    .or(`wallet.eq.${caller.wallet},supporter_wallet.eq.${caller.wallet}`)
    .order("created_at", { ascending: false })
    .limit(100);
  return Response.json({ data: (data ?? []).map((d) => depositView(d, false)) });
}
