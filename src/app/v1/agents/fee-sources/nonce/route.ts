import { authenticate, isWalletAddress } from "@/lib/auth";
import { createLinkNonce } from "@/lib/fee-sources";
import { apiError, readJson } from "@/lib/http";
import { depositWallet } from "@/lib/solana";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Step 1 of linking a fee wallet: get the message the fee wallet must sign. Body: { source }. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ source?: string }>(req);
  if (!isWalletAddress(body?.source)) return apiError(400, "invalid_request_error", "'source' must be a Solana address.");
  if (body.source === caller.wallet) return apiError(400, "invalid_request_error", "That's the agent's own wallet: its deposits are already credited to it.");
  if (body.source === depositWallet()) return apiError(400, "invalid_request_error", "That's Fuel's deposit address.");
  const { data: agent } = await supabaseAdmin().from("agents").select("name").eq("wallet", caller.wallet).maybeSingle();
  if (!agent) return apiError(400, "invalid_request_error", "Register your agent first (POST /v1/agents).", "not_an_agent");
  return Response.json(await createLinkNonce(body.source, agent.name, caller.wallet));
}
