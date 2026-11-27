import { connection } from "next/server";
import { marketRates } from "@/lib/market";

/**
 * Market rates per model, USD per 1M tokens.
 * low = the cheapest provider price right now (a seller has to beat it to win jobs),
 * agent_price = what agents pay at that route (low + Fuel's markup), to_win = a suggested seller price.
 */
export async function GET() {
  await connection();
  return Response.json({ data: await marketRates(), updated_at: new Date().toISOString() });
}
