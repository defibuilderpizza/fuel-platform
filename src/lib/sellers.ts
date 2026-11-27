import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd } from "@/lib/money";

// GPU / endpoint sellers: people running an OpenAI-compatible server who sell its models on Fuel.

// ── Secrets at rest ────────────────────────────────────────────────────────
function secretsKey() {
  const hex = process.env.FUEL_SECRETS_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("FUEL_SECRETS_KEY missing");
  return Buffer.from(hex, "hex");
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secretsKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decryptSecret(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", secretsKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ── Endpoint safety: Fuel's server must never be pointed at private networks ──
function privateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

// Sellers sell compute they run (or have the right to resell). Commercial model APIs can't be
// listed as a seller endpoint: re-selling them through Fuel would break those providers' terms.
// Matched on the hostname and its parent domains. FUEL_TEST_SELLER_HOSTS (dev only, comma list)
// lets test scripts use a hosted API as a stand-in seller.
const BLOCKED_SELLER_HOSTS = [
  "openai.com",
  "openai.azure.com",
  "anthropic.com",
  "claude.ai",
  "googleapis.com",
  "together.xyz",
  "together.ai",
  "fireworks.ai",
  "groq.com",
  "deepinfra.com",
  "mistral.ai",
  "cohere.com",
  "cohere.ai",
  "openrouter.ai",
  "perplexity.ai",
  "x.ai",
  "deepseek.com",
  "cerebras.ai",
  "sambanova.ai",
  "hyperbolic.xyz",
  "novita.ai",
  "lepton.ai",
  "replicate.com",
  "huggingface.co",
  "amazonaws.com",
  "fuel-tau-eight.vercel.app",
  "fuelai.cloud",
];

export function blockedSellerHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const allowed = (process.env.FUEL_TEST_SELLER_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(host)) return false;
  return BLOCKED_SELLER_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
}

const safeCache = new Map<string, number>();
/** Throws unless the URL is https and every address it resolves to is public. */
export async function assertPublicEndpoint(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Not a valid URL.");
  }
  if (u.protocol !== "https:") throw new Error("The endpoint must use https.");
  if (u.username || u.password) throw new Error("Put the API key in its own field, not in the URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (blockedSellerHost(host)) {
    throw new Error("That's a commercial model API, not your own compute. List the server you run (or have the right to resell).");
  }
  const hit = safeCache.get(host);
  if (hit && Date.now() - hit < 5 * 60_000) return;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("That host isn't reachable from the internet.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error("That hostname doesn't resolve.");
  if (addrs.some((a) => privateAddress(a.address))) throw new Error("That endpoint points at a private network address.");
  safeCache.set(host, Date.now());
}

export function normaliseEndpoint(url: string) {
  return url.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|embeddings)$/, "");
}

// ── Probing ────────────────────────────────────────────────────────────────
// Every model gets a real test, not just a ping:
//   chat       – a question with one right answer ("17 + 25"); the reply must contain 42
//   embeddings – two different texts; both vectors must be numeric, the same size, and differ
// The same tests run when a seller applies and again every few minutes afterwards.
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_SLOW_MS = 15_000;

type ChatReply = { choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[] };
type EmbedReply = { data?: { embedding?: unknown }[] };

