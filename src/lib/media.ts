import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { apiError, rateLimited } from "@/lib/http";
import { jobRateLimit } from "@/lib/limits";
import { microToUsd, withMarkup } from "@/lib/money";
import type { Caller } from "@/lib/auth";
import { x402Caller, x402LinkJob, x402Probe } from "@/lib/x402";
import { GUEST_SPEECH_CHARS, guestCapRefusal, guestModelRefusal, isGuest } from "@/lib/guest";
import media from "../../data/media-models.json";
import { speedOf, type Quality, type Speed, isRecommended, mediaTags, type Tag } from "@/lib/labels";

// Pictures, video clips and 3D models, priced per output. Pictures and 3D run in one request;
// clips run asynchronously (start, then poll). Fuel passes the provider's temporary links
// through and never stores outputs; a clip job keeps only the provider's job handle to poll it.
// Privacy: fal requests send X-Fal-Store-IO: 0 and a 1-hour file expiry; Together runs with
// prompt storage off. Models with a `partner` run on that company's own servers behind fal,
// where fal's settings don't bind them: Fuel says so wherever the model is offered.

export type MediaKind = "image" | "video" | "mesh" | "speech" | "transcription";
export const IMAGE_SIZES = { square: [1024, 1024], portrait: [768, 1344], landscape: [1344, 768] } as const;
const TOGETHER = "https://api.together.xyz";

type Entry = { model: string; provider: string; endpoint?: string; cost: number; blurb: string; partner?: string; input?: Record<string, unknown>; image_field?: string; typical_seconds?: number; quality?: string; text_field?: string; voice_field?: string; voices?: string[] };
const ENTRIES: Entry[] = [...(media.image as Entry[]), ...(media.video as Entry[]), ...((media.mesh ?? []) as Entry[]), ...((media.speech ?? []) as Entry[]), ...((media.transcription ?? []) as Entry[])];
const entryOf = (model: string) => ENTRIES.find((e) => e.model === model);

/** Who besides the provider sees the prompt and output, as a sentence (null when it stays with the provider). */
export function privacyNote(model: string): string | null {
  const p = entryOf(model)?.partner;
  const own = p?.endsWith("s") ? `${p}'` : `${p}'s`;
  return p ? `Runs on ${own} own servers through fal: ${p} may keep prompts and outputs under its own policy. Fuel and fal don't keep them.` : null;
}

type MediaRoute = { model: string; provider: string; providerModelId: string; costMicro: number; unit: string };

/** The cheapest enabled route for a media model. */
async function mediaRoute(model: string, kind: MediaKind): Promise<MediaRoute | null> {
  const { data } = await supabaseAdmin()
    .from("provider_models")
    .select("model, provider, provider_model_id, unit_price_usd, unit")
    .eq("model", model)
    .eq("kind", kind)
    .eq("enabled", true);
  const keyed = (p: string) => (p === "fal" ? !!falKey() : p === "together" ? !!togetherKey() : false);
  const rows = (data ?? []).filter((r) => keyed(r.provider) && Number(r.unit_price_usd) > 0);
  if (!rows.length) return null;
  const r = rows.sort((a, b) => Number(a.unit_price_usd) - Number(b.unit_price_usd))[0];
  return { model: r.model, provider: r.provider, providerModelId: r.provider_model_id, costMicro: Math.ceil(Number(r.unit_price_usd) * 1e6), unit: r.unit ?? "image" };
}

export type MediaCard = { model: string; kind: MediaKind; priceUsd: number; unit: string; blurb: string; privacy: string | null; typicalSeconds: number | null; voices: string[]; quality: Quality | null; speed: Speed | null; recommended: boolean; tags: Tag[] };

