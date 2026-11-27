import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { microToUsd } from "@/lib/money";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Every seller application with its models, test results, jobs served and earnings. Keys never included. */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  const db = supabaseAdmin();
  const { data: sellers } = await db
    .from("sellers")
    .select("id, wallet, name, endpoint_url, contact, status, review_note, created_at, reviewed_at, api_key_enc, operated_by_fuel, locked_cost_hr, locked_tps, locked_until")
    .order("created_at", { ascending: false });
  const out = [];
  for (const s of sellers ?? []) {
    const [{ data: models }, { count: jobs }, { data: paid }] = await Promise.all([
      db.from("seller_models").select("model, kind, input_per_mtok, output_per_mtok, probe_ok, probe_ms, probe_error, probed_at").eq("seller_id", s.id),
      db.from("jobs").select("id", { count: "exact", head: true }).eq("provider", `seller:${s.id}`).eq("status", "succeeded"),
      db.from("ledger_entries").select("delta_micro").eq("wallet", s.wallet).eq("source", "seller_payout"),
    ]);
    const { api_key_enc, ...rest } = s;
    out.push({
      ...rest,
      has_api_key: !!api_key_enc,
      models: models ?? [],
      jobs_served: jobs ?? 0,
      earned_usd: microToUsd((paid ?? []).reduce((t, r) => t + Number(r.delta_micro), 0)),
    });
  }
  return Response.json({ data: out });
}
