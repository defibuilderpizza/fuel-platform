import { requireAdmin } from "@/lib/admin";
import { apiError, readJson } from "@/lib/http";
import { acceptContract, closeContract } from "@/lib/forwards";

/**
 * Decide on a contract. Body: { action: "accept" | "reject" | "complete" | "breach", note? }.
 * accept starts the term; reject returns the bond; complete pays the premium from the credit
 * reserve and returns the bond (the cron does this itself at the end of the term); breach
 * keeps the bond in the reserve (the cron does this after 24 h of failure).
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/admin/contracts/[id]">) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const b = await readJson<{ action?: string; note?: string }>(req);
  const note = typeof b?.note === "string" ? b.note.trim().slice(0, 300) || undefined : undefined;
  let r: string;
  if (b?.action === "accept") r = await acceptContract(id);
  else if (b?.action === "reject") r = await closeContract(id, "rejected", note ?? "Not accepted.");
  else if (b?.action === "complete") r = await closeContract(id, "completed", note ?? "Completed (admin).");
  else if (b?.action === "breach") r = await closeContract(id, "breached", note ?? "Breached (admin).");
  else return apiError(400, "invalid_request_error", "'action' must be accept, reject, complete or breach.");
  if (r !== "ok") return apiError(r === "not_found" ? 404 : 409, "invalid_request_error", r === "wrong_state" ? "The contract isn't in a state where that's possible." : r, r);
  return Response.json({ id, done: b.action });
}