/** Every enabled media model with Fuel's price per output (for the catalog and studio). */
export async function mediaCatalogue(): Promise<MediaCard[]> {
  const { data } = await supabaseAdmin().from("provider_models").select("model, kind, unit_price_usd, unit").in("kind", ["image", "video", "mesh", "speech", "transcription"]).eq("enabled", true);
  const best = new Map<string, MediaCard>();
  for (const r of data ?? []) {
    const price = microToUsd(withMarkup(Math.ceil(Number(r.unit_price_usd) * 1e6)));
    const cur = best.get(r.model);
    if (!cur || price < cur.priceUsd) best.set(r.model, { model: r.model, kind: r.kind as MediaKind, priceUsd: price, unit: r.unit ?? "image", blurb: entryOf(r.model)?.blurb ?? "", privacy: privacyNote(r.model), typicalSeconds: entryOf(r.model)?.typical_seconds ?? null, voices: entryOf(r.model)?.voices ?? [], quality: (entryOf(r.model)?.quality as Quality | undefined) ?? null, speed: speedOf(r.kind, entryOf(r.model)?.typical_seconds), recommended: isRecommended(r.kind, r.model), tags: [] });
  }
  // Recommended first (it becomes the studio default), then cheapest first.
  const cards = [...best.values()];
  // Cheapest and fastest within each kind.
  for (const kind of new Set(cards.map((c) => c.kind))) {
    const tags = mediaTags(cards.filter((c) => c.kind === kind));
    for (const c of cards) if (c.kind === kind) c.tags = tags[c.model] ?? [];
  }
  return cards.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.priceUsd - b.priceUsd);
}

/** Prompts Fuel won't send for pictures, video or 3D, whatever the provider's own filters do. */
export function mediaRefusal(prompt: string): string | null {
  const p = prompt.toLowerCase();
  const minor = /\b(child|children|kid|kids|minor|minors|underage|teen|teens|teenager|preteen|schoolgirl|schoolboy|toddler|baby|loli|shota|\d{1,2}[- ]?(yo|year[- ]?old))\b/;
  const sexual = /\b(nude|naked|nsfw|sex|sexual|sexy|erotic|porn|lingerie|undress|topless|explicit|fetish)\b/;
  if (minor.test(p) && sexual.test(p)) return "This prompt isn't allowed.";
  return null;
}

const reserveError = (reserved: string, hold: number) => {
  const need = microToUsd(hold).toFixed(6);
  if (reserved === "insufficient_balance") return apiError(402, "insufficient_balance", `This needs $${need} held. Top up your balance (GET /v1/account shows the deposit address).`);
  if (reserved === "credit_overdue") return apiError(402, "insufficient_balance", "Your credit is overdue. Top up to repay it, then jobs run again.", "credit_overdue");
  if (reserved === "per_job_limit") return apiError(402, "spending_limit", `This costs $${need}, above your per-job limit.`, "per_job_limit");
  return apiError(402, "spending_limit", "Your daily spending limit would be exceeded.", "daily_limit");
};

async function settle(jobId: string, ok: boolean, route: MediaRoute | null, costMicro: number, priceMicro: number, startedAt: number) {
  const { data, error } = await supabaseAdmin().rpc("fuel_settle", {
    p_job: jobId,
    p_status: ok ? "succeeded" : "failed",
    p_provider: route?.provider ?? null,
    p_attempts: route ? [{ provider: route.provider, ok, status: ok ? 200 : null, ms: Date.now() - startedAt }] : [],
    p_input_tokens: null,
    p_output_tokens: null,
    p_provider_cost: ok ? costMicro : null,
    p_price: ok ? priceMicro : 0,
    p_latency_ms: Date.now() - startedAt,
  });
  if (error) console.error("media settle failed", jobId, error.message);
  return Number(data ?? 0);
}

const NOUN = { image: "picture", video: "video", mesh: "3D", speech: "speech", transcription: "transcription" } as const;

