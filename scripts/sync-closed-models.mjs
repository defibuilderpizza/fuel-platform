// Adds Claude and GPT models to Fuel from data/closed-models.json.
//   node --env-file=.env.local scripts/sync-closed-models.mjs [--dry]
// For each provider whose key is set (ANTHROPIC_API_KEY, OPENAI_API_KEY):
//   1. lists the provider's live models; entries whose id doesn't exist are skipped (and reported)
//   2. sends each remaining model a tiny test request; failures are skipped
//   3. upserts the rest into provider_models (enabled) at the table's price
// Also prints live models that have no price in the table, so you can add them.
// Never enables a model without a price. Costs a fraction of a cent per run.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const dry = process.argv.includes("--dry");
const table = JSON.parse(readFileSync(new URL("../data/closed-models.json", import.meta.url), "utf8")).models;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const P = {
  anthropic: {
    key: process.env.ANTHROPIC_API_KEY,
    async list(key) {
      const ids = [];
      let after;
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`https://api.anthropic.com/v1/models?limit=100${after ? `&after_id=${after}` : ""}`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
        if (!r.ok) throw new Error(`Anthropic models: HTTP ${r.status}`);
        const j = await r.json();
        ids.push(...j.data.map((m) => m.id));
        if (!j.has_more) break;
        after = j.last_id;
      }
      return ids;
    },
    async probe(key, id) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: id, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      return r.ok ? null : `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`;
    },
  },
  openai: {
    key: process.env.OPENAI_API_KEY,
    async list(key) {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
      if (!r.ok) throw new Error(`OpenAI models: HTTP ${r.status}`);
      return (await r.json()).data.map((m) => m.id);
    },
    async probe(key, id) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: id, max_completion_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
      });
      return r.ok ? null : `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`;
    },
  },
};

const rows = [];
for (const [name, p] of Object.entries(P)) {
  if (!p.key) {
    console.log(`\n${name}: no key set, skipped`);
    continue;
  }
  let live;
  try {
    live = new Set(await p.list(p.key));
  } catch (e) {
    console.log(`\n${name}: ${e.message}`);
    continue;
  }
  console.log(`\n${name}: ${live.size} live models`);
  const mine = table.filter((m) => m.provider === name);
  for (const m of mine) {
    if (m.paused) {
      console.log(`  pause ${m.model} (paused in the table: kept switched off)`);
      if (!dry) await db.from("provider_models").update({ enabled: false }).eq("provider", name).eq("model", m.model);
      continue;
    }
    if (!live.has(m.provider_model_id)) {
      console.log(`  skip  ${m.provider_model_id} (not in the provider's model list: fix the id)`);
      continue;
    }
    const err = await p.probe(p.key, m.provider_model_id);
    if (err) {
      console.log(`  skip  ${m.provider_model_id} (test call failed: ${err})`);
      continue;
    }
    console.log(`  ok    ${m.model}  $${m.input} in / $${m.output} out per 1M`);
    rows.push({ model: m.model, kind: "chat", provider: name, provider_model_id: m.provider_model_id, input_per_mtok: m.input, output_per_mtok: m.output, context_length: m.context, enabled: true, updated_at: new Date().toISOString() });
  }
  const priced = new Set(mine.map((m) => m.provider_model_id));
  const unpriced = [...live].filter((id) => !priced.has(id) && !/embed|tts|whisper|dall|image|audio|realtime|moderation|transcribe|search/.test(id));
  if (unpriced.length) console.log(`  no price in the table (add to data/closed-models.json to offer): ${unpriced.slice(0, 25).join(", ")}${unpriced.length > 25 ? " …" : ""}`);
}

if (dry) {
  console.log(`\n--dry: would enable ${rows.length} models`);
} else if (rows.length) {
  const { error } = await db.from("provider_models").upsert(rows, { onConflict: "model,provider" });
  console.log(error ? `\nsave failed: ${error.message}` : `\nenabled ${rows.length} models`);
} else {
  console.log("\nnothing to enable");
}
