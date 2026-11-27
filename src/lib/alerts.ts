import "server-only";
import { x402Config } from "@/lib/x402";
import { evmX402Config } from "@/lib/x402-evm";
import { rhClient } from "@/lib/robinhood";
import { systemStatus } from "@/lib/status";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { callProvider, routesFor } from "@/lib/providers";

// Tells the operator when something is wrong, by posting to a chat webhook
// (Telegram: FUEL_ALERT_TELEGRAM_BOT_TOKEN + FUEL_ALERT_TELEGRAM_CHAT_ID; or FUEL_ALERT_WEBHOOK_URL,
// a Discord or Slack incoming-webhook URL; unset = off).
// The 5-minute cron calls this during the first 5 minutes of each hour, so a long problem
// alerts once an hour instead of flooding the channel. Two sources:
//  - /status: components degraded or down, from real customer jobs
//  - a canary: one tiny request to each hosted provider's cheapest chat model, plus one tiny fal
//    picture an hour, so an outage or an empty provider account (Anthropic, Together or fal
//    credit used up) is caught with no traffic.
//    GPU sellers aren't included: their models are re-tested every 10 minutes already.

const HOSTED = (p: string) => !p.startsWith("seller:") && !p.startsWith("mock") && p !== "fuel-lane";

/** One 1-token chat request per hosted provider. Costs a fraction of a cent per run. */
export async function providerCanary() {
  const { data } = await supabaseAdmin()
    .from("provider_models")
    .select("model, provider, input_per_mtok, output_per_mtok")
    .eq("kind", "chat")
    .eq("enabled", true);
  const cheapest = new Map<string, { model: string; cost: number }>();
  for (const r of data ?? []) {
    if (!HOSTED(r.provider)) continue;
    const cost = Number(r.input_per_mtok) + Number(r.output_per_mtok);
    const cur = cheapest.get(r.provider);
    if (!cur || cost < cur.cost) cheapest.set(r.provider, { model: r.model, cost });
  }
  const results = await Promise.all(
    [...cheapest].map(async ([provider, { model }]) => {
      const started = Date.now();
      try {
        const route = (await routesFor(model, "chat")).find((r) => r.provider === provider);
        if (!route) return { provider, model, ok: false, detail: "no route (key missing?)" };
        const res = await callProvider(route, "/chat/completions", { messages: [{ role: "user", content: "Reply with: ok" }], max_tokens: 8 }, AbortSignal.timeout(30_000));
        if (res.ok) return { provider, model, ok: true, ms: Date.now() - started };
        const text = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
        return { provider, model, ok: false, detail: `HTTP ${res.status} ${text}` };
      } catch (e) {
        return { provider, model, ok: false, detail: String((e as Error).message ?? e).slice(0, 160) };
      }
    }),
  );
  return results;
}

/**
 * fal (pictures, video, 3D, voice) has no chat model, so it gets its own check: one 256×256 FLUX
 * schnell picture with one step (about $0.0002). Catches an empty fal balance or a dead key.
 */
export async function falCanary() {
  const key = process.env.FAL_KEY?.trim();
  const model = "black-forest-labs/FLUX.1-schnell";
  if (!key) return { provider: "fal", model, ok: false, detail: "FAL_KEY missing" };
  const started = Date.now();
  try {
    const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
      method: "POST",
      headers: { authorization: `Key ${key}`, "content-type": "application/json", "X-Fal-Store-IO": "0" },
      body: JSON.stringify({ prompt: "a grey dot", image_size: { width: 256, height: 256 }, num_inference_steps: 1, num_images: 1, enable_safety_checker: false }),
      signal: AbortSignal.timeout(45_000),
    });
    if (res.ok) return { provider: "fal", model, ok: true, ms: Date.now() - started };
    const text = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
    return { provider: "fal", model, ok: false, detail: `HTTP ${res.status} ${text}` };
  } catch (e) {
    return { provider: "fal", model, ok: false, detail: String((e as Error).message ?? e).slice(0, 160) };
  }
}

export type CanaryResult = Awaited<ReturnType<typeof providerCanary>>;

/**
 * The cron calls this every run; the canary runs in the first 5 minutes of each quarter hour.
 * Results are stored for /status (best effort) and returned for the alert check.
 */
