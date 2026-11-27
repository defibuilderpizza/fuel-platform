import { connection } from "next/server";
import { LANE, onlineWorkers } from "@/lib/lane";
import { LANE_MODEL } from "@/lib/lane-crypto";

/** Public status of the laptop lane. */
export async function GET() {
  await connection();
  const online = (await onlineWorkers()).length;
  return Response.json({
    model: LANE_MODEL,
    laptops_online: online,
    available: online >= 2,
    price_per_mtok_usd: LANE.pricePerMTokUsd,
    min_charge_usd: LANE.minChargeMicro / 1e6,
    worker_share: LANE.workerShare,
    privacy:
      "Laptop-lane inputs are encrypted to the two (sometimes three) laptops that process them, and Fuel never stores them. Those laptops do see the text they embed, so don't send anything sensitive to this model.",
  });
}
