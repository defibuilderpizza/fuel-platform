import { connection } from "next/server";
import { catalogue } from "@/lib/providers";
import { markupBps } from "@/lib/money";
import { x402Public } from "@/lib/x402";

// /llms.txt: a plain-text guide for AI agents and tools that read sites (llmstxt.org).
export async function GET() {
  await connection();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud";
  const m = 1 + markupBps() / 10_000;
  const x402 = x402Public();
  const models = [...(await catalogue().catch(() => new Map())).entries()]
    .sort((a, b) => a[1].inPerM * 3 + a[1].outPerM - (b[1].inPerM * 3 + b[1].outPerM))
    .slice(0, 12)
    .map(([id, x]) => `- ${id} (${x.kind}): $${(x.inPerM * m).toFixed(3)} in / $${(x.outPerM * m).toFixed(3)} out per 1M tokens`);
  const body = `# Fuel

> Fuel is a compute market for AI agents. An agent signs in with its own wallet (Solana, or EVM on Robinhood Chain), pays from its own balance (USDC or SOL on Solana, USDG on Robinhood Chain), and calls one OpenAI-compatible API. Every job runs on the cheapest healthy provider, with automatic failover and a receipt. No account, email or card.

## Use Fuel from an agent

- Base URL: ${site}/v1 (OpenAI-compatible: chat completions, embeddings, streaming; zero-shot classification at POST /v1/classifications).
- Media: pictures POST /v1/images/generations (per picture); video POST /v1/videos then poll GET /v1/videos/:id (per clip); 3D POST /v1/3d then poll GET /v1/3d/:id (per model, GLB); text to speech POST /v1/audio/speech (per 1,000 characters); speech to text POST /v1/audio/transcriptions (multipart, per minute). Links expire within an hour; Fuel doesn't store outputs. Some models run on their makers' servers (Ideogram, Recraft, Black Forest Labs, MiniMax, ElevenLabs): responses carry a "privacy" note. All of them accept x402. Anthropic Messages format too: POST ${site}/v1/messages (Claude SDK: baseURL ${site})
- Models: open models from many labs, plus Claude (anthropic/…) and GPT (openai/…) when enabled
- Auth: POST /v1/auth/nonce { wallet } → sign the returned message with the wallet's ed25519 key → POST /v1/auth/keys { wallet, nonce, signature } → Bearer API key
${x402 ? `- No key? Pay per request with x402 (v2, scheme exact: USDC on ${x402.network}${x402.usdg ? `, or USDG on ${x402.usdg} via EIP-3009 transferWithAuthorization` : ""}): POST /v1/chat/completions or /v1/embeddings without Authorization returns 402 with a PAYMENT-REQUIRED header; resend with PAYMENT-SIGNATURE (a transfer signed by your wallet; Fuel pays the network fee). Whatever the job doesn't use stays in your wallet's Fuel balance; failed jobs cost nothing.\n` : ""}- Balance: GET /v1/account (balance, deposit address). Top up by sending USDC or SOL from the agent's wallet to the deposit address; Fuel credits it within minutes, or POST /v1/topups { signature }. Private top-ups (amount hidden on-chain, up to $50 each): GET /v1/topups/private.
- Budget: GET /v1/account shows limits and what's left today. Set limits in plain words: POST /v1/account/budget { text: "at most $5 a day, no job over 10 cents" } (or "remove the daily limit", "pause spending"; dry_run: true to check).
- USDG on Robinhood Chain (chain 4663): sign in with an EVM wallet (personal_sign), send USDG (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) to the deposit address from GET /v1/topups/usdg, then POST /v1/topups/usdg { tx_hash } (or wait a few minutes for the scanner).
- News and updates: https://x.com/Fuelaicloud
- Platform source (Business Source License 1.1): https://github.com/defibuilderpizza/fuel-platform
- Source for the integrations (MIT): https://github.com/defibuilderpizza/fuel-integrations
- Packages (npm): @fuelcompute/sdk (TypeScript client), @fuelcompute/mcp (MCP server: npx -y @fuelcompute/mcp), @fuelcompute/plugin-elizaos, @fuelcompute/goat-plugin, @fuelcompute/solana-agent-kit-plugin.
- Teams: one owner funds many agents and sets daily and per-job limits per agent (/v1/teams).
- Compute credits (open after the Fuel token launch; until then GET endpoints show live tiers and prices, and buy/trade/convert/rules return an error): prepaid tokens in four tiers (max, pro, open, lane). 1 credit = at least 1M tokens (3:1 input:output) on any model of its tier; GET /v1/credits/tiers lists exact tokens per model. POST /v1/credits/buy { tier, credits }; jobs on the tier's models then use them automatically (header x-fuel-credits: off to pay from balance). Trade them on the order book (POST /v1/credits/orders, series like 2026-12-pro), convert down a tier (POST /v1/credits/convert), or let Fuel trade within your limits (POST /v1/credits/rules: keep_min, sell_before_expiry).
- Free trial credits: any wallet can claim once with POST /v1/faucet/claim (GET /v1/faucet shows them as tokens). People can try prompts with no wallet at ${site}/studio (one trial per computer and network).
- Every response includes a \`fuel\` receipt: provider, price_usd, tokens, latency.
- Errors use OpenAI's error shape. 402 = top up or raise a spending limit. 429 = rate limited (per wallet; wait for Retry-After). 403 = account suspended, wallet refused by sanctions screening, or the Claude/GPT model isn't available in your region (open models still are).
- Terms: ${site}/terms (agreed when the wallet signs in; includes the model providers' usage policies). Privacy: ${site}/privacy

## Starter kit

- [Node quickstart](${site}/starter/quickstart.mjs): creates a wallet, signs in, checks balance, runs a job
- [Python quickstart](${site}/starter/quickstart.py): the same in Python
- [Integrations](${site}/docs/integrations): OpenAI SDK, Vercel AI SDK, LangChain, LlamaIndex, CrewAI, OpenAI Agents SDK, Swarms, curl; plugins for ElizaOS, GOAT, Solana Agent Kit and an MCP server

## Reference

- [API docs](${site}/docs)
- [OpenAPI spec](${site}/openapi.json)
- [Models and prices](${site}/v1/models)
- [Market rates](${site}/v1/market) and [Fuel Compute Index](${site}/v1/index)
- [Compute credits](${site}/credits)
- [Status](${site}/v1/status)

## Cheapest models right now

${models.join("\n")}

## Sell compute

GPU owners list an OpenAI-compatible endpoint at their own price: ${site}/sell. Laptops can run embedding jobs in a browser tab: ${site}/lane. Agents can use the lane for embeddings (model fuel-lane/bge-small-en-v1.5) and zero-shot classification: POST /v1/classifications { input, labels }. Earnings can be withdrawn in USDC: GET/POST /v1/payouts (minimum $5, paid after review).
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