function chatText(j: ChatReply | null): string {
  const m = j?.choices?.[0]?.message;
  return [m?.content, m?.reasoning_content, m?.reasoning].filter((x) => typeof x === "string").join(" ");
}
function vectorOk(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 8 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export async function probeModel(endpoint: string, apiKey: string | null, model: { provider_model_id: string; kind: string }) {
  const t0 = Date.now();
  const embed = model.kind === "embedding";
  const path = embed ? "/embeddings" : "/chat/completions";
  const body = embed
    ? { model: model.provider_model_id, input: ["The ship sailed at dawn.", "Quarterly revenue rose 4%."] }
    : { model: model.provider_model_id, max_tokens: 256, temperature: 0, messages: [{ role: "user", content: "What is 17 + 25? Reply with just the number." }] };
  try {
    await assertPublicEndpoint(endpoint);
    const res = await fetch(endpoint + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the API key)" : res.status === 404 ? " (check the model ID and endpoint URL)" : ""}` };
    const j = await res.json().catch(() => null);
    if (embed) {
      const d = (j as EmbedReply | null)?.data;
      if (!Array.isArray(d) || d.length !== 2) return { ok: false, ms, error: "Embeddings response isn't OpenAI-shaped (expected 2 vectors)." };
      const [a, b] = [d[0]?.embedding, d[1]?.embedding];
      if (!vectorOk(a) || !vectorOk(b) || a.length !== b.length) return { ok: false, ms, error: "Embeddings aren't valid number vectors of one size." };
      if (a.every((x, i) => x === b[i])) return { ok: false, ms, error: "Different texts got identical embeddings." };
    } else {
      if (!Array.isArray((j as ChatReply | null)?.choices)) return { ok: false, ms, error: "Chat response isn't OpenAI-shaped." };
      if (!/\b42\b/.test(chatText(j as ChatReply))) return { ok: false, ms, error: "Answered the test question (17 + 25) wrongly." };
    }
    if (ms > PROBE_SLOW_MS) return { ok: false, ms, error: `Too slow: ${Math.round(ms / 1000)}s (limit ${PROBE_SLOW_MS / 1000}s).` };
    return { ok: true, ms, error: null };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 200) };
  }
}

export async function probeSeller(sellerId: string) {
  const db = supabaseAdmin();
  const { data: s } = await db.from("sellers").select("endpoint_url, api_key_enc").eq("id", sellerId).single();
  const { data: models } = await db.from("seller_models").select("model, kind, provider_model_id").eq("seller_id", sellerId);
  const key = s?.api_key_enc ? decryptSecret(s.api_key_enc) : null;
  const results = await Promise.all(
    (models ?? []).map(async (m) => {
      const r = await probeModel(s!.endpoint_url, key, m);
      await db
        .from("seller_models")
        .update({ probe_ok: r.ok, probe_ms: r.ms, probe_error: r.error, probed_at: new Date().toISOString() })
        .eq("seller_id", sellerId)
        .eq("model", m.model);
      return { model: m.model, ...r };
    }),
  );
  return results;
}

// ── Automatic review ───────────────────────────────────────────────────────
// No human in the loop: a listing is approved as soon as at least one model passes its test,
// and only passing models are routed. The checks keep running afterwards (sellerHealth), so a
// model that breaks drops out of routing on its own and comes back once it passes again. On top
// of that, the router fails over mid-job and cools a failing provider down. An admin can still
// pause or reject a seller; automatic review never overrides that.
// Turn it off with FUEL_SELLER_AUTO_APPROVE=0 to go back to manual approval.
export const autoApprove = () => process.env.FUEL_SELLER_AUTO_APPROVE !== "0";

/** Test a seller's models and approve or hold the listing. Returns the test results. */
export async function autoReview(sellerId: string) {
  const db = supabaseAdmin();
  const probes = await probeSeller(sellerId);
  const { data: s } = await db.from("sellers").select("status").eq("id", sellerId).single();
  if (autoApprove() && (s?.status === "pending" || s?.status === "approved")) {
    const passed = probes.filter((p) => p.ok).length;
    const status = passed > 0 ? "approved" : "pending";
    const note =
      passed === probes.length
        ? "Passed the automatic tests."
        : passed > 0
          ? `${passed} of ${probes.length} models passed the automatic tests; the rest aren't routed until they pass (re-tested every few minutes).`
          : "No model passed the automatic tests yet. Fix the errors shown; it's re-tested every few minutes.";
    await db.from("sellers").update({ status, review_note: note, reviewed_at: new Date().toISOString() }).eq("id", sellerId);
  }
  await syncSellerRoutes(sellerId);
  return probes;
}

/**
 * Re-test approved and waiting sellers (each at most every `everyMs`). Failing models leave
 * routing; passing ones return; waiting listings are approved once something passes.
 */
