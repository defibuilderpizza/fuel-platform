import { authenticate } from "@/lib/auth";
import { depositTransaction } from "@/lib/credit-bridge";
import { apiError, readJson } from "@/lib/http";

/** Unsigned transaction that burns your credit tokens, to sign and send from your wallet. Body: { series, credits }. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<{ series?: string; credits?: unknown }>(req);
  if (typeof body?.series !== "string") return apiError(400, "invalid_request_error", "'series' is required (YYYY-MM).");
  const r = await depositTransaction(caller.wallet, body.series, body.credits);
  if (!r.ok) return apiError(r.status, r.status >= 500 ? "server_error" : "invalid_request_error", r.message, r.code);
  return Response.json(r);
}
