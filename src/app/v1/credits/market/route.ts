import { connection } from "next/server";
import { marketOverview } from "@/lib/credit-market";

/** Credit market: every live series with its value, best bid/ask, last price and premium to value. */
export async function GET() {
  await connection();
  return Response.json(await marketOverview(), { headers: { "cache-control": "public, max-age=10" } });
}
