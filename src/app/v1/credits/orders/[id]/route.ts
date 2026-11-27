import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { cancelOrder } from "@/lib/credit-market";

/** Cancel an open order: held credits or money come back. */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/credits/orders/[id]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const r = await cancelOrder(caller.wallet, id);
  if (r === "ok") return Response.json({ id, status: "cancelled" });
  return apiError(r === "not_found" ? 404 : 409, "invalid_request_error", r === "not_open" ? "That order is already filled or cancelled." : r === "not_found" ? "No such order." : r, r);
}