/** Validates, prices, takes payment (balance or x402) and reserves. Shared by every media kind. */
async function begin(req: Request, callerIn: Caller | null, kind: MediaKind, body: Record<string, unknown>, outputs: number) {
  const model = typeof body.model === "string" ? body.model : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!model || !prompt) {
    const probe = callerIn ? null : await x402Probe(req);
    if (probe) return { error: probe };
  }
  if (!model) return { error: apiError(400, "invalid_request_error", "'model' is required.") };
  if (!prompt || prompt.length > 2000) return { error: apiError(400, "invalid_request_error", "'prompt' is required (up to 2,000 characters).") };
  const refused = mediaRefusal(prompt);
  if (refused) return { error: apiError(400, "invalid_request_error", refused, "content_not_allowed") };
  const route = await mediaRoute(model, kind);
  if (!route) return { error: apiError(404, "not_found", `'${model}' isn't a ${NOUN[kind]} model on Fuel. See /models.`, "model_not_found") };
  const cost = Math.ceil(route.costMicro * outputs);
  const hold = withMarkup(cost);

  let caller = callerIn;
  let payment: { header: string; signature: string } | null = null;
  if (!caller) {
    const paid = await x402Caller(req, hold);
    if (!paid) return { error: apiError(401, "authentication_error", "Missing or invalid API key. Send 'Authorization: Bearer fuel_sk_...'.", "invalid_api_key") };
    if (paid instanceof Response) return { error: paid };
    caller = paid.caller;
    payment = { header: paid.paymentResponse, signature: paid.signature };
  }
  if (isGuest(caller.wallet)) {
    const refusal = guestModelRefusal(kind, model) ?? (kind === "speech" && prompt.length > GUEST_SPEECH_CHARS ? `The free trial reads up to ${GUEST_SPEECH_CHARS} characters at a time. Sign in with a wallet for longer text.` : null) ?? (await guestCapRefusal(caller.wallet, kind));
    if (refusal) return { error: apiError(403, "permission_error", refusal, "guest_trial") };
  }
  const rl = await jobRateLimit(caller.wallet);
  if (rl.limited) return { error: rateLimited(`Rate limit: ${rl.limit} jobs per minute per account. Retry after ${rl.retryAfter}s.`, rl.retryAfter) };

  const jobId = randomUUID();
  if (payment) await x402LinkJob(payment.signature, jobId);
  const { data: reserved, error } = await supabaseAdmin().rpc("fuel_reserve", { p_job: jobId, p_wallet: caller.wallet, p_model: model, p_kind: kind, p_hold: hold, p_streamed: false });
  if (error) return { error: apiError(500, "server_error", "Could not reserve balance.") };
  if (reserved !== "ok") return { error: reserveError(String(reserved), hold) };
  await supabaseAdmin().from("jobs").update({ outputs: Math.ceil(outputs) }).eq("id", jobId);
  return { ok: { caller, jobId, route, prompt, model, cost, hold, payment } };
}

const withPayment = (res: Response, payment: { header: string } | null) => {
  if (payment) {
    res.headers.set("PAYMENT-RESPONSE", payment.header);
    res.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE, x-fuel-job-id, x-fuel-price-usd");
  }
  return res;
};

