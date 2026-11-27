import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { faucetStatus } from "@/lib/faucet";

/** Your free trial and pay-later credit: limit, what's used, when it's due, and the pot left. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json(await faucetStatus(caller.wallet));
}
