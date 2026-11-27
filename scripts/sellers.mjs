// Review GPU / endpoint seller applications.
//   node --env-file=.env.local scripts/sellers.mjs list
//   node --env-file=.env.local scripts/sellers.mjs approve <seller-id>
//   node --env-file=.env.local scripts/sellers.mjs reject  <seller-id> "reason"
//   node --env-file=.env.local scripts/sellers.mjs pause   <seller-id> "reason"
// Approving puts the seller's models that passed their test into routing. Keys are never printed.
import { createClient } from "@supabase/supabase-js";

const [cmd = "list", id, note] = process.argv.slice(2);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function sync(sellerId) {
  const provider = `seller:${sellerId}`;
  const { data: s } = await db.from("sellers").select("status, endpoint_url").eq("id", sellerId).single();
  await db.from("provider_models").update({ enabled: false }).eq("provider", provider);
  if (s.status !== "approved") return 0;
  const { data: models } = await db.from("seller_models").select("*").eq("seller_id", sellerId).eq("probe_ok", true);
  const rows = models.map((m) => ({
    model: m.model, kind: m.kind, provider, provider_model_id: m.provider_model_id, base_url: s.endpoint_url,
    input_per_mtok: m.input_per_mtok, output_per_mtok: m.output_per_mtok, context_length: m.context_length, enabled: true, updated_at: new Date().toISOString(),
  }));
  if (rows.length) await db.from("provider_models").upsert(rows, { onConflict: "model,provider" });
  return rows.length;
}

if (cmd === "list") {
  const { data: sellers } = await db.from("sellers").select("id, wallet, name, endpoint_url, contact, status, created_at, api_key_enc").order("created_at", { ascending: false });
  for (const s of sellers ?? []) {
    const { data: models } = await db.from("seller_models").select("model, kind, input_per_mtok, output_per_mtok, probe_ok, probe_ms, probe_error").eq("seller_id", s.id);
    console.log(`\n${s.status.toUpperCase().padEnd(9)} ${s.id}  ${s.name}  (${s.wallet.slice(0, 6)}…)`);
    console.log(`          ${s.endpoint_url}  key: ${s.api_key_enc ? "yes" : "none"}  contact: ${s.contact ?? "-"}`);
    for (const m of models ?? []) console.log(`          ${m.probe_ok ? "✓" : "✗"} ${m.model} [${m.kind}] in $${m.input_per_mtok} out $${m.output_per_mtok}/M ${m.probe_ok ? `${m.probe_ms}ms` : m.probe_error ?? "not tested"}`);
  }
  if (!sellers?.length) console.log("No seller applications yet.");
} else if (["approve", "reject", "pause"].includes(cmd) && id) {
  const status = { approve: "approved", reject: "rejected", pause: "paused" }[cmd];
  const { error } = await db.from("sellers").update({ status, review_note: note ?? null, reviewed_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
  console.log(`${id} → ${status}; ${await sync(id)} model(s) now routed.`);
} else {
  console.log("usage: list | approve <id> | reject <id> \"reason\" | pause <id> \"reason\"");
}
process.exit(0);