export async function sellerHealth(everyMs = 10 * 60_000, max = 25) {
  const db = supabaseAdmin();
  const { data: sellers } = await db.from("sellers").select("id, status").in("status", ["approved", "pending"]);
  const cutoff = new Date(Date.now() - everyMs).toISOString();
  const due: string[] = [];
  for (const s of sellers ?? []) {
    const { data: m } = await db.from("seller_models").select("probed_at").eq("seller_id", s.id).order("probed_at", { ascending: true, nullsFirst: true }).limit(1);
    if (!m?.[0]?.probed_at || m[0].probed_at < cutoff) due.push(s.id);
  }
  const out: { seller: string; passed: number; total: number }[] = [];
  for (const id of due.slice(0, max)) {
    const r = await autoReview(id).catch(() => []);
    out.push({ seller: id, passed: r.filter((p) => p.ok).length, total: r.length });
  }
  if (out.length) await approvedSellers(true);
  return { checked: out.length, due: due.length, results: out };
}

/** Puts an approved seller's working models into routing; takes everything else out. */
export async function syncSellerRoutes(sellerId: string) {
  const db = supabaseAdmin();
  const provider = `seller:${sellerId}`;
  const { data: s } = await db.from("sellers").select("status, endpoint_url").eq("id", sellerId).single();
  await db.from("provider_models").update({ enabled: false }).eq("provider", provider);
  if (s?.status !== "approved") return 0;
  const { data: models } = await db.from("seller_models").select("*").eq("seller_id", sellerId).eq("probe_ok", true);
  const rows = (models ?? []).map((m) => ({
    model: m.model,
    kind: m.kind,
    provider,
    provider_model_id: m.provider_model_id,
    base_url: s.endpoint_url,
    input_per_mtok: m.input_per_mtok,
    output_per_mtok: m.output_per_mtok,
    context_length: m.context_length,
    enabled: true,
    updated_at: new Date().toISOString(),
  }));
  if (rows.length) await db.from("provider_models").upsert(rows, { onConflict: "model,provider" });
  return rows.length;
}

/** Approved sellers' endpoints and keys, for the router. Cached briefly. */
let cache: { at: number; map: Map<string, { wallet: string; apiKey: string | null }> } | null = null;
export async function approvedSellers(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.map;
  const { data } = await supabaseAdmin().from("sellers").select("id, wallet, api_key_enc").eq("status", "approved");
  const map = new Map<string, { wallet: string; apiKey: string | null }>();
  for (const s of data ?? []) {
    try {
      map.set(s.id, { wallet: s.wallet, apiKey: s.api_key_enc ? decryptSecret(s.api_key_enc) : null });
    } catch {}
  }
  cache = { at: Date.now(), map };
  return map;
}

export async function sellerView(wallet: string) {
  const db = supabaseAdmin();
  const { data: sellers } = await db.from("sellers").select("id, name, endpoint_url, contact, status, review_note, created_at, reviewed_at, api_key_enc").eq("wallet", wallet).order("created_at");
  const out = [];
  for (const s of sellers ?? []) {
    const [{ data: models }, { count: jobs }] = await Promise.all([
      db.from("seller_models").select("model, kind, provider_model_id, input_per_mtok, output_per_mtok, context_length, probe_ok, probe_ms, probe_error, probed_at").eq("seller_id", s.id),
      db.from("jobs").select("id", { count: "exact", head: true }).eq("provider", `seller:${s.id}`).eq("status", "succeeded"),
    ]);
    const { api_key_enc, ...rest } = s;
    out.push({ ...rest, has_api_key: !!api_key_enc, models: models ?? [], jobs_served: jobs ?? 0 });
  }
  const { data: paid } = await db.from("ledger_entries").select("delta_micro").eq("wallet", wallet).eq("source", "seller_payout");
  return { sellers: out, earned_usd: microToUsd((paid ?? []).reduce((t, r) => t + Number(r.delta_micro), 0)) };
}