function togetherKey() {
  return process.env.TOGETHER_API_KEY?.trim() ?? "";
}
function falKey() {
  return process.env.FAL_KEY?.trim() ?? "";
}
/** fal keeps neither the request (prompt) nor, after an hour, the output files. */
const FAL_PRIVACY = { "X-Fal-Store-IO": "0", "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: 3600 }) };
const falHeaders = () => ({ authorization: `Key ${falKey()}`, "content-type": "application/json", ...FAL_PRIVACY });

type Fail = { status: number; message: string };
const failOf = async (res: Response, j: Record<string, unknown>, what: string): Promise<Fail> => {
  const detail = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? JSON.stringify(j.detail).slice(0, 200) : undefined;
  const err = (j.error as { message?: string } | undefined)?.message;
  return { status: res.status, message: err ?? detail ?? `The ${what} provider refused it (${res.status}).` };
};

/** Calls the picture provider; returns the picture URLs or an error. */
async function makePictures(route: { provider: string; providerModelId: string }, prompt: string, n: number, size: readonly [number, number], signal: AbortSignal): Promise<{ urls: string[] } | Fail> {
  const fal = route.provider === "fal";
  const res = await fetch(fal ? `https://fal.run/${route.providerModelId}` : `${TOGETHER}/v1/images/generations`, {
    method: "POST",
    headers: fal ? falHeaders() : { authorization: `Bearer ${togetherKey()}`, "content-type": "application/json" },
    body: JSON.stringify(
      fal
        ? { prompt, num_images: n, image_size: { width: size[0], height: size[1] }, enable_safety_checker: true, output_format: "jpeg" }
        : { model: route.providerModelId, prompt, n, width: size[0], height: size[1], response_format: "url" },
    ),
    signal,
  });
  const j = (await res.json().catch(() => ({}))) as { images?: { url?: string }[]; data?: { url?: string }[] };
  const urls = (j.images ?? j.data ?? []).map((d) => d.url).filter((u): u is string => typeof u === "string");
  if (res.ok && urls.length) return { urls };
  return failOf(res, j as Record<string, unknown>, "picture");
}

const badStatus = (s: number) => (s >= 400 && s < 500 && s !== 429 && s !== 403 ? 400 : 502);

/** POST /v1/images/generations: OpenAI-style, returns temporary URLs plus a Fuel receipt. */
export async function runImageJob(req: Request, caller: Caller | null, body: Record<string, unknown>) {
  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > 4) return apiError(400, "invalid_request_error", "'n' must be 1 to 4.");
  const sizeKey = typeof body.size === "string" ? body.size : "1024x1024";
  const size = Object.values(IMAGE_SIZES).find(([w, h]) => `${w}x${h}` === sizeKey) ?? (sizeKey in IMAGE_SIZES ? IMAGE_SIZES[sizeKey as keyof typeof IMAGE_SIZES] : null);
  if (!size) return apiError(400, "invalid_request_error", "'size' must be 1024x1024, 768x1344 or 1344x768.");
  const b = await begin(req, caller, "image", body, n);
  if ("error" in b) return b.error!;
  const { jobId, route, prompt, model, cost, hold, payment } = b.ok;
  const startedAt = Date.now();
  let out: Awaited<ReturnType<typeof makePictures>>;
  try {
    out = await makePictures(route, prompt, n, size, AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]));
  } catch {
    await settle(jobId, false, route, 0, 0, startedAt);
    return withPayment(apiError(502, "provider_error", "The picture provider didn't answer. You were not charged.", "all_providers_failed"), payment);
  }
  if (!("urls" in out)) {
    await settle(jobId, false, route, 0, 0, startedAt);
    const status = badStatus(out.status);
    return withPayment(apiError(status, status === 400 ? "invalid_request_error" : "provider_error", `${out.message} You were not charged.`), payment);
  }
  const urls = out.urls;
  const charged = await settle(jobId, true, route, cost * (urls.length / n), Math.round(hold * (urls.length / n)), startedAt);
  const fuel = { job_id: jobId, provider: route.provider, price_usd: microToUsd(charged), outputs: urls.length, unit: "image", latency_ms: Date.now() - startedAt };
  const privacy = privacyNote(model);
  return withPayment(
    Response.json(
      { created: Math.floor(Date.now() / 1000), model, data: urls.map((url) => ({ url })), note: "Links expire within an hour: save the pictures you want to keep.", ...(privacy ? { privacy } : {}), fuel },
      { headers: { "x-fuel-job-id": jobId, "x-fuel-price-usd": String(fuel.price_usd) } },
    ),
    payment,
  );
}

