import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { buyCredits } from "@/lib/credits";
import { isTier, TIERS } from "@/lib/credit-tiers";

/**
 * Buy compute credits of a tier from your balance. Body: { tier, credits } (fractions allowed,
 * min 0.01). The response lists how many tokens they buy on each model of the tier.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<{ credits?: unknown; tier?: unknown }>(req);
  const credits = typeof b?.credits === "number" ? b.credits : NaN;
  if (!isTier(b?.tier)) return apiError(400, "invalid_request_error", `'tier' must be one of ${TIERS.join(", ")} (GET /v1/credits/tiers).`);
  if (!Number.isFinite(credits) || credits < 0.01 || credits > 1_000_000) return apiError(400, "invalid_request_error", "'credits' must be a number of at least 0.01.");
  const r = await buyCredits(caller.wallet, credits, b.tier);
  if (!r.ok) return apiError(r.code === "server_error" ? 500 : r.code === "insufficient_balance" ? 402 : 409, "invalid_request_error", r.message, r.code);
  return Response.json(r, { status: 201 });
}
