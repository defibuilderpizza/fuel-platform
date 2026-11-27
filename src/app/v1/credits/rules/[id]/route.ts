import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { deleteRule } from "@/lib/credit-rules";

/** Delete a standing rule. (Orders it already listed stay; cancel them with DELETE /v1/credits/orders/{id}.) */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/credits/rules/[id]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError(404, "not_found", "No such rule.");
  if (!(await deleteRule(caller.wallet, id))) return apiError(404, "not_found", "No such rule.");
  return Response.json({ id, deleted: true });
}
