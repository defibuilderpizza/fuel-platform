import "server-only";
import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Self-fuelling: a project links the wallet that receives its token fees to its agent.
// The fee wallet must sign a message naming the exact agent, so nobody can redirect
// another wallet's payments to themselves.

export function linkMessage(source: string, agentName: string, agentWallet: string, nonce: string, issuedAt: string) {
  return [
    "Fuel: link this wallet as a fee source.",
    `Fee wallet: ${source}`,
    `Agent: ${agentName}`,
    `Agent wallet: ${agentWallet}`,
    "",
    "Everything this wallet sends to Fuel's deposit address will be credited to that agent's compute balance, until unlinked.",
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export async function createLinkNonce(source: string, agentName: string, agentWallet: string) {
  const nonce = randomBytes(16).toString("hex");
  const message = linkMessage(source, agentName, agentWallet, nonce, new Date().toISOString());
  const { error } = await supabaseAdmin().from("auth_nonces").insert({ nonce, wallet: source, message });
  if (error) throw error;
  return { nonce, message, expires_in_seconds: 600 };
}

export async function listFeeSources(agentWallet: string) {
  const { data } = await supabaseAdmin()
    .from("agent_fee_sources")
    .select("source_wallet, label, created_at")
    .eq("agent_wallet", agentWallet)
    .order("created_at", { ascending: true });
  return (data ?? []).map((r) => ({ wallet: r.source_wallet, label: r.label, linked_at: r.created_at }));
}
