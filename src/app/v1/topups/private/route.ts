import { connection } from "next/server";
import { ringConfig } from "@/lib/ring";

/** How to top up privately. The amount stays encrypted on-chain; only you and Fuel can read it. */
export async function GET() {
  await connection();
  const cfg = ringConfig();
  if (!cfg.enabled) return Response.json({ enabled: false, message: "Private top-ups are not open yet." });
  return Response.json({
    enabled: true,
    network: cfg.network,
    ring_address: cfg.ringAddress,
    assets: ["SOL", "USDC"],
    limited_beta: cfg.allowlist.length > 0,
    max_per_topup_usd: cfg.maxMicro === null ? null : cfg.maxMicro / 1e6,
    steps: [
      "Register your wallet with Solana Privacy Rings and fund your private balance (@heliuslabs/spr: buildRegistrationTransaction, buildDepositTransaction).",
      "Send a private transfer of SOL or USDC from that balance to ring_address (buildTransferTransaction).",
      "POST /v1/topups/private/confirm with the transaction signature and your Fuel API key. Fuel also scans every minute, so this only makes it faster.",
    ],
    privacy:
      "Visible on-chain: that your wallet paid Fuel. Hidden: the asset and the amount. Fuel credits the wallet that signed the transfer. A deposit from a public wallet straight into the ring is not private (the amount shows).",
  });
}
