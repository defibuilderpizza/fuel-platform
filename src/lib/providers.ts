import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { approvedSellers, assertPublicEndpoint } from "@/lib/sellers";
import { callAnthropic } from "@/lib/anthropic";

export type Kind = "chat" | "embedding";

export type Route = {
  provider: string;
  providerModelId: string;
  baseUrl: string;
  apiKey: string;
  inPerM: number; // provider cost, USD per 1M input tokens
  outPerM: number; // provider cost, USD per 1M output tokens
  payTo?: string; // a seller's wallet: paid the provider cost for each job it serves
  house?: boolean; // Fuel's own GPU
  context?: number | null; // max input + output tokens this route accepts at its listed price
  byok?: boolean; // the caller's own provider key: the provider bills them; Fuel charges only its BYOK fee
  discountBps?: number; // credit money on Fuel's GPU: this much off the agent's price
};

type Sellers = Map<string, { wallet: string; apiKey: string | null }>;

type Row = {
  model: string;
  kind: Kind;
  provider: string;
  provider_model_id: string;
  base_url: string | null;
  input_per_mtok: number | string;
  output_per_mtok: number | string;
  context_length: number | null;
};

export const mockEnabled = () => process.env.FUEL_ENABLE_MOCK === "1";

/**
 * Provider ids of Fuel-operated GPUs ("seller:<id>"). Cached only 5 s (and cleared when an admin
 * changes the flag), so a GPU marked as Fuel's never competes as an ordinary seller for long.
 */
const spareCache = new Map<string, { at: number; ok: boolean }>();
let houseCache: { at: number; ids: Set<string> } | null = null;
export function clearFuelOperatedCache() {
  houseCache = null;
  spareCache.clear();
}
export async function fuelOperatedProviders(fresh = false): Promise<Set<string>> {
  if (!fresh && houseCache && Date.now() - houseCache.at < 5_000) return houseCache.ids;
  const { data } = await supabaseAdmin().from("sellers").select("id").eq("operated_by_fuel", true);
  houseCache = { at: Date.now(), ids: new Set((data ?? []).map((s) => `seller:${s.id}`)) };
  return houseCache.ids;
}

/** Where a provider lives and its key. Null = provider not configured, skip it. */
function connection(row: Row, sellers: Sellers): { baseUrl: string; apiKey: string; payTo?: string } | null {
  if (row.provider.startsWith("seller:")) {
    // Approved GPU / endpoint sellers. Their key is decrypted only here, in memory.
    const s = sellers.get(row.provider.slice(7));
    return s && row.base_url ? { baseUrl: row.base_url, apiKey: s.apiKey ?? "", payTo: s.wallet } : null;
  }
  switch (row.provider) {
    case "together": {
      const apiKey = process.env.TOGETHER_API_KEY;
      return apiKey ? { baseUrl: row.base_url || "https://api.together.xyz/v1", apiKey } : null;
    }
    // Closed-model labs. Anthropic is called natively (see lib/anthropic.ts); OpenAI speaks
    // chat-completions directly.
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      return apiKey ? { baseUrl: "anthropic://messages", apiKey } : null;
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      return apiKey ? { baseUrl: row.base_url || "https://api.openai.com/v1", apiKey } : null;
    }
    case "runpod": {
      // RunPod serverless vLLM: https://api.runpod.ai/v2/<endpoint_id>/openai/v1 (one endpoint per model)
      const apiKey = process.env.RUNPOD_API_KEY;
      return apiKey && row.base_url ? { baseUrl: row.base_url, apiKey } : null;
    }
    case "mock":
    case "mock-down":
      return mockEnabled() ? { baseUrl: `mock://${row.provider}`, apiKey: "" } : null;
    default:
      return null;
  }
}

// ── Uptime: a provider that just failed sits out briefly (per server instance) ──
const COOLDOWN_MS = 60_000;
const lastFailure = new Map<string, number>();
export function markFailed(provider: string) {
  lastFailure.set(provider, Date.now());
}
function coolingDown(provider: string) {
  const t = lastFailure.get(provider);
  return t !== undefined && Date.now() - t < COOLDOWN_MS;
}

/** House settings from credit_config (selling spare capacity, the credit-money discount). Cached briefly. */
let houseCfg: { at: number; v: { market: boolean; discountBps: number; promiseShare: number } } | null = null;
async function houseSettings() {
  if (houseCfg && Date.now() - houseCfg.at < 30_000) return houseCfg.v;
  const { data } = await supabaseAdmin().from("credit_config").select("house_market, house_credit_discount_bps, promise_share").eq("id", 1).maybeSingle();
  const v = { market: data?.house_market !== false, discountBps: Number(data?.house_credit_discount_bps ?? 1000), promiseShare: Number(data?.promise_share ?? 0.35) };
  houseCfg = { at: Date.now(), v };
  return v;
}

