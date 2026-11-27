import { authenticate } from "@/lib/auth";
import { apiError } from "@/lib/http";
import { autoReview, sellerView } from "@/lib/sellers";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Re-test your endpoint's models now. Passing models go live; failing ones leave routing. */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const { data: s } = await supabaseAdmin().from("sellers").select("id").eq("wallet", caller.wallet).maybeSingle();
  if (!s) return apiError(404, "not_found", "You haven't applied to sell compute yet.");
  const probes = await autoReview(s.id);
  return Response.json({ ...(await sellerView(caller.wallet)), probes });
}
