import { connection } from "next/server";
import { ACTION_HEADERS, LIMITS, actionError, actionJson, buildFuelTransaction, siteUrl } from "@/lib/actions";
import { getAgent } from "@/lib/agents";
import { isWalletAddress } from "@/lib/auth";

/** "Fuel this agent": the Action a Blink renders. */
export async function GET(req: Request, ctx: RouteContext<"/api/actions/fuel/[name]">) {
  await connection();
  const { name } = await ctx.params;
  const agent = await getAgent(name.toLowerCase());
  if (!agent) return actionError("No agent with that name.", 404);
  const base = `/api/actions/fuel/${agent.name}`;
  const supporters = `${agent.supporters} supporter${agent.supporters === 1 ? "" : "s"} so far, $${agent.community_fuel_usd.toFixed(2)} of community fuel.`;
  return actionJson({
    type: "action",
    icon: `${siteUrl(req)}/action-icon.png`,
    title: `Fuel ${agent.display_name}`,
    description: `${agent.description ? agent.description + " " : ""}Top up this agent's compute balance on Fuel. ${supporters}`,
    label: "Fuel",
    links: {
      actions: [
        { type: "transaction", label: "$1", href: `${base}?asset=USDC&amount=1` },
        { type: "transaction", label: "$5", href: `${base}?asset=USDC&amount=5` },
        { type: "transaction", label: "$20", href: `${base}?asset=USDC&amount=20` },
        {
          type: "transaction",
          label: "Fuel with USDC",
          href: `${base}?asset=USDC&amount={amount}`,
          parameters: [{ type: "number", name: "amount", label: "USDC amount", required: true, min: LIMITS.USDC.min, max: LIMITS.USDC.max }],
        },
        {
          type: "transaction",
          label: "Fuel with SOL",
          href: `${base}?asset=SOL&amount={amount}`,
          parameters: [{ type: "number", name: "amount", label: "SOL amount", required: true, min: LIMITS.SOL.min, max: LIMITS.SOL.max }],
        },
      ],
    },
  });
}

/** Builds the transaction for the given account. Body: { account }. */
export async function POST(req: Request, ctx: RouteContext<"/api/actions/fuel/[name]">) {
  const { name } = await ctx.params;
  const agent = await getAgent(name.toLowerCase());
  if (!agent) return actionError("No agent with that name.", 404);
  const url = new URL(req.url);
  const asset = url.searchParams.get("asset") === "SOL" ? "SOL" : "USDC";
  const amount = Number(url.searchParams.get("amount"));
  const lim = LIMITS[asset];
  if (!Number.isFinite(amount) || amount < lim.min || amount > lim.max) {
    return actionError(`Amount must be between ${lim.min} and ${lim.max} ${asset}.`);
  }
  const body = (await req.json().catch(() => null)) as { account?: string } | null;
  if (!isWalletAddress(body?.account)) return actionError("'account' must be a Solana address.");

  try {
    const built = await buildFuelTransaction({ account: body.account, agent: agent.name, asset, amount });
    if ("error" in built) return actionError(String(built.error));
    return actionJson({
      type: "transaction",
      transaction: built.transaction,
      message: `Fuelling ${agent.display_name} with ${amount} ${asset}.`,
      links: { next: { type: "post", href: `/api/actions/fuel/${agent.name}/confirm` } },
    });
  } catch {
    return actionError("Could not build the transaction right now. Try again.", 503);
  }
}

export function OPTIONS() {
  return new Response(null, { headers: ACTION_HEADERS });
}