/** POST /v1/videos: starts a clip. Poll GET /v1/videos/:id until it's completed. */
export async function startVideoJob(req: Request, caller: Caller | null, body: Record<string, unknown>) {
  const b = await begin(req, caller, "video", body, 1);
  if ("error" in b) return b.error!;
  const { jobId, route, prompt, model, hold, payment } = b.ok;
  const startedAt = Date.now();
  const fal = route.provider === "fal";
  let res: Response;
  try {
    res = fal
      ? await fetch(`https://queue.fal.run/${route.providerModelId}`, { method: "POST", headers: falHeaders(), body: JSON.stringify({ prompt, ...(entryOf(model)?.input ?? {}) }), signal: AbortSignal.timeout(60_000) })
      : await fetch(`${TOGETHER}/v2/videos`, {
          method: "POST",
          headers: { authorization: `Bearer ${togetherKey()}`, "content-type": "application/json" },
          body: JSON.stringify({ model: route.providerModelId, prompt, seconds: "5" }),
          signal: AbortSignal.timeout(60_000),
        });
  } catch {
    await settle(jobId, false, route, 0, 0, startedAt);
    return withPayment(apiError(502, "provider_error", "The video provider didn't answer. You were not charged.", "all_providers_failed"), payment);
  }
  const j = (await res.json().catch(() => ({}))) as { id?: string; request_id?: string; status_url?: string; response_url?: string };
  const handle = fal ? (j.status_url && j.response_url ? JSON.stringify({ s: j.status_url, r: j.response_url }) : null) : (j.id ?? null);
  if (!res.ok || !handle) {
    await settle(jobId, false, route, 0, 0, startedAt);
    const f = await failOf(res, j as Record<string, unknown>, "video");
    return withPayment(apiError(badStatus(res.status), "provider_error", `${f.message} You were not charged.`), payment);
  }
  await supabaseAdmin().from("jobs").update({ provider_job_id: handle, provider: route.provider }).eq("id", jobId);
  const privacy = privacyNote(model);
  return withPayment(
    Response.json(
      { id: jobId, object: "video", status: "in_progress", model, poll: `/v1/videos/${jobId}`, held_usd: microToUsd(hold), note: "Clips take from under a minute to several minutes. You're charged only when it's ready.", ...(privacy ? { privacy } : {}) },
      { status: 202, headers: { "x-fuel-job-id": jobId } },
    ),
    payment,
  );
}

type ClipCheck = { state: "running"; queued?: boolean; position?: number } | { state: "done"; url: string; costMicro: number | null } | { state: "failed"; message: string };

async function checkClip(provider: string, handle: string): Promise<ClipCheck> {
  if (provider === "fal") {
    const h = JSON.parse(handle) as { s: string; r: string };
    const st = (await (await fetch(h.s, { headers: falHeaders(), signal: AbortSignal.timeout(20_000) })).json().catch(() => ({}))) as { status?: string; queue_position?: number };
    if (st.status === "IN_QUEUE") return { state: "running", queued: true, position: typeof st.queue_position === "number" ? st.queue_position : undefined };
    if (st.status !== "COMPLETED") return { state: "running" };
    const r = await fetch(h.r, { headers: falHeaders(), signal: AbortSignal.timeout(20_000) });
    const out = (await r.json().catch(() => ({}))) as { video?: { url?: string }; model_mesh?: { url?: string }; detail?: unknown };
    const url = out.video?.url ?? out.model_mesh?.url;
    if (r.ok && url) return { state: "done", url, costMicro: null };
    return { state: "failed", message: (await failOf(r, out as Record<string, unknown>, "video")).message };
  }
  const r = await fetch(`${TOGETHER}/v2/videos/${encodeURIComponent(handle)}`, { headers: { authorization: `Bearer ${togetherKey()}` }, signal: AbortSignal.timeout(20_000) });
  const v = (await r.json().catch(() => ({}))) as { status?: string; outputs?: { video_url?: string; cost?: number } | null; error?: { message?: string } | null };
  if (v.status === "completed" && v.outputs?.video_url) return { state: "done", url: v.outputs.video_url, costMicro: typeof v.outputs.cost === "number" && v.outputs.cost > 0 ? Math.ceil(v.outputs.cost * 1e6) : null };
  if (v.status === "failed" || v.status === "cancelled") return { state: "failed", message: v.error?.message ?? "The clip couldn't be made." };
  return { state: "running" };
}

