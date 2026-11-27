import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { apiError, rateLimited } from "@/lib/http";
import { jobRateLimit } from "@/lib/limits";
import { microToUsd, tokenCostMicro, withMarkup } from "@/lib/money";
import { callProvider, markFailed, routesFor, type Kind, type Route } from "@/lib/providers";
import { byokFeeMicro, byokRoute } from "@/lib/byok";
import type { Caller } from "@/lib/auth";
import { closedModelsBlocked, isClosedProvider } from "@/lib/compliance";
import { creditPayFor, creditsUsed, reserveJob } from "@/lib/credit-tiers";
import { x402Caller, x402LinkJob, x402Probe } from "@/lib/x402";
import { GUEST_MAX_TOKENS, guestModelRefusal, isGuest } from "@/lib/guest";

// The core loop: hold money → pick the cheapest provider → fail over if it breaks →
// charge actual usage → hand back the result with a receipt.
// Job content passes through memory only. It is never logged or written anywhere.

const DEFAULT_MAX_TOKENS = 4096;
const FIRST_BYTE_TIMEOUT_MS = 30_000; // a provider this slow to start gets skipped
const TOTAL_TIMEOUT_MS = 240_000;

type Attempt = { provider: string; ok: boolean; status: number | null; ms: number };
type Usage = { input: number; output: number };

const estimateTokens = (v: unknown) => Math.ceil(JSON.stringify(v ?? "").length / 3) + 16;

function holdFor(routes: Route[], inputTokens: number, maxOutput: number) {
  // Enough to cover the most expensive provider we might fail over to.
  const worst = Math.max(...routes.map((r) => (r.byok ? byokFeeMicro() : withMarkup(tokenCostMicro(inputTokens, r.inPerM) + tokenCostMicro(maxOutput, r.outPerM)))));
  return Math.max(1, worst);
}

function priceOf(route: Route, u: Usage) {
  // Own key: the provider bills the customer directly; Fuel charges only its flat BYOK fee.
  if (route.byok) return { cost: 0, price: byokFeeMicro() };
  const cost = tokenCostMicro(u.input, route.inPerM) + tokenCostMicro(u.output, route.outPerM);
  const full = withMarkup(cost);
  // Credit money spent on Fuel's own GPU gets a discount (capacity Fuel has already paid for).
  return { cost, price: route.discountBps ? Math.ceil((full * (10_000 - route.discountBps)) / 10_000) : full };
}

async function settle(
  jobId: string,
  status: "succeeded" | "failed",
  route: Route | null,
  attempts: Attempt[],
  usage: Usage | null,
  startedAt: number,
) {
  const p = route && usage ? priceOf(route, usage) : { cost: 0, price: 0 };
  const { data, error } = await supabaseAdmin().rpc("fuel_settle", {
    p_job: jobId,
    p_status: status,
    p_provider: route?.provider ?? null,
    p_attempts: attempts,
    p_input_tokens: usage?.input ?? null,
    p_output_tokens: usage?.output ?? null,
    p_provider_cost: p.cost,
    p_price: p.price,
    p_latency_ms: Date.now() - startedAt,
  });
  if (error) console.error("fuel_settle failed", jobId, error.message); // no job content in logs
  // A seller that served the job earns its own listed price for it (Fuel keeps the markup).
  if (!error && status === "succeeded" && route?.payTo && p.cost > 0) {
    const { error: payError } = await supabaseAdmin().rpc("fuel_seller_pay", { p_wallet: route.payTo, p_micro: p.cost, p_job: jobId });
    if (payError) console.error("fuel_seller_pay failed", jobId, payError.message);
  }
  return Number(data ?? 0);
}

function receipt(jobId: string, route: Route, usage: Usage, charged: number, startedAt: number, attempts: Attempt[]) {
  return {
    job_id: jobId,
    provider: route.provider,
    price_usd: microToUsd(charged),
    input_tokens: usage.input,
    output_tokens: usage.output,
    latency_ms: Date.now() - startedAt,
    attempts: attempts.length,
    ...(route.byok ? { byok: true, note: `Billed by ${route.provider} on your own key; Fuel charged only its fee.` } : {}),
  };
}

type X402Ctx = { payment: { header: string; signature: string } | null };

