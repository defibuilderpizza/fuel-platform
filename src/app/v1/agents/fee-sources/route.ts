import { connection } from "next/server";
import { authenticate, isWalletAddress, verifySignature } from "@/lib/auth";
import { listFeeSources } from "@/lib/fee-sources";
import { apiError, readJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Your agent's linked fee wallets. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json({ data: await listFeeSources(caller.wallet) });
}

/**
 * Step 2: link a fee wallet. Body: { source, nonce, signature, label? }.
 * `signature` is the fee wallet's signature over the message from step 1.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ source?: string; nonce?: string; signature?: string; label?: string }>(req);
  if (!isWalletAddress(body?.source) || typeof body.nonce !== "string" || typeof body.signature !== "string") {
    return apiError(400, "invalid_request_error", "'source', 'nonce' and 'signature' are required.");
  }
  const db = supabaseAdmin();
  const { data: message } = await db.rpc("fuel_use_nonce", { p_nonce: body.nonce, p_wallet: body.source });
  if (typeof message !== "string") return apiError(401, "authentication_error", "Nonce unknown, expired or already used.", "bad_nonce");
  // The signed message must name this caller's agent: a signature for another agent is useless here.
  if (!message.includes(`\nAgent wallet: ${caller.wallet}\n`)) return apiError(403, "authentication_error", "That message was issued for a different agent.", "wrong_agent");
  if (!verifySignature(body.source, message, body.signature)) {
    return apiError(401, "authentication_error", "Signature does not match the fee wallet and message.", "bad_signature");
  }

  const label = typeof body.label === "string" ? body.label.trim().slice(0, 48) || null : null;
  const { data: existing } = await db.from("agent_fee_sources").select("agent_wallet").eq("source_wallet", body.source).maybeSingle();
  if (existing && existing.agent_wallet !== caller.wallet) {
    return apiError(409, "invalid_request_error", "That fee wallet already feeds another agent. It must be unlinked there first.", "source_taken");
  }
  const { error } = await db.from("agent_fee_sources").upsert({ source_wallet: body.source, agent_wallet: caller.wallet, label });
  if (error) return apiError(500, "server_error", "Could not link the fee wallet.");
  return Response.json({ data: await listFeeSources(caller.wallet) }, { status: 201 });
}