/**
 * Can Fuel's GPU take an open-market job right now? Only while the tokens it served to the
 * market in the last hour stay under the share not promised to credits (1 − promise_share of
 * what it can do in an hour), and only if its locked throughput is known.
 */
async function houseHasSpare(provider: string, promiseShare: number) {
  const hit = spareCache.get(provider);
  if (hit && Date.now() - hit.at < 30_000) return hit.ok;
  const db = supabaseAdmin();
  const { data: s } = await db.from("sellers").select("locked_tps, locked_until").eq("id", provider.slice(7)).maybeSingle();
  let ok = false;
  if (s?.locked_tps && (!s.locked_until || Date.parse(s.locked_until) > Date.now())) {
    const { data: jobs } = await db
      .from("jobs")
      .select("input_tokens, output_tokens")
      .eq("provider", provider)
      .eq("credit_funded", false)
      .gte("created_at", new Date(Date.now() - 3_600_000).toISOString())
      .limit(50_000);
    const used = (jobs ?? []).reduce((t, j) => t + Number(j.input_tokens ?? 0) + Number(j.output_tokens ?? 0), 0);
    ok = used < (1 - promiseShare) * Number(s.locked_tps) * 3600;
  }
  spareCache.set(provider, { at: Date.now(), ok });
  return ok;
}

/**
 * Providers that can run this model, cheapest first; ones that just failed go last (still a
 * backup).
 *
 * Fuel's own GPUs ("house" routes):
 *  - Credit-funded jobs: house goes first, priced at the market rate minus the credit discount.
 *  - Open-market jobs: house may take them with its spare capacity (beyond what's promised to
 *    credits), priced at exactly the cheapest other route's price, and only for models someone
 *    else also sells, so it never sets or undercuts a price. On a price tie, independent sellers
 *    win, then house, then hosted providers: Fuel never takes a job a seller would have won.
 */
export async function routesFor(model: string, kind: Kind, opts: { creditFunded?: boolean } = {}): Promise<Route[]> {
  const { data, error } = await supabaseAdmin()
    .from("provider_models")
    .select("model, kind, provider, provider_model_id, base_url, input_per_mtok, output_per_mtok, context_length")
    .eq("model", model)
    .eq("kind", kind)
    .eq("enabled", true);
  if (error) throw error;
  let sellers = await approvedSellers();
  // A seller route we don't know yet means a fresh approval: reload instead of waiting for the cache.
  if ((data ?? []).some((r) => r.provider.startsWith("seller:") && !sellers.has(r.provider.slice(7)))) sellers = await approvedSellers(true);
  const house = await fuelOperatedProviders();
  const cfg = await houseSettings();
  type R = Route & { cost: number; cooling: boolean; tier: number };
  const all: R[] = [];
  for (const row of (data ?? []) as Row[]) {
    const conn = connection(row, sellers);
    if (!conn) continue;
    const inPerM = Number(row.input_per_mtok);
    const outPerM = Number(row.output_per_mtok);
    const isHouse = house.has(row.provider);
    all.push({
      provider: row.provider,
      providerModelId: row.provider_model_id,
      ...conn,
      inPerM,
      outPerM,
      // Typical job shape (3:1 input:output) to rank providers on price.
      cost: inPerM * 3 + outPerM,
      cooling: coolingDown(row.provider),
      // tie-break: independent sellers (0), Fuel's GPU (1), hosted providers (2)
      tier: isHouse ? 1 : row.provider.startsWith("seller:") ? 0 : 2,
      house: isHouse,
      context: row.context_length,
    });
  }
  const others = all.filter((r) => !r.house);
  const market = others.length ? others.reduce((a, b) => (b.cost < a.cost ? b : a)) : null;
  const routes: R[] = [];
  for (const r of all) {
    if (!r.house) {
      routes.push(r);
      continue;
    }
    if (opts.creditFunded) {
      // Market rate when there is one (else its own listed price), minus the credit discount.
      const base = market ?? r;
      routes.push({ ...r, inPerM: base.inPerM, outPerM: base.outPerM, cost: base.cost, discountBps: cfg.discountBps });
    } else if (cfg.market && market && (await houseHasSpare(r.provider, cfg.promiseShare))) {
      routes.push({ ...r, inPerM: market.inPerM, outPerM: market.outPerM, cost: market.cost });
    }
  }
  routes.sort((a, b) =>
    Number(a.cooling) - Number(b.cooling) ||
    (opts.creditFunded ? Number(!!b.house) - Number(!!a.house) : 0) ||
    a.cost - b.cost ||
    a.tier - b.tier,
  );
  return routes.map((r) => ({
    provider: r.provider,
    providerModelId: r.providerModelId,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    inPerM: r.inPerM,
    outPerM: r.outPerM,
    payTo: r.payTo,
    house: r.house,
    discountBps: r.discountBps,
    context: r.context,
  }));
}