/**
 * Runs one compute job. With no caller (no API key) and x402 switched on, the job's price
 * ceiling is asked for as an x402 payment; once it settles, the job runs as the paying wallet
 * and the response carries PAYMENT-RESPONSE.
 */
export async function runJob(req: Request, caller: Caller | null, kind: Kind, body: Record<string, unknown>): Promise<Response> {
  const ctx: X402Ctx = { payment: null };
  const res = await runJobCore(req, caller, kind, body, ctx);
  if (ctx.payment) {
    res.headers.set("PAYMENT-RESPONSE", ctx.payment.header);
    res.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE, x-fuel-job-id, x-fuel-price-usd");
  }
  return res;
}

async function runJobCore(req: Request, callerIn: Caller | null, kind: Kind, body: Record<string, unknown>, ctx: X402Ctx): Promise<Response> {
  let caller = callerIn;
  const model = body.model;
  const invalid =
    typeof model !== "string" || !model ? "'model' is required." : kind === "chat" && !Array.isArray(body.messages) ? "'messages' must be an array." : kind === "embedding" && body.input === undefined ? "'input' is required." : null;
  if (invalid || typeof model !== "string") {
    const probe = caller ? null : await x402Probe(req);
    return probe ?? apiError(400, "invalid_request_error", invalid ?? "'model' is required.");
  }

  // Jobs paid with compute credits (or money that came from them) may run on Fuel's own locked capacity.
  // (Pay-per-request x402 callers have no account yet: they pay from the balance their payment creates.)
  const [{ data: acct }, pay] = caller
    ? await Promise.all([
        supabaseAdmin().from("accounts").select("credit_funded_micro").eq("wallet", caller.wallet).maybeSingle(),
        creditPayFor(req, caller.wallet, model, kind),
      ])
    : [{ data: null }, null];
  const legacyFunded = Number(acct?.credit_funded_micro ?? 0) > 0;
  let creditFunded = legacyFunded || !!pay;
  const routes = await routesFor(model, kind, { creditFunded });
  // No Fuel route for "openai/…" or "anthropic/…"? Use the caller's own key if they've added one.
  if (routes.length === 0 && caller) {
    const own = await byokRoute(caller.wallet, model, kind);
    if (own) routes.push(own);
  }
  // Claude and GPT aren't served to regions their providers don't support (open models still are).
  if (routes.some((r) => isClosedProvider(r.provider)) && closedModelsBlocked(req)) {
    const open = routes.filter((r) => !isClosedProvider(r.provider));
    if (open.length === 0) return apiError(403, "permission_error", `'${model}' isn't available in your region. Open-weight models still are (GET /v1/models).`, "region_not_supported");
    routes.splice(0, routes.length, ...open);
  }
  if (routes.length === 0) {
    return apiError(404, "not_found", `Model '${model}' is not available for ${kind === "chat" ? "chat completions" : "embeddings"}. See GET /v1/models.`, "model_not_found");
  }

  if (caller && isGuest(caller.wallet)) {
    const cheapest = routes.reduce((a, r) => (r.inPerM * 3 + r.outPerM < a.inPerM * 3 + a.outPerM ? r : a), routes[0]);
    const refusal = guestModelRefusal(kind, model, cheapest);
    if (refusal) return apiError(403, "permission_error", refusal, "guest_trial");
    const asked = Number(body.max_tokens ?? body.max_completion_tokens);
    if (!(asked > 0) || asked > GUEST_MAX_TOKENS) body = { ...body, max_tokens: GUEST_MAX_TOKENS, max_completion_tokens: undefined };
  }

  const stream = kind === "chat" && body.stream === true;
  const payload: Record<string, unknown> = { ...body };
  let maxOutput = 0;
  if (kind === "chat") {
    const asked = Number(body.max_tokens ?? body.max_completion_tokens);
    maxOutput = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_MAX_TOKENS;
    if (!(Number(body.max_tokens) > 0) && !(Number(body.max_completion_tokens) > 0)) payload.max_tokens = maxOutput; // so the charge can't outrun the hold
    if (stream) payload.stream_options = { ...(body.stream_options as object), include_usage: true };
  }
  const inputEstimate = estimateTokens(kind === "chat" ? body.messages : body.input);
  // Skip routes whose context (or cheaper price tier) this request would exceed.
  const fitting = routes.filter((r) => !r.context || inputEstimate + maxOutput <= r.context);
  if (fitting.length === 0) {
    const max = Math.max(...routes.map((r) => r.context ?? 0));
    return apiError(400, "invalid_request_error", `This request (~${inputEstimate + maxOutput} tokens incl. max output) is over ${model}'s ${max}-token limit on Fuel. Shorten it or lower max_tokens.`, "context_length_exceeded");
  }
  routes.splice(0, routes.length, ...fitting);
  const hold = holdFor(routes, inputEstimate, maxOutput);

  if (!caller) {
    const paid = await x402Caller(req, hold);
    if (!paid) return apiError(401, "authentication_error", "Missing or invalid API key. Send 'Authorization: Bearer fuel_sk_...'.", "invalid_api_key");
    if (paid instanceof Response) return paid;
    caller = paid.caller;
    ctx.payment = { header: paid.paymentResponse, signature: paid.signature };
  }

  const rl = await jobRateLimit(caller.wallet);
  if (rl.limited) return rateLimited(`Rate limit: ${rl.limit} jobs per minute per account. Retry after ${rl.retryAfter}s.`, rl.retryAfter);

  const jobId = randomUUID();
  if (ctx.payment) await x402LinkJob(ctx.payment.signature, jobId);
  // Credits pay for Fuel-run routes only (not a caller's own provider key).
  const res = await reserveJob({ jobId, wallet: caller.wallet, model, kind, hold, streamed: stream, pay: routes.some((r) => r.byok) ? null : pay });
  if (res.error || res.result === null) return apiError(500, "server_error", "Could not reserve balance.");
  const reserved = res.result;
  const paidByCredits = res.credits;
  // Not enough credits after all: paid from the balance, so Fuel's credit-only GPUs are out.
  if (!paidByCredits && pay && !legacyFunded) {
    creditFunded = false;
    const open = routes.filter((r) => !r.house);
    if (reserved === "ok" && open.length === 0) {
      await settle(jobId, "failed", null, [], null, Date.now());
      return apiError(402, "insufficient_balance", `'${model}' runs only on Fuel's credit capacity right now, and you don't hold enough ${pay.tier} credits for this job.`, "not_enough_credits");
    }
    routes.splice(0, routes.length, ...open);
  }
  if (reserved !== "ok") {
    const need = microToUsd(hold).toFixed(6);
    if (reserved === "insufficient_balance")
      return apiError(402, "insufficient_balance", `This job needs up to $${need} held. Top up your balance (GET /v1/account shows the deposit address).`);
    if (reserved === "credit_overdue")
      return apiError(402, "insufficient_balance", "Your credit is overdue. Top up to repay it, then jobs run again (GET /v1/faucet shows what's owed).", "credit_overdue");
    if (reserved === "per_job_limit") return apiError(402, "spending_limit", `This job could cost up to $${need}, above your per-job limit. Lower max_tokens or raise the limit.`, "per_job_limit");
    return apiError(402, "spending_limit", "Your daily spending limit would be exceeded.", "daily_limit");
  }

  if (creditFunded) await supabaseAdmin().from("jobs").update({ credit_funded: true }).eq("id", jobId);

  const startedAt = Date.now();
  const attempts: Attempt[] = [];
  const path = kind === "chat" ? "/chat/completions" : "/embeddings";

  for (const route of routes) {
    if (req.signal.aborted) break;
    const t0 = Date.now();
    const firstByte = new AbortController();
    const timer = setTimeout(() => firstByte.abort(), FIRST_BYTE_TIMEOUT_MS);
    const signal = AbortSignal.any([req.signal, firstByte.signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)]);
    let res: Response;
    try {
      res = await callProvider(route, path, payload, signal);
    } catch {
      clearTimeout(timer);
      attempts.push({ provider: route.provider, ok: false, status: null, ms: Date.now() - t0 });
      markFailed(route.provider);
      continue;
    }
    clearTimeout(timer);

    if (!res.ok) {
      attempts.push({ provider: route.provider, ok: false, status: res.status, ms: Date.now() - t0 });
      const text = await res.text().catch(() => "");
      let message = `Provider rejected the request (${res.status}).`;
      try {
        message = JSON.parse(text)?.error?.message ?? message;
      } catch {}
      // 5xx/timeouts/rate limits = provider trouble. 401/403/404, or "model not served here" = our side. Try the next one.
      const unavailable = /non-serverless|dedicated endpoint|model.{0,40}(not (found|available|supported)|unavailable)/i.test(message);
      const retryable = res.status >= 500 || [401, 403, 404, 408, 429].includes(res.status) || unavailable;
      if (retryable) {
        markFailed(route.provider);
        continue;
      }
      // The request itself is bad (e.g. a malformed parameter): another provider would say the same.
      await settle(jobId, "failed", null, attempts, null, startedAt);
      return apiError(res.status, "invalid_request_error", message);
    }

    attempts.push({ provider: route.provider, ok: true, status: res.status, ms: Date.now() - t0 });
    if (stream && res.body) return streamThrough(res, jobId, route, attempts, inputEstimate, startedAt);

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      attempts[attempts.length - 1].ok = false;
      markFailed(route.provider);
      continue;
    }
    const u = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const usage: Usage = {
      input: Number(u?.prompt_tokens ?? inputEstimate),
      output: kind === "chat" ? Number(u?.completion_tokens ?? estimateTokens((json.choices as unknown[]) ?? "")) : 0,
    };
    const charged = await settle(jobId, "succeeded", route, attempts, usage, startedAt);
    const fuel = { ...receipt(jobId, route, usage, charged, startedAt, attempts), ...(paidByCredits ? { paid_with_credits: await creditsUsed(jobId) } : {}) };
    return Response.json({ ...json, model, fuel }, { headers: { "x-fuel-job-id": jobId, "x-fuel-price-usd": String(fuel.price_usd) } });
  }

  await settle(jobId, "failed", null, attempts, null, startedAt);
  const last = attempts[attempts.length - 1];
  if (routes.length === 1 && routes[0].byok && (last?.status === 401 || last?.status === 403)) {
    return apiError(401, "authentication_error", `Your own ${routes[0].provider} key was rejected by ${routes[0].provider}. Update it (POST /v1/byok).`, "byok_key_rejected");
  }
  return apiError(502, "provider_error", `No provider could run this job (${attempts.length} tried). You were not charged.`, "all_providers_failed");
}