export async function scheduledCanary(now = new Date()): Promise<CanaryResult | null> {
  if (now.getUTCMinutes() % 15 >= 5) return null;
  // Chat providers every quarter hour; fal (which costs a little more per check) once an hour.
  const [chat, fal] = await Promise.all([providerCanary(), now.getUTCMinutes() < 5 ? falCanary() : Promise.resolve(null)]);
  const results: CanaryResult = fal ? [...chat, fal] : chat;
  const db = supabaseAdmin();
  await db.from("provider_checks").insert(results.map((r) => ({ provider: r.provider, model: r.model, ok: r.ok, ms: "ms" in r ? r.ms : null, detail: "detail" in r ? r.detail : null })));
  void db.from("provider_checks").delete().lt("checked_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).then(() => {});
  return results;
}

/** The x402 fee payer's SOL, when x402 is on and it's under 0.02 SOL (about 1,000 payments left). */
async function x402FeePayerLow() {
  const cfg = x402Config();
  if (!cfg) return null;
  const res = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [cfg.feePayer] }), signal: AbortSignal.timeout(10_000) });
  const lamports = Number(((await res.json()) as { result?: { value?: number } }).result?.value ?? NaN);
  return Number.isFinite(lamports) && lamports < 20_000_000 ? { address: cfg.feePayer, sol: lamports / 1e9 } : null;
}

/** The Robinhood Chain gas wallet's ETH, when USDG x402 is on and it's under 0.001 ETH (still ~hundreds of payments). */
async function rhGasLow() {
  const cfg = evmX402Config();
  if (!cfg) return null;
  const { privateKeyToAccount } = await import("viem/accounts");
  const address = privateKeyToAccount(cfg.key).address;
  const wei = await rhClient().getBalance({ address });
  return wei < 1_000_000_000_000_000n ? { address, eth: Number(wei) / 1e18 } : null;
}

export async function checkAndAlert(canary: CanaryResult | null, now = new Date()) {
  if (now.getUTCMinutes() >= 5) return { sent: false, reason: "not_this_run" };
  const url = process.env.FUEL_ALERT_WEBHOOK_URL?.trim();
  const tg = telegramTarget();
  const s = await systemStatus();
  canary ??= [];
  const bad = s.components.filter((c) => c.level === "down" || c.level === "degraded");
  const failed = canary.filter((c) => !c.ok);
  const low = await x402FeePayerLow().catch(() => null);
  const lowEth = await rhGasLow().catch(() => null);
  if (!bad.length && !failed.length && !low && !lowEth) return { sent: false, reason: "all_ok", canary };
  if (!url && !tg) return { sent: false, reason: "no_webhook", canary };
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://fuelai.cloud";
  const lines = [
    ...bad.map((c) => `• ${c.name} (${c.group}): ${c.level.toUpperCase()} — ${c.detail}`),
    ...failed.map((c) => `• Canary ${c.provider} (${c.model}) FAILED — ${c.detail}`),
    ...(low ? [`• x402 fee payer ${low.address} is low: ${low.sol} SOL. Top it up or x402 payments stop settling.`] : []),
    ...(lowEth ? [`• Robinhood Chain gas wallet ${lowEth.address} is low: ${lowEth.eth} ETH. Top it up or USDG x402 payments stop settling.`] : []),
  ];
  const text = `Fuel needs attention\n${lines.join("\n")}\n${site}/status`;
  let ok = false;
  let status = 0;
  if (tg) {
    const r = await sendTelegram(tg, text).catch(() => null);
    ok = !!r?.ok;
    status = r?.status ?? 0;
  }
  if (url) {
    // Discord reads `content`, Slack reads `text`.
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }), signal: AbortSignal.timeout(10_000) });
    ok ||= res.ok;
    status ||= res.status;
  }
  return { sent: ok, status, components: bad.map((c) => c.id), canary };
}

function telegramTarget() {
  const token = process.env.FUEL_ALERT_TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.FUEL_ALERT_TELEGRAM_CHAT_ID?.trim();
  return token && chat ? { token, chat } : null;
}

/** Sends one message to the operator's Telegram chat (a bot made with @BotFather). */
export async function sendTelegram(t: { token: string; chat: string }, text: string) {
  return fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: t.chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
}
