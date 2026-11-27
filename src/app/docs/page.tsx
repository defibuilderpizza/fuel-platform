import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow } from "@/components/ui";
import { Architecture } from "@/components/art/diagrams";

export const metadata: Metadata = {
  title: "Docs",
  description: "Fuel API reference for agents, teams running agents, and compute sellers.",
};

const BASE = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud") + "/v1";

type Ep = [method: string, path: string, auth: "key" | "none" | "agent key" | "cron", what: string];

const sections: { id: string; title: string; intro: string; eps: Ep[]; example?: string }[] = [
  {
    id: "auth",
    title: "Sign in with a wallet",
    intro: "Your wallet is your account: a Solana wallet, or an EVM wallet for Robinhood Chain (sign with personal_sign). Sign a one-time message to get an API key, then send it as a Bearer token. Fuel stores only a hash of the key.",
    eps: [
      ["POST", "/auth/nonce", "none", "Get a message to sign. Body: { wallet }"],
      ["POST", "/auth/keys", "none", "Exchange the signature for an API key. Body: { wallet, nonce, signature, label? }"],
      ["GET", "/auth/keys", "key", "List your keys (never the keys themselves)"],
      ["DELETE", "/auth/keys/:id", "key", "Revoke a key"],
    ],
  },
  {
    id: "compute",
    title: "Compute (OpenAI-compatible)",
    intro: "Point any OpenAI SDK at the base URL. Fuel routes each job to the cheapest healthy provider and fails over automatically. Every response carries a `fuel` receipt.",
    eps: [
      ["POST", "/chat/completions", "key", "Chat, streaming supported. If you don't set max_tokens, Fuel sets 4096"],
      ["POST", "/messages", "key", "Anthropic Messages format (for tools built on the Claude SDK): any Fuel model, streaming and tools. Key as x-api-key or Bearer"],
      ["POST", "/embeddings", "key", "Embeddings. Use fuel-lane/bge-small-en-v1.5 for the laptop lane (laptops see the text)"],
      ["POST", "/classifications", "key", "Zero-shot classification on the laptop lane. Body: { input, labels: [2–20], hypothesis_template? }. Returns the best label and ranked scores per text"],
      ["POST", "/images/generations", "key", "Pictures (OpenAI shape). Body: { model, prompt, n?: 1-4, size?: 1024x1024 | 768x1344 | 1344x768 }. Priced per picture; links expire within an hour"],
      ["POST", "/videos", "key", "Start a short video clip. Body: { model, prompt }. Returns 202 and an id; priced per clip, charged when it's ready"],
      ["GET", "/videos/:id", "none", "A clip's status (in_progress with stage queued or running, completed with a temporary url and receipt, or failed)"],
      ["POST", "/3d", "key", "Start a 3D model (GLB) from a prompt. Body: { model, prompt }. Returns 202 and an id; poll GET /3d/:id"],
      ["GET", "/3d/:id", "none", "A 3D job's status; completed has a temporary GLB url and the receipt"],
      ["POST", "/audio/speech", "key", "Text to speech (OpenAI shape). Body: { model, input, voice?, response_format?: \"url\" }. Returns the audio (or a url). Priced per 1,000 characters"],
      ["POST", "/audio/transcriptions", "key", "Speech to text (OpenAI shape, multipart: file up to 4 MB, model). Returns { text }. Priced per minute of audio"],
      ["GET", "/models", "none", "Models with Fuel's price per 1M tokens"],
      ["GET", "/market", "none", "Market rates: what agents pay, and the price sellers have to beat"],
      ["GET", "/credits", "none", "Compute credits (open after the Fuel token launch; until then prices and tiers are live, buying, trading, converting and rules return an error): each tier's price per credit, whether Fuel is selling, fees, caps. With a key: your credits by tier and series"],
      ["GET", "/credits/tiers", "none", "Tiers (max, pro, open, lane): price per credit and exactly how many tokens 1 credit buys on each model (at least 1M at 3:1 input:output)"],
      ["POST", "/credits/buy", "key", "Buy credits of a tier from your balance. Body: { tier, credits }. Jobs on that tier's models use them automatically (header x-fuel-credits: off to pay from balance)"],
      ["POST", "/credits/convert", "key", "Convert credits into a cheaper tier, same month, at the price ratio minus a fee. Body: { series, to_tier, credits }"],
      ["GET", "/credits/market", "none", "Credit market: each series (month × tier) with value, best bid/ask, last price, premium to value"],
      ["GET", "/credits/market/:series", "none", "Order book and recent trades for a series (e.g. 2026-12-pro)"],
      ["POST", "/credits/orders", "key", "Place a limit order. Body: { series, side: buy|sell, price_usd, credits }. Matches at once; the rest waits"],
      ["GET", "/credits/orders", "key", "Your orders and trades"],
      ["GET", "/credits/rules", "key", "Your standing rules (Fuel runs them every 5 minutes) and what each last did"],
      ["POST", "/credits/rules", "key", "Add a rule. { kind: keep_min, tier, min_credits, target_credits, max_price_usd } or { kind: sell_before_expiry, tier, days_before, min_price_usd }"],
      ["DELETE", "/credits/rules/:id", "key", "Delete a rule"],
      ["DELETE", "/credits/orders/:id", "key", "Cancel an open order (held credits or money come back)"],
      ["GET", "/index", "none", "Fuel Compute Index: level (base 100), reference price, 24h/7d/30d change, history. ?days=1..365"],
      ["GET", "/status", "none", "System status: components, success rates, 24h history"],
      ["GET", "/byok", "key", "Bring your own key: your saved provider keys (masked) and which providers accept them (none until a provider is switched on)"],
      ["POST", "/byok", "key", "Save your own OpenAI/Anthropic key. Body: { provider, api_key }. The provider bills you directly"],
      ["DELETE", "/byok/:provider", "key", "Remove your own key"],
      ["GET", "/jobs", "key", "Your receipts: price, time, provider, tokens. Never content"],
      ["GET", "/jobs/:id", "key", "One receipt"],
    ],
    example: `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer fuel_sk_..." -H "Content-Type: application/json" \\
  -d '{"model":"openai/gpt-oss-120b","messages":[{"role":"user","content":"Hi"}]}'`,
  },
  {
    id: "balance",
    title: "Balance, top-ups and pay-later",
    intro: "Top up once in USDC or SOL on Solana, or USDG on Robinhood Chain; jobs draw the balance down. Deposits are spotted automatically within minutes, or confirm one straight away.",
    eps: [
      ["GET", "/account", "key", "Balance, held, spend today, limits, deposit address, credit"],
      ["PATCH", "/account", "key", "Set limits. Body: { daily_usd?, per_job_usd? } (null removes)"],
      ["POST", "/account/budget", "key", "Set limits in plain words. Body: { text, dry_run? }, e.g. \"at most $5 a day, no job over 10 cents\", \"remove the daily limit\", \"pause spending\""],
      ["GET", "/topups/usdg", "none", "How to top up with USDG on Robinhood Chain: chain id 4663, the USDG contract and Fuel's deposit address"],
      ["POST", "/topups/usdg", "none", "Confirm a USDG top-up by transaction hash. Body: { tx_hash }. The sending wallet is credited 1:1"],
      ["POST", "/topups", "none", "Confirm a public deposit. Body: { signature }. A fuel:<agent> memo credits that agent"],
      ["GET", "/topups", "key", "Your deposit history"],
      ["GET", "/topups/private", "none", "How to top up privately (Solana Privacy Rings)"],
      ["POST", "/topups/private/confirm", "key", "Confirm a private top-up. Body: { signature }"],
      ["GET", "/faucet", "key", "Your free trial credits (with a token estimate) and pay-later credit (2% of your deposits)"],
      ["POST", "/faucet/claim", "key", "Claim the free trial credits (any wallet, once)"],
      ["POST", "/trial/start", "none", "No-wallet trial for people: returns a key for free credits on cheap text models and FLUX schnell pictures. One per computer and network every 30 days"],
    ],
  },
  {
    id: "teams",
    title: "Teams",
    intro: "Run many agents from one place. Agents join a team with an invite code using their own API key; owners and admins then set their limits and fund them from their own balance.",
    eps: [
      ["POST", "/teams", "key", "Create a team. Body: { name }"],
      ["GET", "/teams", "key", "Your teams"],
      ["GET", "/teams/:id", "key", "Agents with balance, spend and limits; totals; people; receipts"],
      ["POST", "/teams/:id/invites", "key", "Create an invite. Body: { role: agent | member | admin, uses? }"],
      ["POST", "/teams/join", "agent key", "Join with a code. Body: { code, label? }. Agents use their own key"],
      ["PATCH", "/teams/:id/agents/:wallet", "key", "Set an agent's limits or label. Body: { daily_usd?, per_job_usd?, label? } or { budget: \"at most $2 a day\" }"],
      ["POST", "/teams/:id/agents/:wallet/fund", "key", "Move money from your balance to an agent. Body: { usd }"],
      ["DELETE", "/teams/:id/members/:wallet", "key", "Remove someone, or leave"],
    ],
  },
  {
    id: "agents",
    title: "Public agents and community",
    intro: "Give an agent a public page. Its community can top it up from their wallets or a Blink; projects can link a fee wallet so token fees fuel the agent.",
    eps: [
      ["POST", "/agents", "key", "Make your agent public or edit it. Body: { name, display_name, … }"],
      ["GET", "/agents/:name", "none", "Public profile: balance, jobs, community fuel, supporters"],
      ["POST", "/agents/fee-sources/nonce", "key", "Start linking a project fee wallet (self-fuelling)"],
      ["POST", "/agents/fee-sources", "key", "Finish linking with the fee wallet's signature"],
    ],
  },
  {
    id: "sellers",
    title: "Selling compute",
    intro: "List an OpenAI-compatible GPU endpoint at your own price, or run the laptop lane in a browser tab. Earnings arrive as Fuel balance and can be withdrawn in USDC to your wallet (minimum $5, paid after review). Deposits can't be withdrawn.",
    eps: [
      ["POST", "/sellers", "key", "Apply or update. Body: { name, endpoint_url, api_key?, models: [{ model, input_per_mtok, output_per_mtok }] }"],
      ["GET", "/sellers/me", "key", "Your listing, test results, jobs served, earnings"],
      ["POST", "/sellers/me/probe", "key", "Re-test your endpoint"],
      ["GET", "/lane", "none", "Laptop lane status and price"],
      ["GET", "/lane/stats", "key", "Your laptop-lane record and earnings"],
      ["GET", "/payouts", "key", "Earnings: what you can withdraw, the minimum, payout history"],
      ["POST", "/payouts", "key", "Request a USDC payout of earnings. Body: { amount_usd }"],
      ["POST", "/payouts/:id/cancel", "key", "Cancel before it's approved (refunds the balance)"],
    ],
  },
];

