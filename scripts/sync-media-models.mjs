// Adds or updates the pictures and video models in data/media-models.json (kind image/video,
// priced per output). Models no longer in the file are switched off.
//   node --env-file=.env.local scripts/sync-media-models.mjs [--dry]        (dev)
//   node --env-file=.env.prod.local scripts/sync-media-models.mjs [--dry]   (production)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const dry = process.argv.includes("--dry");
const file = JSON.parse(readFileSync(new URL("../data/media-models.json", import.meta.url), "utf8"));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const rows = [
  // Pictures run on Together only with third-party data sharing on (see the file's note).
  ...(file.image_enabled ? file.image.map((m) => ({ ...m, kind: "image", unit: "image" })) : []),
  ...file.video.map((m) => ({ ...m, kind: "video", unit: "clip" })),
  ...(file.mesh ?? []).map((m) => ({ ...m, kind: "mesh", unit: "model" })),
  ...(file.speech ?? []).map((m) => ({ ...m, kind: "speech", unit: "1k_chars" })),
  ...(file.transcription ?? []).map((m) => ({ ...m, kind: "transcription", unit: "minute" })),
].map((m) => ({
  model: m.model,
  kind: m.kind,
  provider: m.provider,
  provider_model_id: m.endpoint ?? m.model,
  input_per_mtok: 0,
  output_per_mtok: 0,
  unit_price_usd: m.cost,
  unit: m.unit,
  enabled: true,
}));
for (const r of rows) console.log(`  ${r.kind.padEnd(6)} ${r.model.padEnd(44)} $${r.unit_price_usd} per ${r.unit}`);
if (dry) process.exit(0);

const { error } = await db.from("provider_models").upsert(rows, { onConflict: "model,provider" });
if (error) throw error;
const keepRow = new Set(rows.map((r) => `${r.provider}|${r.model}`));
const { data: existing } = await db.from("provider_models").select("id, model, provider").in("provider", ["fal", "together"]).in("kind", ["image", "video", "mesh", "speech", "transcription"]).eq("enabled", true);
const gone = (existing ?? []).filter((r) => !keepRow.has(`${r.provider}|${r.model}`)).map((r) => r.id);
if (gone.length) await db.from("provider_models").update({ enabled: false }).in("id", gone);
console.log(`Synced ${rows.length} media models; switched off ${gone.length}.`);
