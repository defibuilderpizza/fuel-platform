import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { BYOK_SUPPORTED, deleteProviderKey, type ByokProvider } from "@/lib/byok";

/** Remove your own key for a provider. */
export async function DELETE(req: Request, ctx: RouteContext<"/v1/byok/[provider]">) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { provider } = await ctx.params;
  if (!(BYOK_SUPPORTED as readonly string[]).includes(provider)) return apiError(404, "not_found", "Unknown provider.");
  await deleteProviderKey(caller.wallet, provider as ByokProvider);
  return Response.json({ provider, removed: true });
}