/** Checks a clip or 3D model with the provider and settles it once it's finished. Anyone with the id can poll. */
export async function mediaStatus(jobId: string, kind: "video" | "mesh") {
  const db = supabaseAdmin();
  const { data: job } = await db.from("jobs").select("id, model, status, kind, provider, provider_job_id, hold_micro, price_micro, created_at, finished_at").eq("id", jobId).eq("kind", kind).maybeSingle();
  if (!job) return { status: 404 as const, body: { error: { message: `No such ${kind === "video" ? "video" : "3D"} job.`, type: "not_found", code: "not_found" } } };
  const base = { id: job.id, object: kind === "video" ? "video" : "model", model: job.model };
  if (!job.provider_job_id) return { status: 200 as const, body: { ...base, status: job.status === "running" ? "in_progress" : "failed" } };

  let c: ClipCheck;
  try {
    c = await checkClip(job.provider ?? "together", job.provider_job_id);
  } catch {
    return { status: 200 as const, body: { ...base, status: job.status === "running" ? "in_progress" : job.status } };
  }
  const route = await mediaRoute(job.model, kind);
  const startedAt = Date.parse(job.created_at);
  if (job.status === "running" && c.state === "done") {
    // The provider's reported cost (with markup) when it gives one, else the listed price; never more than the hold.
    const cost = c.costMicro ?? route?.costMicro ?? 0;
    const price = Math.min(withMarkup(cost), Number(job.hold_micro));
    await settle(job.id, true, route ?? { model: job.model, provider: job.provider ?? "together", providerModelId: job.model, costMicro: cost, unit: kind === "video" ? "clip" : "model" }, cost, price, startedAt);
  } else if (job.status === "running" && c.state === "failed") {
    await settle(job.id, false, route, 0, 0, startedAt);
  }
  const { data: after } = await db.from("jobs").select("status, price_micro, latency_ms").eq("id", jobId).single();
  const status = after?.status === "succeeded" ? "completed" : after?.status === "failed" ? "failed" : "in_progress";
  const privacy = privacyNote(job.model);
  return {
    status: 200 as const,
    body: {
      ...base,
      status,
      ...(status === "completed" && c.state === "done" ? { url: c.url, ...(kind === "mesh" ? { format: "glb" } : {}), note: "The link expires within an hour: save it." } : {}),
      ...(status === "failed" ? { error: { message: `${c.state === "failed" ? c.message : "It couldn't be made."} You were not charged.` } } : {}),
      ...(status === "in_progress" && c.state === "running" ? { stage: c.queued ? "queued" : "running", ...(c.position !== undefined ? { queue_position: c.position } : {}) } : {}),
      ...(privacy ? { privacy } : {}),
      ...(status !== "in_progress" ? { fuel: { job_id: job.id, provider: job.provider ?? "together", price_usd: microToUsd(after?.price_micro), outputs: status === "completed" ? 1 : 0, unit: kind === "video" ? "clip" : "model", latency_ms: after?.latency_ms ?? null } } : {}),
    },
  };
}

export const videoStatus = (jobId: string) => mediaStatus(jobId, "video");

/** Cron: settles clips and 3D models nobody polled (so the charge and the hold never wait on the caller). */
export async function settlePendingVideos() {
  const { data } = await supabaseAdmin().from("jobs").select("id, kind").in("kind", ["video", "mesh"]).eq("status", "running").not("provider_job_id", "is", null).lt("created_at", new Date(Date.now() - 60_000).toISOString()).limit(50);
  let settled = 0;
  for (const j of data ?? []) {
    const r = await mediaStatus(j.id, j.kind as "video" | "mesh");
    if (r.status === 200 && r.body.status !== "in_progress") settled++;
  }
  return { checked: (data ?? []).length, settled };
}

/**
 * POST /v1/3d: a prompt becomes a quick picture (FLUX schnell), then a 3D model (GLB), started on
 * fal's queue: poll GET /v1/3d/:id. Both steps run with storage off; the price includes the picture.
 */
