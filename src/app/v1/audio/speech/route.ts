import { apiError, readJson } from "@/lib/http";
import { callerOrPay, x402Probe } from "@/lib/x402";
import { runSpeechJob } from "@/lib/media";

/** Text to speech (OpenAI shape). Body: { model, input, voice?, response_format?: "url" }. Priced per 1,000 characters. */
export async function POST(req: Request) {
  const caller = await callerOrPay(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "JSON body required.");
  return runSpeechJob(req, caller, body);
}
