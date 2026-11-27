import { callerOrPay, x402Probe } from "@/lib/x402";
import { apiError, readJson } from "@/lib/http";
import { runJob } from "@/lib/jobs";

/** OpenAI-compatible chat completions. Streaming supported. */
export async function POST(req: Request) {
  const caller = await callerOrPay(req); // null: no key, pay per request with x402
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "JSON body required.");
  return runJob(req, caller, "chat", body);
}
