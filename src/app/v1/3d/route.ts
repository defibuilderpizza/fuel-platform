import { apiError, readJson } from "@/lib/http";
import { callerOrPay, x402Probe } from "@/lib/x402";
import { runMeshJob } from "@/lib/media";


/** Start a 3D model (GLB) from a prompt. Body: { model, prompt }. Returns 202; poll GET /v1/3d/:id. Priced per model. */
export async function POST(req: Request) {
  const caller = await callerOrPay(req);
  if (caller instanceof Response) return caller;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body || typeof body !== "object") return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "JSON body required.");
  return runMeshJob(req, caller, body);
}