export async function runMeshJob(req: Request, caller: Caller | null, body: Record<string, unknown>) {
  const b = await begin(req, caller, "mesh", body, 1);
  if ("error" in b) return b.error!;
  const { jobId, route, prompt, model, hold, payment } = b.ok;
  const startedAt = Date.now();
  const fail = async (status: number, message: string) => {
    await settle(jobId, false, route, 0, 0, startedAt);
    return withPayment(apiError(badStatus(status), badStatus(status) === 400 ? "invalid_request_error" : "provider_error", `${message} You were not charged.`), payment);
  };
  try {
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(90_000)]);
    const pic = await makePictures({ provider: "fal", providerModelId: media.mesh_picture.endpoint }, `${prompt}, single object, centered, plain background, studio lighting`, 1, IMAGE_SIZES.square, signal);
    if (!("urls" in pic)) return fail(pic.status, pic.message);
    const field = entryOf(model)?.image_field ?? "image_url";
    const res = await fetch(`https://queue.fal.run/${route.providerModelId}`, { method: "POST", headers: falHeaders(), body: JSON.stringify({ [field]: pic.urls[0] }), signal });
    const j = (await res.json().catch(() => ({}))) as { status_url?: string; response_url?: string };
    if (!res.ok || !j.status_url || !j.response_url) return fail(res.status, (await failOf(res, j as Record<string, unknown>, "3D")).message);
    await supabaseAdmin().from("jobs").update({ provider_job_id: JSON.stringify({ s: j.status_url, r: j.response_url }), provider: route.provider }).eq("id", jobId);
    return withPayment(
      Response.json(
        { id: jobId, object: "model", status: "in_progress", model, poll: `/v1/3d/${jobId}`, preview_url: pic.urls[0], held_usd: microToUsd(hold), note: "3D models take about one to four minutes. You're charged only when it's ready." },
        { status: 202, headers: { "x-fuel-job-id": jobId } },
      ),
      payment,
    );
  } catch {
    return fail(502, "The 3D provider didn't answer.");
  }
}

// ── Voice ──────────────────────────────────────────────────────────────────────────────────

/** Sets a dotted field ("voice_setting.voice_id") on a request body. */
function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = v;
}

/**
 * POST /v1/audio/speech (OpenAI shape): { model, input, voice?, response_format? }. Priced per
 * 1,000 characters. Returns the audio itself, or { url, fuel } JSON with response_format "url".
 */
export async function runSpeechJob(req: Request, caller: Caller | null, body: Record<string, unknown>) {
  const input = typeof body.input === "string" ? body.input : typeof body.prompt === "string" ? body.prompt : "";
  if (!input.trim() && !caller) {
    const probe = await x402Probe(req);
    if (probe) return probe;
  }
  if (!input.trim() || input.length > 5000) return apiError(400, "invalid_request_error", "'input' is required (up to 5,000 characters).");
  const e = entryOf(typeof body.model === "string" ? body.model : "");
  const voice = typeof body.voice === "string" && body.voice ? body.voice : e?.voices?.[0];
  if (e?.voices?.length && voice && !e.voices.includes(voice)) return apiError(400, "invalid_request_error", `'voice' must be one of: ${e.voices.join(", ")}.`);
  const b = await begin(req, caller, "speech", { ...body, prompt: input }, input.length / 1000);
  if ("error" in b) return b.error!;
  const { jobId, route, model, cost, hold, payment } = b.ok;
  const startedAt = Date.now();
  const fail = async (status: number, message: string) => {
    await settle(jobId, false, route, 0, 0, startedAt);
    return withPayment(apiError(badStatus(status), "provider_error", `${message} You were not charged.`), payment);
  };
  try {
    const payload: Record<string, unknown> = { ...(entryOf(model)?.input ?? {}) };
    payload[entryOf(model)?.text_field ?? "text"] = input;
    if (voice) setPath(payload, entryOf(model)?.voice_field ?? "voice", voice);
    const res = await fetch(`https://fal.run/${route.providerModelId}`, { method: "POST", headers: falHeaders(), body: JSON.stringify(payload), signal: AbortSignal.any([req.signal, AbortSignal.timeout(120_000)]) });
    const j = (await res.json().catch(() => ({}))) as { audio?: { url?: string; content_type?: string } };
    const url = j.audio?.url;
    if (!res.ok || !url) return fail(res.status, (await failOf(res, j as Record<string, unknown>, "speech")).message);
    const charged = await settle(jobId, true, route, cost, hold, startedAt);
    const fuel = { job_id: jobId, provider: route.provider, price_usd: microToUsd(charged), characters: input.length, unit: "1k_chars", latency_ms: Date.now() - startedAt };
    const privacy = privacyNote(model);
    if (body.response_format === "url") {
      return withPayment(Response.json({ model, voice, url, content_type: j.audio?.content_type ?? "audio/wav", note: "The link expires within an hour: save the audio.", ...(privacy ? { privacy } : {}), fuel }, { headers: { "x-fuel-job-id": jobId } }), payment);
    }
    // OpenAI shape: the audio bytes themselves (passed through, not stored).
    const audio = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!audio.ok || !audio.body) return withPayment(Response.json({ model, url, fuel, note: "Couldn't fetch the audio; use this link (expires within an hour)." }), payment);
    return withPayment(
      new Response(audio.body, { headers: { "content-type": j.audio?.content_type ?? audio.headers.get("content-type") ?? "audio/wav", "x-fuel-job-id": jobId, "x-fuel-price-usd": String(fuel.price_usd), "x-fuel-receipt": JSON.stringify(fuel) } }),
      payment,
    );
  } catch {
    return fail(502, "The speech provider didn't answer.");
  }
}

