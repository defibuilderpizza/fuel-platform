import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { markupBps } from "@/lib/money";
import { approvedSellers } from "@/lib/sellers";
import { LANE } from "@/lib/lane";
import { LANE_MODEL } from "@/lib/lane-crypto";

// Market rates per model, from every live provider listing (Together, RunPod, approved sellers).
// Sellers compete on the provider price: the cheapest healthy one gets the job. Agents pay that
// price plus Fuel's markup.

export type Rate = {
  model: string;
  kind: "chat" | "embedding";
  providers: number;
  sellers: number; // independent sellers among the providers
  fuel_operated: number; // routes run on GPUs Fuel itself rents or owns (labelled publicly)
  low: { in: number; out: number }; // cheapest provider price (what a seller has to beat)
  high: { in: number; out: number };
  agent_price: { in: number; out: number }; // what agents pay at the cheapest route
  to_win: { in: number; out: number }; // a suggested seller price: 5% under the current low
  context: number | null;
};

const round = (n: number) => Math.round(n * 10_000) / 10_000;
const typical = (r: { in: number; out: number }) => r.in * 3 + r.out;

export async function marketRates(): Promise<Rate[]> {
  const { data } = await supabaseAdmin()
    .from("provider_models")
    .select("model, kind, provider, input_per_mtok, output_per_mtok, context_length")
    .in("kind", ["chat", "embedding"])
    .eq("enabled", true);
  let sellers = await approvedSellers();
  // A seller route we don't know yet means a fresh approval: reload instead of waiting for the cache.
  if ((data ?? []).some((r) => r.provider.startsWith("seller:") && !sellers.has(r.provider.slice(7)))) sellers = await approvedSellers(true);
  const { data: house } = await supabaseAdmin().from("sellers").select("id").eq("operated_by_fuel", true);
  const houseIds = new Set((house ?? []).map((h) => `seller:${h.id}`));
  const houseByModel = new Map<string, number>();
  for (const r of data ?? []) if (houseIds.has(r.provider)) houseByModel.set(r.model, (houseByModel.get(r.model) ?? 0) + 1);
  const live = (data ?? []).filter((r) => {
    if (houseIds.has(r.provider)) return false; // credit-only capacity: not in public prices or the index
    if (r.provider.startsWith("seller:")) return sellers.has(r.provider.slice(7));
    if (r.provider === "together") return !!process.env.TOGETHER_API_KEY;
    if (r.provider === "runpod") return !!process.env.RUNPOD_API_KEY;
    if (r.provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
    if (r.provider === "openai") return !!process.env.OPENAI_API_KEY;
    return false; // mocks and unconfigured providers never count as market rates
  });
  const m = 1 + markupBps() / 10_000;
  const by = new Map<string, typeof live>();
  for (const r of live) by.set(r.model, [...(by.get(r.model) ?? []), r]);

  const rates: Rate[] = [...by.entries()].map(([model, rows]) => {
    const prices = rows.map((r) => ({ in: Number(r.input_per_mtok), out: Number(r.output_per_mtok) }));
    const low = prices.reduce((a, b) => (typical(b) < typical(a) ? b : a));
    const high = prices.reduce((a, b) => (typical(b) > typical(a) ? b : a));
    return {
      model,
      kind: rows[0].kind,
      providers: rows.length,
      sellers: rows.filter((r) => r.provider.startsWith("seller:")).length,
      fuel_operated: houseByModel.get(model) ?? 0,
      low: { in: round(low.in), out: round(low.out) },
      high: { in: round(high.in), out: round(high.out) },
      agent_price: { in: round(low.in * m), out: round(low.out * m) },
      to_win: { in: round(low.in * 0.95), out: round(low.out * 0.95) },
      context: rows.reduce<number | null>((c, r) => Math.max(c ?? 0, r.context_length ?? 0) || c, null),
    };
  });
  // The laptop lane sets its own fixed price; it isn't open to endpoint sellers.
  rates.push({
    model: LANE_MODEL,
    kind: "embedding",
    providers: 0,
    sellers: 0,
    fuel_operated: 0,
    low: { in: round(LANE.pricePerMTokUsd * LANE.workerShare), out: 0 },
    high: { in: round(LANE.pricePerMTokUsd * LANE.workerShare), out: 0 },
    agent_price: { in: LANE.pricePerMTokUsd, out: 0 },
    to_win: { in: 0, out: 0 },
    context: 512,
  });
  return rates.sort((a, b) => typical(a.agent_price) - typical(b.agent_price));
}
