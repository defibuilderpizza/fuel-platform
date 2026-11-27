// OpenAPI 3.1 description of Fuel's agent-facing API, for tools, SDK generators and directories.
export function GET() {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud";
  const json = (schema: object) => ({ "application/json": { schema } });
  const ok = (description: string, schema: object = { type: "object" }) => ({ "200": { description, content: json(schema) } });
  const err = { $ref: "#/components/responses/Error" };
  const body = (schema: object) => ({ required: true, content: json(schema) });
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Fuel API",
      version: "1.0.0",
      description:
        "Compute market for AI agents. OpenAI-compatible chat and embeddings, paid from the agent's own wallet balance (USDC or SOL on Solana, USDG on Robinhood Chain). Sign in with the wallet to get a Bearer key. Errors: 402 top up or raise a limit; 403 account suspended, wallet refused by sanctions screening, or a Claude/GPT model not available in your region; 429 rate limited (per wallet, see Retry-After).",
      termsOfService: `${site}/terms`,
      "x-guidance":
        "Fuel sells AI compute to agents. Without an API key, call any paid POST route and pay per request with x402: the first call returns 402 with a PAYMENT-REQUIRED header offering USDC on Solana or USDG on Robinhood Chain (eip155:4663); resend the same request with PAYMENT-SIGNATURE. The price is the job's ceiling (at least $0.01) and whatever the job doesn't use stays in the paying wallet's Fuel balance. Chat: POST /v1/chat/completions with { model, messages } (OpenAI shape; GET /v1/models lists models and prices). Embeddings: POST /v1/embeddings { model, input }. Pictures: POST /v1/images/generations { model, prompt }. Video and 3D are async: POST, then poll GET /v1/videos/{id} or /v1/3d/{id}. Voice: POST /v1/audio/speech { model, input, voice } and multipart POST /v1/audio/transcriptions. Regular users sign in with their wallet (POST /v1/auth/nonce, then /v1/auth/keys) and send a Bearer key instead.",
    },
    servers: [{ url: `${site}/v1` }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "fuel_sk_… key from POST /auth/keys" } },
      responses: {
        Error: {
          description: "OpenAI-shaped error",
          content: json({ type: "object", properties: { error: { type: "object", properties: { message: { type: "string" }, type: { type: "string" }, code: { type: "string" } } } } }),
        },
      },
      schemas: {
        Message: { type: "object", required: ["role", "content"], properties: { role: { type: "string", enum: ["system", "user", "assistant", "tool"] }, content: {} } },
        Receipt: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            provider: { type: "string" },
            price_usd: { type: "number" },
            input_tokens: { type: "integer" },
            output_tokens: { type: "integer" },
            latency_ms: { type: "integer" },
            attempts: { type: "integer" },
          },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      "/auth/nonce": {
        post: {
          summary: "Get a message for the wallet to sign",
          security: [],
          requestBody: body({ type: "object", required: ["wallet"], properties: { wallet: { type: "string" } } }),
          responses: { ...ok("Nonce and message"), "400": err, "403": err, "429": err },
        },
      },
      "/auth/keys": {
        post: {
          summary: "Exchange the wallet's signature for an API key",
          security: [],
          requestBody: body({
            type: "object",
            required: ["wallet", "nonce", "signature"],
            properties: { wallet: { type: "string" }, nonce: { type: "string" }, signature: { type: "string", description: "base58 or base64 ed25519 signature of the message" }, label: { type: "string" } },
          }),
          responses: { "201": { description: "API key", content: json({ type: "object", properties: { api_key: { type: "string" } } }) }, "401": err, "403": err },
        },
      },
      "/chat/completions": {
        post: {
          summary: "Chat completion (OpenAI-compatible, streaming supported)",
          requestBody: body({
            type: "object",
            required: ["model", "messages"],
            properties: { model: { type: "string" }, messages: { type: "array", items: { $ref: "#/components/schemas/Message" } }, max_tokens: { type: "integer" }, stream: { type: "boolean" } },
          }),
          responses: { ...ok("OpenAI chat completion plus a `fuel` receipt", { type: "object", properties: { fuel: { $ref: "#/components/schemas/Receipt" } } }), "402": err, "403": err, "404": err, "429": err },
        },
      },
      "/messages": {
        post: {
          summary: "Anthropic Messages format (Claude SDK compatible): any Fuel model, streaming and tools",
          requestBody: body({ type: "object", required: ["model", "messages", "max_tokens"], properties: { model: { type: "string" }, messages: { type: "array" }, max_tokens: { type: "integer" }, system: {}, stream: { type: "boolean" }, tools: { type: "array" } } }),
          responses: { ...ok("Anthropic message (plus a `fuel` receipt)"), "401": err, "402": err, "403": err, "429": err },
        },
      },
      "/embeddings": {
        post: {
          summary: "Embeddings (OpenAI-compatible)",
          requestBody: body({ type: "object", required: ["model", "input"], properties: { model: { type: "string" }, input: {} } }),
          responses: { ...ok("OpenAI embeddings plus a `fuel` receipt"), "402": err, "429": err },
        },
      },
      "/images/generations": {
        post: {
          summary: "Pictures (OpenAI shape), priced per picture; temporary URLs (about an hour)",
          requestBody: body({ type: "object", required: ["model", "prompt"], properties: { model: { type: "string" }, prompt: { type: "string", maxLength: 2000 }, n: { type: "integer", minimum: 1, maximum: 4 }, size: { type: "string", enum: ["1024x1024", "768x1344", "1344x768"] } } }),
          responses: { ...ok("data[].url plus a `fuel` receipt"), "400": err, "402": err, "403": err, "404": err },
        },
      },
      "/videos": {
        post: {
          summary: "Start a short video clip; poll /videos/{id}. Priced per clip, charged when ready",
          requestBody: body({ type: "object", required: ["model", "prompt"], properties: { model: { type: "string" }, prompt: { type: "string", maxLength: 2000 } } }),
          responses: { "202": { description: "Started: id, poll url, held_usd" }, "400": err, "402": err, "404": err },
        },
      },
      "/videos/{id}": { get: { summary: "Clip status: in_progress (stage), completed (url, receipt) or failed", security: [], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok("Status") } },
      "/3d": {
        post: {
          summary: "Start a 3D model (GLB) from a prompt; poll /3d/{id}. Priced per model",
          requestBody: body({ type: "object", required: ["model", "prompt"], properties: { model: { type: "string" }, prompt: { type: "string", maxLength: 2000 } } }),
          responses: { "202": { description: "Started: id, poll url, preview_url" }, "400": err, "402": err, "404": err },
        },
      },
      "/3d/{id}": { get: { summary: "3D job status: completed has a temporary GLB url and the receipt", security: [], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: ok("Status") } },
      "/audio/speech": {
        post: {
          summary: "Text to speech (OpenAI shape), priced per 1,000 characters. Returns audio, or JSON with response_format url",
          requestBody: body({ type: "object", required: ["model", "input"], properties: { model: { type: "string" }, input: { type: "string", maxLength: 5000 }, voice: { type: "string" }, response_format: { type: "string", enum: ["url"] } } }),
          responses: { ...ok("Audio bytes (x-fuel-receipt header) or { url, fuel }"), "400": err, "402": err },
        },
      },
      "/audio/transcriptions": {
        post: {
          summary: "Speech to text (OpenAI shape, multipart file up to 4 MB). Charged per minute of audio",
          requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, model: { type: "string", default: "openai/whisper" } } } } } },
          responses: { ...ok("{ text, fuel }"), "400": err, "402": err, "413": err },
        },
      },
      "/classifications": {
        post: {
          summary: "Zero-shot classification on the laptop lane (texts + labels embedded by two cross-checking laptops; labels ranked by similarity)",
          requestBody: body({
            type: "object",
            required: ["input", "labels"],
            properties: { input: {}, labels: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 20 }, hypothesis_template: { type: "string", description: "Sentence per label, default 'This text is about {}.'" }, model: { type: "string", enum: ["fuel-lane/bge-small-en-v1.5"] } },
          }),
          responses: { ...ok("Best label and ranked scores per text, plus a `fuel` receipt"), "400": err, "402": err, "429": err, "503": err },
        },
      },
      "/models": { get: { summary: "Models with Fuel's price per 1M tokens", security: [], responses: ok("Model list") } },
      "/market": { get: { summary: "Market rates: what agents pay and the price sellers must beat", security: [], responses: ok("Rates") } },
      "/index": { get: { summary: "Fuel Compute Index", security: [], parameters: [{ name: "days", in: "query", schema: { type: "integer" } }], responses: ok("Index") } },
      "/account": {
        get: { summary: "Balance, limits, deposit address", responses: ok("Account") },
        patch: {
          summary: "Set spending limits",
          requestBody: body({ type: "object", properties: { daily_usd: { type: ["number", "null"] }, per_job_usd: { type: ["number", "null"] } } }),
          responses: ok("Updated"),
        },
      },
      "/account/budget": {
        post: {
          summary: "Set spending limits in plain words, e.g. \"at most $5 a day, no job over 10 cents\", \"remove the daily limit\", \"pause spending\". Limits are per UTC day and per job; dry_run only shows what Fuel understood",
          requestBody: body({ type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 300 }, dry_run: { type: "boolean" } } }),
          responses: ok("What Fuel understood, and the limits after the change"),
        },
      },
      "/topups/usdg": {
        get: { summary: "USDG on Robinhood Chain: chain id, USDG contract, Fuel's deposit address", security: [], responses: ok("Deposit details") },
        post: { summary: "Confirm a USDG top-up by transaction hash; the sending EVM wallet is credited 1:1", security: [], requestBody: body({ type: "object", required: ["tx_hash"], properties: { tx_hash: { type: "string" } } }), responses: { ...ok("Credited"), "409": err } },
      },
      "/topups": {
        post: {
          summary: "Confirm a USDC/SOL deposit by transaction signature",
          security: [],
          requestBody: body({ type: "object", required: ["signature"], properties: { signature: { type: "string" } } }),
          responses: ok("Credited"),
        },
      },
      "/faucet/claim": { post: { summary: "Claim the free trial credits (any wallet, once)", responses: { ...ok("Claimed"), "409": err } } },
      "/jobs": { get: { summary: "Your receipts (never job content)", responses: ok("Receipts") } },
      "/credits": { get: { summary: "Compute credits: each tier's price per credit and status; with a key, your credits", responses: ok("Credits") } },
      "/credits/tiers": { get: { summary: "Credit tiers (max, pro, open, lane): price per credit and tokens one credit buys on each model (at least 1M at 3:1 input:output)", security: [], responses: ok("Tiers") } },
      "/credits/buy": {
        post: {
          summary: "Buy credits of a tier from your balance (opens after the Fuel token launch); jobs on the tier's models then use them automatically (header x-fuel-credits: off to pay from balance instead)",
          requestBody: body({ type: "object", required: ["tier", "credits"], properties: { tier: { type: "string", enum: ["max", "pro", "open", "lane"] }, credits: { type: "number", minimum: 0.01 } } }),
          responses: { "201": { description: "Bought (with tokens per model)", content: json({ type: "object" }) }, "400": err, "402": err, "409": err },
        },
      },
      "/credits/convert": {
        post: {
          summary: "Convert credits into a cheaper tier's credits of the same month, at the price ratio minus a fee",
          requestBody: body({ type: "object", required: ["series", "to_tier", "credits"], properties: { series: { type: "string", example: "2026-12-max" }, to_tier: { type: "string", enum: ["max", "pro", "open", "lane"] }, credits: { type: "number" } } }),
          responses: { ...ok("Converted"), "400": err, "409": err },
        },
      },
      "/credits/market": { get: { summary: "Credit market: each series (month × tier) with value, bid/ask, last price", security: [], responses: ok("Market") } },
      "/credits/market/{series}": { get: { summary: "Order book and recent trades of a series, e.g. 2026-12-pro", security: [], parameters: [{ name: "series", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok("Book"), "404": err } } },
      "/credits/orders": {
        get: { summary: "Your credit orders and trades", responses: ok("Orders") },
        post: {
          summary: "Limit order: trades at once against matching orders at their price; the rest waits on the book",
          requestBody: body({ type: "object", required: ["series", "side", "price_usd", "credits"], properties: { series: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] }, price_usd: { type: "number" }, credits: { type: "number" } } }),
          responses: { "201": { description: "Placed", content: json({ type: "object" }) }, "400": err, "402": err, "409": err },
        },
      },
      "/credits/orders/{id}": { delete: { summary: "Cancel an open order", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok("Cancelled"), "404": err, "409": err } } },
      "/credits/rules": {
        get: { summary: "Your standing credit rules and what each last did", responses: ok("Rules") },
        post: {
          summary: "Add a rule Fuel runs every 5 minutes: keep_min (auto-buy up to a target at a max price) or sell_before_expiry (list at a min price N days before expiry)",
          requestBody: body({
            type: "object",
            required: ["kind", "tier"],
            properties: {
              kind: { type: "string", enum: ["keep_min", "sell_before_expiry"] },
              tier: { type: "string", enum: ["max", "pro", "open", "lane"] },
              min_credits: { type: "number" },
              target_credits: { type: "number" },
              max_price_usd: { type: "number" },
              days_before: { type: "integer" },
              min_price_usd: { type: "number" },
            },
          }),
          responses: { "201": { description: "Added", content: json({ type: "object" }) }, "400": err, "409": err },
        },
      },
      "/credits/rules/{id}": { delete: { summary: "Delete a rule", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok("Deleted"), "404": err } } },
      "/payouts": {
        get: { summary: "Earnings (seller and laptop-lane income): what you can withdraw, the minimum, payout history", responses: ok("Payouts") },
        post: {
          summary: "Request a USDC payout of earnings to your wallet (deposits can't be withdrawn); paid after review",
          requestBody: body({ type: "object", required: ["amount_usd"], properties: { amount_usd: { type: "number" } } }),
          responses: { "201": { description: "Requested", content: json({ type: "object" }) }, "400": err, "403": err, "409": err },
        },
      },
      "/payouts/{id}/cancel": {
        post: { summary: "Cancel your payout before it's approved (refunds the balance)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok("Cancelled"), "404": err, "409": err } },
      },
      "/credits/tokens": { get: { summary: "Credit tokens (SPL, one mint per series: month × tier): on/off, network, mints; with a key, your bridge history", security: [], responses: ok("Token info") } },
      "/credits/tokens/withdraw": {
        post: { summary: "Withdraw credits of a series to your wallet as SPL tokens (deposit them back before expiry)", requestBody: body({ type: "object", required: ["series", "credits"], properties: { series: { type: "string" }, credits: { type: "number" } } }), responses: { "201": { description: "Minted", content: json({ type: "object" }) }, "400": err, "503": err } },
      },
      "/credits/tokens/deposit-tx": {
        post: { summary: "Unsigned transaction burning your credit tokens (sign and send it, then call /credits/tokens/deposit)", requestBody: body({ type: "object", required: ["series", "credits"], properties: { series: { type: "string" }, credits: { type: "number" } } }), responses: { ...ok("Base64 transaction"), "400": err } },
      },
      "/credits/tokens/deposit": {
        post: { summary: "Credit a burn of credit tokens back to the burning wallet", security: [], requestBody: body({ type: "object", required: ["series", "signature"], properties: { series: { type: "string" }, signature: { type: "string" } } }), responses: { "201": { description: "Credited", content: json({ type: "object" }) }, "400": err, "404": err, "409": err } },
      },
      "/status": { get: { summary: "System status", security: [], responses: ok("Status") } },
    },
  };
  // x402 discovery (x402scan and similar): mark the pay-per-request routes. Prices depend on the
  // model and request size, so they're a range; the runtime 402 states the exact amount.
  const PAID: Record<string, string> = {
    "/chat/completions": "5",
    "/embeddings": "1",
    "/images/generations": "2",
    "/videos": "5",
    "/3d": "2",
    "/audio/speech": "2",
    "/audio/transcriptions": "2",
  };
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  for (const [path, max] of Object.entries(PAID)) {
    const op = paths[path]?.post;
    if (!op) continue;
    op["x-payment-info"] = { price: { mode: "dynamic", currency: "USD", min: "0.01", max }, protocols: [{ x402: {} }] };
    op.responses = { ...(op.responses as object), "402": { description: "Payment Required (x402: USDC on Solana or USDG on Robinhood Chain)" } };
    op.security = [{ bearer: [] }, {}];
  }

  // Full paths (/v1/…) on the site's origin: discovery tools match routes to schemas by the URL path.
  (spec as { servers: { url: string }[] }).servers = [{ url: site }];
  (spec as { paths: object }).paths = Object.fromEntries(Object.entries(spec.paths).map(([k, v]) => [`/v1${k}`, v]));

  return Response.json(spec, { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}
