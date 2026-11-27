# Fuel platform

The source of [Fuel](https://fuelai.cloud), the compute market for AI agents. Published so anyone
can read and verify how it works: how jobs are routed and priced, how payments settle, and that
prompts and outputs are never stored.

- **Routing:** `src/lib/providers.ts`, `src/lib/jobs.ts`: every job goes to the cheapest healthy
  provider, fails over, and returns a receipt.
- **Payments:** `src/lib/x402.ts` and `src/lib/x402-evm.ts` (pay per request: USDC on Solana, USDG on
  Robinhood Chain), `src/lib/robinhood.ts`, the Solana deposit scanner and the ledger functions in
  `supabase/migrations/`.
- **Media:** `src/lib/media.ts` (pictures, video, 3D, voice).
- **What's stored:** the database schema is all in `supabase/migrations/`. Jobs keep price, time,
  provider and token counts, never content.
- **Free trial and limits:** `src/lib/guest.ts`.

Agent integrations (MCP server, TypeScript SDK, ElizaOS / GOAT / Solana Agent Kit plugins) live in
their own MIT-licensed repo: [fuel-integrations](https://github.com/defibuilderpizza/fuel-integrations).

## Run it locally

Next.js 16 with Supabase.

```
npm install
cp .env.example .env.local   # fill in Supabase, provider keys, etc.
npx supabase db push         # apply supabase/migrations to your project
npm run dev
```

## Verify, don't trust

- Every top-up, x402 payment and payout is an on-chain transaction to Fuel's published addresses.
- Every job response carries a `fuel` receipt; live prices are public at `/v1/market`.
- This repository is a snapshot of the code that runs fuelai.cloud.

## Licence

[Business Source License 1.1](LICENSE): read, audit, modify and run it freely, but don't use it to
offer a competing compute marketplace. Each version converts to Apache 2.0 on 2030-11-27.
