import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { closeContract } from "@/lib/forwards";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Withdraw an offer Fuel hasn't accepted yet; the bond comes back. */
export async function POST(req: Request, ctx: RouteContext<"/v1/sellers/contracts/[id]/withdraw">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const { data: c } = await supabaseAdmin().from("capacity_contracts").select("wallet").eq("id", id).maybeSingle();
  if (!c || c.wallet !== caller.wallet) return apiError(404, "not_found", "No such contract.");
  const r = await closeContract(id, "withdrawn", "Withdrawn by the seller.");
  if (r !== "ok") return apiError(409, "invalid_request_error", r === "wrong_state" ? "Only offers that haven't been accepted can be withdrawn." : r, r);
  return Response.json({ id, status: "withdrawn" });
}
