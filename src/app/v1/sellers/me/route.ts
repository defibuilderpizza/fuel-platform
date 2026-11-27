import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { sellerView } from "@/lib/sellers";

/** Your seller listing: status, models with their last test result, jobs served, earnings. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json(await sellerView(caller.wallet));
}