import { x402Public } from "@/lib/x402";

export default function Page() {
  const x402 = x402Public();
  return (
    <main className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-8 sm:py-14 lg:grid-cols-[200px_1fr]">
      <nav className="hidden lg:block">
        <div className="sticky top-24 space-y-1 text-sm">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">On this page</p>
          {[["start", "Getting started"], ...sections.map((s) => [s.id, s.title]), ["errors", "Errors"]].map(([id, t]) => (
            <a key={id} href={`#${id}`} className="block rounded-md px-2 py-1 text-muted hover:bg-white/60 hover:text-ink">
              {t}
            </a>
          ))}
        </div>
      </nav>
      <div className="min-w-0 space-y-12">
        <section id="start" className="space-y-4">
          {x402 && (
            <p className="rounded-xl border border-line bg-card p-4 text-sm">
              <strong>No key? Pay per request with x402.</strong> Call <code className="font-mono">/chat/completions</code> or <code className="font-mono">/embeddings</code> without an
              Authorization header and you get a <code className="font-mono">402</code> with a <code className="font-mono">PAYMENT-REQUIRED</code> header (x402 v2, scheme exact, USDC on Solana{x402.usdg ? " or USDG on Robinhood Chain" : ""}).
              Resend with <code className="font-mono">PAYMENT-SIGNATURE</code>: Fuel pays the network fee, runs the job as your wallet and keeps whatever it didn&apos;t use in your wallet&apos;s Fuel
              balance. Failed jobs cost nothing.
            </p>
          )}
          <Eyebrow>Docs</Eyebrow>
          <h1 className="text-4xl font-bold tracking-tight">Fuel API</h1>
          <p className="max-w-2xl text-muted">
            Base URL <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-sm text-ink">{BASE}</code>. JSON in, JSON out. Errors use OpenAI&apos;s shape, so
            existing SDKs show them properly. Prices are USD; money is tracked to the millionth of a dollar.
          </p>
          <div className="hidden overflow-x-auto rounded-2xl border border-line bg-card p-5 sm:block">
            <div className="min-w-[620px]">
              <Architecture />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Agents", "Sign in, top up, send jobs", "#compute"],
              ["Teams", "One place for many agents", "#teams"],
              ["Sellers", "List compute, get paid", "#sellers"],
              ["Integrations", "OpenAI SDK, AI SDK, LangChain, CrewAI…", "/docs/integrations"],
              ["Starter kit", "Agent wallet + first job in one command", "/docs/integrations"],
              ["OpenAPI", "Machine-readable spec", "/openapi.json"],
              ["Source code", "The platform, to read and verify", "https://github.com/defibuilderpizza/fuel-platform"],
              ["SDK & plugins", "Open-source MCP server, SDK and plugins", "https://github.com/defibuilderpizza/fuel-integrations"],
            ].map(([t, b, h]) => (
              <a key={t} href={h} className="lift rounded-xl border border-line bg-card p-4">
                <p className="font-semibold">{t}</p>
                <p className="text-sm text-muted">{b}</p>
              </a>
            ))}
          </div>
        </section>

        {sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-24 space-y-4">
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{s.title}</h2>
            <p className="max-w-2xl text-[15px] text-muted sm:text-base">{s.intro}</p>
            <ul className="divide-y divide-line rounded-2xl border border-line bg-card sm:hidden">
              {s.eps.map(([m, p, a, w]) => (
                <li key={m + p} className="space-y-1 px-3.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded bg-white/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold">{m}</span>
                    <span className="min-w-0 break-all font-mono text-xs">/v1{p}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-faint">{a === "none" ? "public" : a === "agent key" ? "agent's key" : "API key"}</span>
                  </div>
                  <p className="text-[13px] leading-snug text-muted">{w}</p>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto rounded-2xl border border-line bg-card sm:block">
              <table className="w-full min-w-[640px] text-left text-sm">
                <tbody className="divide-y divide-line">
                  {s.eps.map(([m, p, a, w]) => (
                    <tr key={m + p}>
                      <td className="w-20 px-4 py-2.5">
                        <span className="rounded bg-white/80 px-1.5 py-0.5 font-mono text-[11px] font-semibold">{m}</span>
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs">/v1{p}</td>
                      <td className="px-2 py-2.5 text-xs text-faint">{a === "none" ? "public" : a === "agent key" ? "agent's key" : "API key"}</td>
                      <td className="px-4 py-2.5 text-muted">{w}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.example && <pre className="overflow-x-auto rounded-xl bg-[#2f2f2f] p-4 font-mono text-xs text-white/85">{s.example}</pre>}
          </section>
        ))}

        <section id="errors" className="scroll-mt-24 space-y-4">
          <h2 className="text-2xl font-bold tracking-tight">Errors</h2>
          <div className="overflow-x-auto rounded-2xl border border-line bg-card">
            <table className="w-full min-w-[560px] text-left text-sm">
              <tbody className="divide-y divide-line">
                {[
                  ["401", "invalid_api_key", "Missing, unknown or revoked key"],
                  ["402", "insufficient_balance", "Top up, or the job needs more than your balance + pay-later credit"],
                  ["402", "per_job_limit / daily_limit", "A spending limit would be exceeded"],
                  ["402", "credit_overdue", "Pay-later credit is past due: top up to unpause"],
                  ["403", "region_not_supported", "Claude/GPT aren't served in your region (open models are)"],
                  ["403", "wallet_refused", "Account suspended, or wallet refused by sanctions screening"],
                  ["429", "rate_limit_exceeded", "Too many jobs or sign-ins per minute for this wallet: wait for Retry-After"],
                  ["404", "model_not_found", "No live provider serves that model (see /v1/models)"],
                  ["502", "all_providers_failed", "Every provider failed. You weren't charged"],
                  ["503", "lane_unavailable", "Fewer than two laptops online for the laptop lane"],
                ].map(([s, c, w]) => (
                  <tr key={c}>
                    <td className="px-4 py-2.5 font-mono text-xs">{s}</td>
                    <td className="px-2 py-2.5 font-mono text-xs">{c}</td>
                    <td className="px-4 py-2.5 text-muted">{w}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted">
            Questions about pricing? See the <Link href="/market" className="text-accent underline">market</Link>.
          </p>
        </section>
      </div>
    </main>
  );
}
