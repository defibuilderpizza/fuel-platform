import { authenticate } from "@/lib/auth";
import { listFeeSources } from "@/lib/fee-sources";
import { apiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Unlink a fee wallet from your agent. Its future payments credit the fee wallet itself again. */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/agents/fee-sources/[source]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { source } = await ctx.params;
  const { data } = await supabaseAdmin()
    .from("agent_fee_sources")
    .delete()
    .eq("source_wallet", source)
    .eq("agent_wallet", caller.wallet)
    .select("source_wallet");
  if (!data?.length) return apiError(404, "not_found", "That wallet isn't linked to your agent.");
  return Response.json({ data: await listFeeSources(caller.wallet) });
}