/** The public catalogue: every model that at least one configured provider can serve, at Fuel's price. */
export async function catalogue() {
  const { data, error } = await supabaseAdmin()
    .from("provider_models")
    .select("model, kind, provider, provider_model_id, base_url, input_per_mtok, output_per_mtok, context_length")
    .in("kind", ["chat", "embedding"])
    .eq("enabled", true);
  if (error) throw error;
  let sellers = await approvedSellers();
  if ((data ?? []).some((r) => r.provider.startsWith("seller:") && !sellers.has(r.provider.slice(7)))) sellers = await approvedSellers(true);
  const house = await fuelOperatedProviders();
  const byModel = new Map<string, { kind: Kind; inPerM: number; outPerM: number; providers: number; context: number | null }>();
  for (const row of (data ?? []) as Row[]) {
    if (house.has(row.provider)) continue; // credit-only capacity isn't part of the public market
    if (!connection(row, sellers)) continue;
    const cur = byModel.get(row.model);
    const inPerM = Number(row.input_per_mtok);
    const outPerM = Number(row.output_per_mtok);
    if (!cur || inPerM * 3 + outPerM < cur.inPerM * 3 + cur.outPerM) {
      byModel.set(row.model, { kind: row.kind, inPerM, outPerM, providers: (cur?.providers ?? 0) + 1, context: row.context_length });
    } else {
      cur.providers += 1;
    }
  }
  return byModel;
}

/** Sends an OpenAI-compatible request to one provider. */
export async function callProvider(
  route: Route,
  path: "/chat/completions" | "/embeddings",
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const payload: Record<string, unknown> = { ...body, model: route.providerModelId };
  if (route.baseUrl.startsWith("mock://")) return mockResponse(route.provider, path, payload);
  if (route.provider === "anthropic") {
    if (path !== "/chat/completions") return Response.json({ error: { message: "Claude has no embeddings API" } }, { status: 404 });
    return callAnthropic(route.apiKey, route.providerModelId, payload, signal);
  }
  if (route.provider === "openai" && payload.max_tokens !== undefined && payload.max_completion_tokens === undefined) {
    // Current OpenAI models take max_completion_tokens (reasoning models reject max_tokens).
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  // Seller endpoints are re-checked against private addresses before every call (DNS can change).
  if (route.provider.startsWith("seller:")) await assertPublicEndpoint(route.baseUrl);
  return fetch(route.baseUrl + path, {
    method: "POST",
    redirect: route.provider.startsWith("seller:") ? "error" : "follow",
    headers: { "content-type": "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) },
    body: JSON.stringify(payload),
    signal,
    cache: "no-store",
  });
}

// ── Test-only providers (FUEL_ENABLE_MOCK=1): "mock" works, "mock-down" always fails ──
function mockResponse(provider: string, path: string, body: Record<string, unknown>): Response {
  if (provider === "mock-down") return Response.json({ error: { message: "mock provider down" } }, { status: 503 });
  const created = Math.floor(Date.now() / 1000);
  if (path === "/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({
      object: "list",
      model: body.model,
      data: inputs.map((_, index) => ({ object: "embedding", index, embedding: [0.1, 0.2, 0.3, 0.4] })),
      usage: { prompt_tokens: 8 * inputs.length, total_tokens: 8 * inputs.length },
    });
  }
  const text = "Mock reply from Fuel's test provider.";
  const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };
  if (body.stream) {
    const enc = new TextEncoder();
    const chunks = [
      ...text.split(" ").map((w, i) => ({ id: "mock", object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { content: (i ? " " : "") + w }, finish_reason: null }] })),
      { id: "mock", object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "mock", object: "chat.completion.chunk", created, model: body.model, choices: [], usage },
    ];
    const stream = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json({
    id: "mock",
    object: "chat.completion",
    created,
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage,
  });
}
