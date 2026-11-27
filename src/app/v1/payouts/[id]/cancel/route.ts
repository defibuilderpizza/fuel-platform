import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { closePayout } from "@/lib/payouts";

/** Cancel your payout before it's approved. The amount goes back to your balance. */
export async function POST(req: Request, ctx: RouteContext<"/v1/payouts/[id]/cancel">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const r = await closePayout(id, "cancelled", "Cancelled by the account owner", caller.wallet);
  if (r === "ok") return Response.json({ id, status: "cancelled" });
  if (r === "not_found") return apiError(404, "not_found", "No such payout.");
  if (r === "not_cancellable") return apiError(409, "invalid_request_error", "Already approved: it's being paid, so it can't be cancelled.");
  return apiError(409, "invalid_request_error", "This payout is already closed.");
}
