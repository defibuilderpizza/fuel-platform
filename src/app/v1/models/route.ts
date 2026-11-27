import { connection } from "next/server";
import { catalogue } from "@/lib/providers";
import { markupBps } from "@/lib/money";
import { LANE, onlineWorkers } from "@/lib/lane";
import { LANE_MODEL } from "@/lib/lane-crypto";

/** OpenAI-style model list, with Fuel's price per 1M tokens (cheapest provider + markup). */
export async function GET(req: Request) {
  await connection();
  const m = 1 + markupBps() / 10_000;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const data = [...(await catalogue()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, c]) => ({
      id,
      object: "model",
      owned_by: "fuel",
      type: c.kind,
      context_length: c.context,
      providers: c.providers,
      pricing: { input_per_mtok_usd: round(c.inPerM * m), output_per_mtok_usd: round(c.outPerM * m) },
    }));
  // The laptop lane is listed while at least two laptops are online to cross-check.
  const laptops = (await onlineWorkers()).length;
  if (laptops >= 2) {
    data.push({
      id: LANE_MODEL,
      object: "model",
      owned_by: "fuel",
      type: "embedding",
      context_length: 512,
      providers: laptops,
      pricing: { input_per_mtok_usd: LANE.pricePerMTokUsd, output_per_mtok_usd: 0 },
    });
  }
  // Opened in a browser: indent it so it's readable. Agents get compact JSON.
  if ((req.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(JSON.stringify({ object: "list", data }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  return Response.json({ object: "list", data });
}
