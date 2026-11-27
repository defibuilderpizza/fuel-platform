import { connection } from "next/server";
import { systemStatus } from "@/lib/status";

/** Public system status: overall level, components, 24 hourly buckets. Cached ~30 s. */
export async function GET() {
  await connection();
  const s = await systemStatus();
  return Response.json(s, { status: s.level === "down" ? 503 : 200, headers: { "cache-control": "public, max-age=30" } });
}
