// Pulls Together.ai's model list and prices into provider_models.
// Run: node --env-file=.env.local scripts/sync-together.mjs [--dry]
// Each run sends every candidate model a 1-token request (costs a fraction of a cent).
// Needs TOGETHER_API_KEY. Model names are kept exactly as Together names them,
// so an agent switching from Together changes only the base URL and key.
import { createClient } from "@supabase/supabase-js";

const dry = process.argv.includes("--dry");
const key = process.env.TOGETHER_API_KEY;
if (!key) {
  console.error("TOGETHER_API_KEY is not set");
  process.exit(1);
}

const res = await fetch("https://api.together.xyz/v1/models", { headers: { authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error("Together /v1/models failed:", res.status, await res.text());
  process.exit(1);
}
const body = await res.json();
const list = Array.isArray(body) ? body : body.data ?? [];

const kindOf = (t) => (["chat", "language", "code"].includes(t) ? "chat" : t === "embedding" ? "embedding" : null);
const rows = [];
for (const m of list) {
  const kind = kindOf(m.type);
  const input = Number(m.pricing?.input);
  const output = Number(m.pricing?.output);
  // Skip non-text models, and zero-priced ones (free tiers / dedicated-only: not something we resell).
  if (!kind || !Number.isFinite(input) || !Number.isFinite(output) || input + output <= 0) continue;
  rows.push({
    model: m.id,
    kind,
    provider: "together",
    provider_model_id: m.id,
    input_per_mtok: input,
    output_per_mtok: kind === "embedding" ? 0 : output,
    context_length: Number(m.context_length) || null,
    enabled: true,
    updated_at: new Date().toISOString(),
  });
}

// Together lists dedicated-only models next to serverless (pay-per-use) ones, with no flag
// to tell them apart. Probe each with a 1-token request and keep only those that answer.
async function probe(r) {
  const path = r.kind === "embedding" ? "/embeddings" : "/chat/completions";
  const body = r.kind === "embedding" ? { model: r.model, input: "hi" } : { model: r.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://api.together.xyz/v1" + path, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (res?.ok) return true;
    if (res && res.status !== 429 && res.status < 500) return false;
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
  }
  return false;
}
const results = [];
for (let i = 0; i < rows.length; i += 6) results.push(...(await Promise.all(rows.slice(i, i + 6).map(probe))));
const dead = rows.filter((_, i) => !results[i]);
rows.splice(0, rows.length, ...rows.filter((_, i) => results[i]));
console.log(`Probed: ${rows.length} serverless models answer, ${dead.length} are dedicated-only or down (skipped).`);

console.log(`Together lists ${list.length} models; ${rows.length} priced chat/embedding models to sync.`);
for (const r of rows.slice(0, 10)) console.log(`  ${r.kind.padEnd(9)} ${r.model}  in $${r.input_per_mtok}/M  out $${r.output_per_mtok}/M`);
if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);
if (dry) process.exit(0);

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { error } = await db.from("provider_models").upsert(rows, { onConflict: "model,provider" });
if (error) {
  console.error("upsert failed:", error.message);
  process.exit(1);
}
// Models Together no longer lists get disabled, not deleted (receipts reference them).
const live = new Set(rows.map((r) => r.model));
const { data: existing } = await db.from("provider_models").select("id, model").eq("provider", "together").in("kind", ["chat", "embedding"]).eq("enabled", true); // media rows: sync-media-models.mjs
const gone = (existing ?? []).filter((r) => !live.has(r.model)).map((r) => r.id);
if (gone.length) await db.from("provider_models").update({ enabled: false }).in("id", gone);
console.log(`Synced ${rows.length}; disabled ${gone.length} no longer listed.`);