/** Puts a file in fal's storage (1-hour expiry) and returns its URL. */
async function falUpload(file: Blob, name: string): Promise<string | null> {
  const init = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
    method: "POST",
    headers: falHeaders(),
    body: JSON.stringify({ content_type: file.type || "application/octet-stream", file_name: name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "audio" }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await init.json().catch(() => ({}))) as { upload_url?: string; file_url?: string };
  if (!init.ok || !j.upload_url || !j.file_url) return null;
  const put = await fetch(j.upload_url, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file, signal: AbortSignal.timeout(60_000) });
  return put.ok ? j.file_url : null;
}

/** Most audio one transcription holds for (and the largest file the API takes). */
const TRANSCRIBE_MAX_MINUTES = 10;
const TRANSCRIBE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * POST /v1/audio/transcriptions (OpenAI shape, multipart): file, model. Holds for up to 10
 * minutes of audio and charges the audio's real length. Returns { text, fuel }.
 */
export async function runTranscriptionJob(req: Request, caller: Caller | null) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "Send multipart/form-data with 'file' and 'model'.");
  }
  const file = form.get("file");
  const model = String(form.get("model") ?? "openai/whisper");
  if (!(file instanceof Blob) || file.size === 0) return (caller ? null : await x402Probe(req)) ?? apiError(400, "invalid_request_error", "'file' (audio) is required.");
  if (file.size > TRANSCRIBE_MAX_BYTES) return apiError(413, "invalid_request_error", "Audio files can be up to 4 MB here.");
  const b = await begin(req, caller, "transcription", { model, prompt: "(audio)" }, TRANSCRIBE_MAX_MINUTES);
  if ("error" in b) return b.error!;
  const { jobId, route, payment } = b.ok;
  const startedAt = Date.now();
  const fail = async (status: number, message: string) => {
    await settle(jobId, false, route, 0, 0, startedAt);
    return withPayment(apiError(badStatus(status), "provider_error", `${message} You were not charged.`), payment);
  };
  try {
    const url = await falUpload(file, (file as File).name ?? "audio");
    if (!url) return fail(502, "Couldn't upload the audio.");
    const res = await fetch(`https://fal.run/${route.providerModelId}`, { method: "POST", headers: falHeaders(), body: JSON.stringify({ audio_url: url, task: "transcribe" }), signal: AbortSignal.any([req.signal, AbortSignal.timeout(180_000)]) });
    const j = (await res.json().catch(() => ({}))) as { text?: string; chunks?: { timestamp?: [number, number | null] }[] };
    if (!res.ok || typeof j.text !== "string") return fail(res.status, (await failOf(res, j as Record<string, unknown>, "transcription")).message);
    const seconds = Math.max(1, ...(j.chunks ?? []).map((c) => Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0)));
    const minutes = Math.min(TRANSCRIBE_MAX_MINUTES, seconds / 60);
    const cost = Math.ceil(route.costMicro * minutes);
    const charged = await settle(jobId, true, route, cost, Math.min(withMarkup(cost), b.ok.hold), startedAt);
    const fuel = { job_id: jobId, provider: route.provider, price_usd: microToUsd(charged), audio_seconds: Math.round(seconds), unit: "minute", latency_ms: Date.now() - startedAt };
    return withPayment(Response.json({ text: j.text.trim(), model, fuel }, { headers: { "x-fuel-job-id": jobId, "x-fuel-price-usd": String(fuel.price_usd) } }), payment);
  } catch {
    return fail(502, "The transcription provider didn't answer.");
  }
}
