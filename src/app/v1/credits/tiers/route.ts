import { connection } from "next/server";
import { tiersOverview } from "@/lib/credit-tiers";

/**
 * Credit tiers: each tier's price per credit and exactly how many tokens one credit buys on every
 * model in it (at a 3:1 input:output mix, plus all-input and all-output figures).
 */
export async function GET() {
  await connection();
  return Response.json(
    {
      how_it_works:
        "1 credit = at least 1M tokens (3:1 input:output) on any model of its tier. The tier's dearest model gets exactly 1M; cheaper ones get more. Jobs on a tier's models use your credits of that tier automatically.",
      tiers: await tiersOverview(),
    },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}
