import { connection } from "next/server";
import { computeIndex } from "@/lib/compute-index";

/**
 * Fuel Compute Index. ?days=1..365 (default 30). Returns the latest level, the reference
 * price (median USD per 1M tokens), 24h/7d/30d change and a down-sampled series.
 */
export async function GET(req: Request) {
  await connection();
  const d = Number(new URL(req.url).searchParams.get("days") ?? 30);
  const days = Number.isFinite(d) ? Math.min(365, Math.max(1, Math.round(d))) : 30;
  return Response.json(await computeIndex(days), { headers: { "cache-control": "public, max-age=60" } });
}
