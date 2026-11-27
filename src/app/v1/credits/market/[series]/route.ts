import { connection } from "next/server";
import { apiError } from "@/lib/http";
import { seriesBook } from "@/lib/credit-market";

/** One series: order book (price levels) and recent trades. */
export async function GET(_req: Request, ctx: RouteContext<"/v1/credits/market/[series]">) {
  await connection();
  const { series } = await ctx.params;
  const b = await seriesBook(series);
  if (!b) return apiError(404, "not_found", "No such series.");
  return Response.json(b);
}
