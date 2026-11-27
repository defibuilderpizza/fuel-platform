import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { allContracts, hedgeSummary } from "@/lib/forwards";

/** All capacity contracts and how much compute cost they cap. */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  const [data, hedge] = await Promise.all([allContracts(), hedgeSummary()]);
  return Response.json({ hedge, data });
}
