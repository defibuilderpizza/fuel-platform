import { apiError, readJson } from "@/lib/http";
import { callerOrPay, x402Probe } from "@/lib/x402";
import { runImageJob } from "@/lib/media";

/**
 * OpenAI-style picture generation. Body: { model, prompt, n?: 1-4, size?: 1024x1024 | 768x1344 |
 * 1344x768 }. Returns temporary URLs (save what you keep) and a receipt. Priced per picture.
 */
export async function POST(req: Request) {
  const caller = await callerOrPay(req); // null: no key, pay per request with x402
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "JSON body required.");
  return runImageJob(req, caller, body);
}
