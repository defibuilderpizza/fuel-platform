import { authenticate } from "@/lib/auth";
import { readJson } from "@/lib/http";
import { runJob } from "@/lib/jobs";
import { anthropicError, anthropicToOpenAI, fuelModelId, openAIToAnthropic, streamOpenAIToAnthropic } from "@/lib/anthropic-format";

/**
 * Anthropic Messages API format, so tools built on the Claude SDK work with Fuel:
 *   new Anthropic({ baseURL: "https://…/", apiKey: "fuel_sk_..." })
 * The SDK sends the key as x-api-key; a Bearer header works too. Any Fuel model can be used;
 * bare Claude ids ("claude-sonnet-5-5") map to "anthropic/claude-sonnet-5-5". Streaming supported.
 */
export async function POST(req: Request) {
  const key = req.headers.get("x-api-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authReq = new Request(req.url, { method: "POST", headers: { authorization: `Bearer ${key}` }, signal: req.signal });
  const caller = await authenticate(authReq);
  if (caller instanceof Response) return anthropicError(401, "Missing or invalid Fuel API key (send it as x-api-key or Authorization: Bearer).");

  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return anthropicError(400, "JSON body required.");
  if (typeof body.model !== "string" || !body.model) return anthropicError(400, "'model' is required.");
  if (!Array.isArray(body.messages)) return anthropicError(400, "'messages' must be an array.");
  if (typeof body.max_tokens !== "number" || body.max_tokens < 1) return anthropicError(400, "'max_tokens' is required.");

  const model = fuelModelId(body.model);
  const res = await runJob(authReq, caller, "chat", anthropicToOpenAI(body));
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return anthropicError(res.status, j.error?.message ?? `Request failed (${res.status})`);
  }
  const headers = { "x-fuel-job-id": res.headers.get("x-fuel-job-id") ?? "", "x-fuel-provider": res.headers.get("x-fuel-provider") ?? "" };
  if (body.stream === true) {
    const s = streamOpenAIToAnthropic(res, model);
    for (const [k, v] of Object.entries(headers)) if (v) s.headers.set(k, v);
    return s;
  }
  return Response.json(openAIToAnthropic(await res.json(), model), { headers });
}
