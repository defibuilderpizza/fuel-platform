import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { runClassification } from "@/lib/classify";

/**
 * Zero-shot classification on the laptop lane.
 * Body: { input: string | string[], labels: string[], hypothesis_template?: "This text is about {}." }
 * Returns each text's best label and every label's score (softmax) and similarity (cosine).
 * Laptops see the texts they process (encrypted to them, never stored by Fuel).
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return apiError(400, "invalid_request_error", "JSON body required.");
  return runClassification(caller, body);
}
