import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { assertPublicEndpoint, autoReview, encryptSecret, normaliseEndpoint, sellerView, syncSellerRoutes } from "@/lib/sellers";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ceilingsFor } from "@/lib/forwards";

type ModelIn = { model?: unknown; kind?: unknown; provider_model_id?: unknown; input_per_mtok?: unknown; output_per_mtok?: unknown; context_length?: unknown };
type Body = { name?: unknown; endpoint_url?: unknown; api_key?: unknown; contact?: unknown; models?: unknown; attest?: unknown };

const MODEL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;
const price = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000 ? v : null);

/**
 * Apply to sell compute from an OpenAI-compatible endpoint, or update your application.
 * Body: { name, endpoint_url, api_key?, contact?, models: [{ model, kind?, provider_model_id?,
 *   input_per_mtok, output_per_mtok?, context_length? }] }. Prices are USD per 1M tokens: what
 * you're paid. Every model is tested straight away; passing models go live automatically.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<Body>(req);
  if (!b) return apiError(400, "invalid_request_error", "JSON body required.");

  if (b.attest !== true) {
    return apiError(400, "invalid_request_error", "Confirm you run this compute yourself or have the right to resell it ('attest': true).", "attestation_required");
  }
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 2 || name.length > 48) return apiError(400, "invalid_request_error", "'name' must be 2–48 characters.");
  if (typeof b.endpoint_url !== "string") return apiError(400, "invalid_request_error", "'endpoint_url' is required, e.g. https://gpu.example.com/v1");
  const endpoint = normaliseEndpoint(b.endpoint_url);
  try {
    await assertPublicEndpoint(endpoint);
  } catch (e) {
    return apiError(400, "invalid_request_error", (e as Error).message, "bad_endpoint");
  }
  if (b.api_key !== undefined && b.api_key !== null && (typeof b.api_key !== "string" || b.api_key.length > 400)) {
    return apiError(400, "invalid_request_error", "'api_key' must be a string (max 400 characters).");
  }
  const contact = typeof b.contact === "string" ? b.contact.trim().slice(0, 120) || null : null;
  if (!Array.isArray(b.models) || b.models.length === 0 || b.models.length > 20) return apiError(400, "invalid_request_error", "'models' must list 1–20 models.");

  const models = [];
  for (const m of b.models as ModelIn[]) {
    const model = typeof m.model === "string" ? m.model.trim() : "";
    if (!MODEL_RE.test(model) || model.length > 120) return apiError(400, "invalid_request_error", `Model '${model}' must look like org/name (use the name agents would send, e.g. openai/gpt-oss-120b).`);
    const kind = m.kind === "embedding" ? "embedding" : "chat";
    const pin = price(m.input_per_mtok);
    const pout = m.output_per_mtok === undefined ? 0 : price(m.output_per_mtok);
    if (pin === null || pout === null) return apiError(400, "invalid_request_error", `Prices for '${model}' must be numbers from 0 to 1000 (USD per 1M tokens).`);
    const pmid = typeof m.provider_model_id === "string" && m.provider_model_id.trim() ? m.provider_model_id.trim().slice(0, 120) : model;
    const ctx = typeof m.context_length === "number" && m.context_length > 0 ? Math.floor(m.context_length) : null;
    models.push({ model, kind, provider_model_id: pmid, input_per_mtok: pin, output_per_mtok: kind === "embedding" ? 0 : pout, context_length: ctx });
  }

  const db = supabaseAdmin();
  const { data: existing } = await db.from("sellers").select("id, api_key_enc").eq("wallet", caller.wallet).maybeSingle();
  const apiKeyEnc = typeof b.api_key === "string" && b.api_key ? encryptSecret(b.api_key) : b.api_key === null ? null : (existing?.api_key_enc ?? null);
  const { data: prev } = await db.from("sellers").select("status").eq("wallet", caller.wallet).maybeSingle();
  // A seller an admin paused or rejected stays that way; changes don't re-open the listing.
  const held = prev?.status === "paused" || prev?.status === "rejected";
  const row = { wallet: caller.wallet, name, endpoint_url: endpoint, api_key_enc: apiKeyEnc, contact, attested_at: new Date().toISOString(), ...(held ? {} : { status: "pending", review_note: null, reviewed_at: null }) };

  // Capacity contracts cap a model's price until they end: refuse edits that break the promise.
  if (existing?.id) {
    const ceilings = await ceilingsFor(existing.id);
    for (const [model, c] of ceilings) {
      const m = models.find((x) => x.model === model);
      const until = c.until ? ` until ${c.until.slice(0, 10)}` : "";
      if (!m) return apiError(409, "invalid_request_error", `You have a capacity contract for '${model}'${until}; it can't be removed from your listing.`, "under_contract");
      if (m.input_per_mtok > c.in || m.output_per_mtok > c.out) {
        return apiError(409, "invalid_request_error", `Your capacity contract caps '${model}' at $${c.in} in / $${c.out} out per 1M${until}.`, "above_ceiling");
      }
    }
  }

  let id = existing?.id as string | undefined;
  if (id) {
    await db.from("sellers").update(row).eq("id", id);
    await db.from("seller_models").delete().eq("seller_id", id);
    await syncSellerRoutes(id); // back to pending: out of routing until re-approved
  } else {
    const { data, error } = await db.from("sellers").insert(row).select("id").single();
    if (error) return apiError(500, "server_error", "Could not save the application.");
    id = data.id;
  }
  await db.from("seller_models").insert(models.map((m) => ({ ...m, seller_id: id })));
  const probes = await autoReview(id!);
  return Response.json({ ...(await sellerView(caller.wallet)), probes }, { status: existing ? 200 : 201 });
}
