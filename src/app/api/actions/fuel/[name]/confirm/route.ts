import { ACTION_HEADERS, actionError, actionJson, siteUrl } from "@/lib/actions";
import { getAgent } from "@/lib/agents";
import { confirmDeposit } from "@/lib/deposits";
import { isSignature } from "@/lib/solana";

/**
 * Callback after the wallet sends the transaction (Action chaining). Body: { account, signature }.
 * Waits for finalization, then credits the agent.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/actions/fuel/[name]/confirm">) {
  const { name } = await ctx.params;
  const agent = await getAgent(name.toLowerCase());
  if (!agent) return actionError("No agent with that name.", 404);
  const body = (await req.json().catch(() => null)) as { account?: string; signature?: string } | null;
  if (!isSignature(body?.signature)) return actionError("'signature' must be a Solana transaction signature.");

  let r = await confirmDeposit(body.signature);
  for (let i = 0; i < 12 && !r.ok && r.status === 404; i++) {
    await new Promise((ok) => setTimeout(ok, 3000));
    r = await confirmDeposit(body.signature);
  }
  const icon = `${siteUrl(req)}/action-icon.png`;
  if (!r.ok) {
    return actionJson({ type: "completed", icon, title: "Sent: crediting shortly", description: `Your transaction went through. ${r.message}`, label: "Pending" });
  }
  const toAgent = r.deposit.wallet === agent.wallet;
  const usd = `$${r.deposit.credited_usd.toFixed(2)}`;
  return actionJson({
    type: "completed",
    icon,
    title: toAgent ? `You fuelled ${agent.display_name}` : "Credited",
    description: toAgent ? `${usd} added to ${agent.display_name}'s compute balance. Thanks for keeping it running.` : `${usd} credited.`,
    label: "Done",
  });
}

export function OPTIONS() {
  return new Response(null, { headers: ACTION_HEADERS });
}
