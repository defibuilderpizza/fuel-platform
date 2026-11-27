import { connection } from "next/server";
import { authenticate, isAccountAddress, issueApiKey, normalizeWallet, verifyAccountSignature } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { walletRefusal } from "@/lib/compliance";

/** Step 2: send the signed message back and get an API key (shown once). */
export async function POST(req: Request) {
  const body = await readJson<{ wallet?: string; nonce?: string; signature?: string; label?: string }>(req);
  if (!isAccountAddress(body?.wallet)) return apiError(400, "invalid_request_error", "'wallet' must be a Solana address or an EVM (0x…) address.");
  body.wallet = normalizeWallet(body.wallet);
  if (typeof body.nonce !== "string" || typeof body.signature !== "string") {
    return apiError(400, "invalid_request_error", "'nonce' and 'signature' are required. Get a nonce from POST /v1/auth/nonce.");
  }
  const { data: message } = await supabaseAdmin().rpc("fuel_use_nonce", { p_nonce: body.nonce, p_wallet: body.wallet });
  if (typeof message !== "string") return apiError(401, "authentication_error", "Nonce unknown, expired or already used.", "bad_nonce");
  if (!(await verifyAccountSignature(body.wallet, message, body.signature))) {
    return apiError(401, "authentication_error", "Signature does not match this wallet and message.", "bad_signature");
  }
  const refused = await walletRefusal(body.wallet);
  if (refused) return apiError(403, "permission_error", refused, "wallet_refused");
  const key = await issueApiKey(body.wallet, body.label);
  return Response.json({ ...key, wallet: body.wallet, note: "Store this key now. Fuel only keeps a hash and cannot show it again." }, { status: 201 });
}

/** Lists your keys (never the keys themselves). */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { data } = await supabaseAdmin()
    .from("api_keys")
    .select("id, prefix, label, created_at, last_used_at, revoked_at")
    .eq("wallet", caller.wallet)
    .order("created_at", { ascending: false });
  return Response.json({ data: data ?? [] });
}
