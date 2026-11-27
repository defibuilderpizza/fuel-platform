import { authenticate } from "@/lib/auth";
import { withdrawCredits } from "@/lib/credit-bridge";
import { apiError, readJson } from "@/lib/http";

/**
 * Withdraw credits as SPL tokens to your wallet. Body: { series: "YYYY-MM", credits }.
 * Deposit them back before the series expires: tokens still out at expiry are forfeited.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ series?: string; credits?: unknown }>(req);
  if (typeof body?.series !== "string") return apiError(400, "invalid_request_error", "'series' is required (YYYY-MM).");
  const r = await withdrawCredits(caller.wallet, body.series, body.credits);
  if (!r.ok) return apiError(r.status, r.status >= 500 ? "server_error" : "invalid_request_error", r.message, r.code);
  return Response.json(r, { status: 201 });
}
