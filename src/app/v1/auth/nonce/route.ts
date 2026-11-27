import { createNonce, isAccountAddress, normalizeWallet } from "@/lib/auth";
import { apiError, rateLimited, readJson } from "@/lib/http";
import { signInRateLimit } from "@/lib/limits";
import { walletRefusal } from "@/lib/compliance";
import { usdgDepositAddress } from "@/lib/robinhood";
import { depositWallet } from "@/lib/solana";

/** Step 1 of getting an API key: get a one-time message for your wallet to sign. */
export async function POST(req: Request) {
  const body = await readJson<{ wallet?: string }>(req);
  if (!isAccountAddress(body?.wallet)) return apiError(400, "invalid_request_error", "'wallet' must be a Solana address or an EVM (0x…) address.");
  body.wallet = normalizeWallet(body.wallet);
  // Fuel's own receiving addresses aren't customer accounts: sign in with the wallet you pay from.
  if (body.wallet === usdgDepositAddress() || body.wallet === depositWallet()) return apiError(400, "invalid_request_error", "That's Fuel's deposit address, not a customer wallet. Sign in with the wallet you send funds from.", "fuel_deposit_address");
  const refused = await walletRefusal(body.wallet);
  if (refused) return apiError(403, "permission_error", refused, "wallet_refused");
  const rl = await signInRateLimit(body.wallet);
  if (rl.limited) return rateLimited(`Too many sign-in attempts for this wallet. Retry after ${rl.retryAfter}s.`, rl.retryAfter);
  return Response.json(await createNonce(body.wallet));
}
