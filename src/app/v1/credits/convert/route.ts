import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { tradeDown } from "@/lib/credits";
import { isTier, SERIES_RE, TIERS } from "@/lib/credit-tiers";

/**
 * Convert credits into a cheaper tier's credits of the same month, at the tiers' price ratio
 * minus a fee. Body: { series, to_tier, credits }. Going up a tier is only possible by buying.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<{ series?: unknown; to_tier?: unknown; credits?: unknown }>(req);
  const series = typeof b?.series === "string" ? b.series : "";
  const credits = typeof b?.credits === "number" ? b.credits : NaN;
  if (!SERIES_RE.test(series)) return apiError(400, "invalid_request_error", "'series' looks like 2026-12-max.");
  if (!isTier(b?.to_tier)) return apiError(400, "invalid_request_error", `'to_tier' must be one of ${TIERS.join(", ")}.`);
  if (!Number.isFinite(credits) || credits < 0.01 || credits > 1_000_000) return apiError(400, "invalid_request_error", "'credits' must be at least 0.01.");
  const r = await tradeDown(caller.wallet, series, b.to_tier, credits);
  if (!r.ok) return apiError(r.code === "server_error" ? 500 : 409, "invalid_request_error", r.message, r.code);
  return Response.json(r);
}
