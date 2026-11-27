import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { apiError } from "@/lib/http";
import { walletRefusal } from "@/lib/compliance";
import { guestPathAllowed, isGuest } from "@/lib/guest";

// Identity is the wallet address. An agent proves it owns the wallet once
// (signs a one-time message) and gets an API key to send as a Bearer token.

const KEY_PREFIX = "fuel_sk_";
const TERMS_URL = `${process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://fuelai.cloud"}/terms`;

export function isWalletAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** An EVM address (Robinhood Chain and other EVM chains): 0x + 40 hex. Stored lowercase. */
export function isEvmAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}
/** A wallet Fuel accounts can sign in with: Solana, or EVM (Robinhood Chain). */
export function isAccountAddress(s: unknown): s is string {
  return isWalletAddress(s) || isEvmAddress(s);
}
/** One account per wallet: EVM addresses are case-insensitive, so they're kept lowercase. */
export const normalizeWallet = (w: string) => (isEvmAddress(w) ? w.toLowerCase() : w);

/** Checks a sign-in signature for either kind of wallet (EVM: personal_sign / EIP-191). */
export async function verifyAccountSignature(wallet: string, message: string, signature: string): Promise<boolean> {
  if (!isEvmAddress(wallet)) return verifySignature(wallet, message, signature);
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    const { verifyMessage } = await import("viem");
    return await verifyMessage({ address: wallet as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    return false;
  }
}

export function signInMessage(wallet: string, nonce: string, issuedAt: string) {
  return [
    isEvmAddress(wallet) ? "Fuel wants you to sign in with your Robinhood Chain (EVM) wallet:" : "Fuel wants you to sign in with your Solana wallet:",
    wallet,
    "",
    "Sign this to create a Fuel API key. It does not send a transaction or cost anything.",
    `By signing, you agree to Fuel's Terms: ${TERMS_URL}`,
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export async function createNonce(wallet: string) {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const message = signInMessage(wallet, nonce, issuedAt);
  const db = supabaseAdmin();
  const { error } = await db.from("auth_nonces").insert({ nonce, wallet, message });
  if (error) throw error;
  // Housekeeping: nonces older than a day are useless.
  void db.from("auth_nonces").delete().lt("created_at", new Date(Date.now() - 86_400_000).toISOString()).then(() => {});
  return { nonce, message, expires_in_seconds: 600 };
}

/** Accepts a base58 or base64 ed25519 signature over the exact message. */
export function verifySignature(wallet: string, message: string, signature: string): boolean {
  let sig: Uint8Array | null = null;
  try {
    const b = bs58.decode(signature);
    if (b.length === 64) sig = b;
  } catch {}
  if (!sig) {
    const b = Buffer.from(signature, "base64");
    if (b.length === 64) sig = new Uint8Array(b);
  }
  if (!sig) return false;
  try {
    return ed25519.verify(sig, new TextEncoder().encode(message), bs58.decode(wallet));
  } catch {
    return false;
  }
}

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export async function issueApiKey(wallet: string, label?: string) {
  const db = supabaseAdmin();
  await db.from("accounts").upsert({ wallet }, { onConflict: "wallet", ignoreDuplicates: true });
  const key = KEY_PREFIX + bs58.encode(randomBytes(32));
  const { data, error } = await db
    .from("api_keys")
    .insert({ wallet, key_hash: hashKey(key), prefix: key.slice(0, 14), label: label?.slice(0, 64) ?? null })
    .select("id, prefix, label, created_at")
    .single();
  if (error) throw error;
  return { ...data, api_key: key };
}

export type Caller = { wallet: string; keyId: string };

/** Resolves the Bearer key to a wallet, or returns an error Response. */
export async function authenticate(req: Request): Promise<Caller | Response> {
  const header = req.headers.get("authorization") ?? "";
  const key = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!key.startsWith(KEY_PREFIX)) {
    return apiError(401, "authentication_error", "Missing or invalid API key. Send 'Authorization: Bearer fuel_sk_...'.", "invalid_api_key");
  }
  const { data } = await supabaseAdmin()
    .from("api_keys")
    .select("id, wallet, revoked_at")
    .eq("key_hash", hashKey(key))
    .maybeSingle();
  if (!data || data.revoked_at) {
    return apiError(401, "authentication_error", "API key not recognised or revoked.", "invalid_api_key");
  }
  // Free-trial guest keys only run jobs and read their own balance.
  if (isGuest(data.wallet) && !guestPathAllowed(new URL(req.url).pathname)) {
    return apiError(403, "permission_error", "Free-trial keys only run text and picture jobs. Sign in with a wallet for the rest.", "guest_trial");
  }
  // Suspended or sanctioned wallets are refused on every request (sign-in checks it too).
  const refused = await walletRefusal(data.wallet);
  if (refused) return apiError(403, "permission_error", refused, "wallet_refused");
  // Best effort, never blocks the request.
  void supabaseAdmin().from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {});
  return { wallet: data.wallet, keyId: data.id };
}
