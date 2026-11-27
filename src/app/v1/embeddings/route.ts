import { callerOrPay, x402Probe } from "@/lib/x402";
import { apiError, readJson } from "@/lib/http";
import { runJob } from "@/lib/jobs";
import { runLaneJob } from "@/lib/lane";
import { LANE_MODEL } from "@/lib/lane-crypto";

/** OpenAI-compatible embeddings. */
export async function POST(req: Request) {
  const caller = await callerOrPay(req); // null: no key, pay per request with x402
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "JSON body required.");
  // The laptop lane is opt-in by model name: its laptops see the text they embed.
  if (body.model === LANE_MODEL) {
    if (!caller) return apiError(401, "authentication_error", "The laptop lane needs an API key (x402 isn't offered for it).", "invalid_api_key");
    return runLaneJob(caller, body);
  }
  return runJob(req, caller, "embedding", body);
}