/** Passes the provider's SSE stream straight to the agent, reading usage on the way to bill it. */
function streamThrough(res: Response, jobId: string, route: Route, attempts: Attempt[], inputEstimate: number, startedAt: number) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Usage | null = null;
  let outChars = 0;
  let done = false;

  const scan = (chunk: Uint8Array) => {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const ev = JSON.parse(data);
        if (ev.usage?.prompt_tokens !== undefined) usage = { input: Number(ev.usage.prompt_tokens), output: Number(ev.usage.completion_tokens ?? 0) };
        const delta = ev.choices?.[0]?.delta;
        if (delta?.content) outChars += String(delta.content).length; // counted, never kept
      } catch {}
    }
  };
  const finish = async () => {
    if (done) return;
    done = true;
    const u = usage ?? { input: inputEstimate, output: Math.ceil(outChars / 4) };
    await settle(jobId, "succeeded", route, attempts, u, startedAt);
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read();
        if (end) {
          await finish();
          controller.close();
          return;
        }
        scan(value);
        controller.enqueue(value);
      } catch (e) {
        await finish();
        controller.error(e);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
      await finish();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-fuel-job-id": jobId,
      "x-fuel-provider": route.provider,
    },
  });
}

export function receiptView(j: {
  id: string;
  model: string;
  kind: string;
  status: string;
  provider: string | null;
  attempts: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  price_micro: number | null;
  latency_ms: number | null;
  streamed: boolean;
  created_at: string;
  finished_at: string | null;
}) {
  return {
    id: j.id,
    model: j.model,
    kind: j.kind,
    status: j.status,
    provider: j.provider,
    price_usd: microToUsd(j.price_micro),
    input_tokens: j.input_tokens,
    output_tokens: j.output_tokens,
    latency_ms: j.latency_ms,
    streamed: j.streamed,
    failovers: Array.isArray(j.attempts) ? Math.max(0, j.attempts.length - 1) : 0,
    created_at: j.created_at,
    finished_at: j.finished_at,
  };
}
