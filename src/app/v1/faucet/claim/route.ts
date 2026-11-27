import { authenticate } from "@/lib/auth";
import { faucetStatus } from "@/lib/faucet";
import { apiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Claim the one-off free trial credit (any wallet). Spendable only on Fuel jobs; not repaid. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const db = supabaseAdmin();
  const { data: already } = await db.from("faucet_trials").select("wallet").eq("wallet", caller.wallet).maybeSingle();
  if (already) return apiError(409, "invalid_request_error", "This wallet already claimed its free trial.", "already_claimed");

  const { data: r, error } = await db.rpc("fuel_faucet_trial", { p_wallet: caller.wallet });
  if (error) return apiError(500, "server_error", "Could not grant the trial.");
  if (r === "already_claimed") return apiError(409, "invalid_request_error", "This wallet already claimed its free trial.", "already_claimed");
  if (r === "pot_empty") return apiError(409, "invalid_request_error", "The free trial pot is used up for now.", "pot_empty");
  if (r !== "ok") return apiError(503, "not_configured", "The free trial is switched off.", "disabled");
  return Response.json(await faucetStatus(caller.wallet), { status: 201 });
}
