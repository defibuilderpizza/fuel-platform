// Launch check against production with real money (spends well under $0.01).
//   FUEL_API_KEY=fuel_sk_… node scripts/prod-check.mjs [baseUrl]
// Use the API key from your dashboard after depositing (≥ $0.05 balance). Runs real jobs:
// cheapest open chat model, streaming, Claude (OpenAI format and Anthropic Messages format),
// GPT if live; then checks every receipt, that /v1/jobs lists them, and that the balance
// dropped by exactly what the receipts say. Reads only; never prints the key.
const BASE = (process.argv[2] ?? "https://fuelai.cloud").replace(/\/$/, "");
const KEY = process.env.FUEL_API_KEY?.trim();
if (!KEY?.startsWith("fuel_sk_")) {
  console.error("Set FUEL_API_KEY to your Fuel API key (fuel_sk_…), e.g. FUEL_API_KEY=$(pbpaste) node scripts/prod-check.mjs");
  process.exit(2);
}
let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };
const H = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
const get = (p) => fetch(BASE + p, { headers: H }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (p, b, extra = {}) => fetch(BASE + p, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(b) });
const receipts = [];

const before = await get("/v1/account");
check("account readable", before.status === 200, before.body.error?.message ?? "");
if (before.status !== 200) process.exit(1);
console.log(`      wallet ${before.body.wallet.slice(0, 4)}…${before.body.wallet.slice(-4)}  balance $${before.body.balance_usd}`);
check("balance ≥ $0.05", before.body.available_usd >= 0.05, `$${before.body.available_usd}`);
if (before.body.available_usd < 0.05) process.exit(1);

const models = (await get("/v1/models")).body.data ?? [];
const chat = models.filter((m) => (m.type ?? m.kind ?? "chat") === "chat" && !m.id.startsWith("fuel-lane/"));
const price = (m) => (m.pricing?.input_per_mtok_usd ?? 0) * 3 + (m.pricing?.output_per_mtok_usd ?? 0);
const open = chat.filter((m) => !/^(anthropic|openai)\//.test(m.id) || m.id.startsWith("openai/gpt-oss")).sort((a, b) => price(a) - price(b))[0];
const claude = chat.filter((m) => m.id.startsWith("anthropic/")).sort((a, b) => price(a) - price(b))[0];
const gpt = chat.filter((m) => m.id.startsWith("openai/") && !m.id.startsWith("openai/gpt-oss")).sort((a, b) => price(a) - price(b))[0];
check("models listed", chat.length > 0, `${chat.length} chat models; open=${open?.id} claude=${claude?.id ?? "none"} gpt=${gpt?.id ?? "none"}`);

async function chatJob(label, model) {
  const r = await post("/v1/chat/completions", { model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 16 });
  const j = await r.json().catch(() => ({}));
  const ok = r.status === 200 && typeof j.choices?.[0]?.message?.content === "string" && j.fuel?.price_usd > 0;
  check(`${label}: ${model}`, ok, ok ? `$${j.fuel.price_usd} via ${j.fuel.provider}, ${j.fuel.latency_ms} ms` : `${r.status} ${j.error?.message ?? ""}`);
  if (j.fuel) receipts.push(j.fuel);
}

if (open) await chatJob("open model chat", open.id);

if (open) {
  const r = await post("/v1/chat/completions", { model: open.id, messages: [{ role: "user", content: "Count to three." }], max_tokens: 24, stream: true });
  const text = await r.text();
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
  const jobId = r.headers.get("x-fuel-job-id");
  check("streaming", r.status === 200 && chunks.length > 1 && text.includes("[DONE]"), `${chunks.length} chunks`);
  if (jobId) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const jr = await get(`/v1/jobs/${jobId}`);
    check("streamed job settled with a price", jr.body.status === "succeeded" && jr.body.price_usd > 0, `$${jr.body.price_usd}`);
    if (jr.body.price_usd) receipts.push({ job_id: jobId, price_usd: jr.body.price_usd });
  }
}

if (claude) {
  await chatJob("Claude (OpenAI format)", claude.id);
  const r = await post("/v1/messages", { model: claude.id, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ok" }] }, { "anthropic-version": "2023-06-01" });
  const j = await r.json().catch(() => ({}));
  const ok = r.status === 200 && j.type === "message" && j.fuel?.price_usd > 0;
  check(`Claude (Anthropic Messages format): ${claude.id}`, ok, ok ? `$${j.fuel.price_usd}` : `${r.status} ${j.error?.message ?? ""}`);
  if (j.fuel) receipts.push(j.fuel);
}
if (gpt) await chatJob("GPT", gpt.id);

await new Promise((ok) => setTimeout(ok, 1500));
const jobs = (await get("/v1/jobs?limit=50")).body.data ?? [];
const ids = new Set(jobs.map((j) => j.id));
check("every job is in /v1/jobs", receipts.every((r) => ids.has(r.job_id)), `${receipts.filter((r) => ids.has(r.job_id)).length}/${receipts.length}`);
check("receipts carry no content", jobs.every((j) => !("messages" in j) && !("output" in j) && !("input" in j)));

const after = await get("/v1/account");
const spent = Math.round((before.body.balance_usd - after.body.balance_usd) * 1e6);
const billed = Math.round(receipts.reduce((t, r) => t + r.price_usd, 0) * 1e6);
check("balance dropped by exactly the receipts", spent === billed && after.body.held_usd === 0, `spent $${spent / 1e6}, receipts $${billed / 1e6}, held $${after.body.held_usd}`);

console.log(failures ? `\n${failures} FAILED` : `\nall passed: production took real money and billed it correctly ($${billed / 1e6} spent)`);
process.exit(failures ? 1 : 0);
