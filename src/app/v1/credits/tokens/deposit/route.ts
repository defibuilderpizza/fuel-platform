import { depositCredits } from "@/lib/credit-bridge";
import { apiError, readJson } from "@/lib/http";

/** Credit a burn of credit tokens back to the wallet that burned them. Body: { series, signature }. No key needed. */
export async function POST(req: Request) {
  const body = await readJson<{ series?: string; signature?: unknown }>(req);
  if (typeof body?.series !== "string") return apiError(400, "invalid_request_error", "'series' is required (YYYY-MM).");
  const r = await depositCredits(body.series, body.signature);
  if (!r.ok) return apiError(r.status, r.status >= 500 ? "server_error" : "invalid_request_error", r.message, r.code);
  return Response.json(r, { status: 201 });
}
