import { connection } from "next/server";
import { listAgents, topFuellers } from "@/lib/agents";

/** Most-fuelled agents and top fuellers overall. Public top-ups only; private ones are never counted. */
export async function GET() {
  await connection();
  const [agents, fuellers] = await Promise.all([listAgents("fuel", 25), topFuellers(25)]);
  return Response.json({ agents, fuellers });
}
