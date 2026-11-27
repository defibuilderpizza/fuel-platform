import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Revokes one of your keys. */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/auth/keys/[id]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { id } = await ctx.params;
  const { data } = await supabaseAdmin()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("wallet", caller.wallet)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (!data) return apiError(404, "not_found", "No active key with that id on your wallet.");
  return Response.json({ id, revoked: true });
}
