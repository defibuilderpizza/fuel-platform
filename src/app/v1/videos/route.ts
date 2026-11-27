import { apiError, readJson } from "@/lib/http";
import { callerOrPay, x402Probe } from "@/lib/x402";
import { startVideoJob } from "@/lib/media";

/** Start a 5-second clip. Body: { model, prompt }. Returns 202 with an id; poll GET /v1/videos/:id. */
export async function POST(req: Request) {
  const caller = await callerOrPay(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "JSON body required.");
  return startVideoJob(req, caller, body);
}
