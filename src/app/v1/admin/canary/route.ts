import { connection } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { providerCanary } from "@/lib/alerts";

/** Runs the provider canary now: one tiny request to each hosted provider's cheapest chat model. */
export async function GET(req: Request) {
  await connection();
  const denied = requireAdmin(req);
  if (denied) return denied;
  const results = await providerCanary();
  return Response.json({ ok: results.every((r) => r.ok), results });
}
