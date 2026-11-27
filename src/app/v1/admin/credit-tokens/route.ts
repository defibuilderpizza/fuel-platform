import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { bridgeReport } from "@/lib/credit-bridge";

/** Per series: credits held for tokens vs on-chain supply (must match; a mismatch halts bridging). */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  return Response.json(await bridgeReport());
}
