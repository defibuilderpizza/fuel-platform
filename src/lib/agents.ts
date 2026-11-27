import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd } from "@/lib/money";

// Agents are wallets that chose a public name. Public data is limited to what the spec
// allows: balance, job count, and community top-ups (which are public on-chain anyway).

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(["admin", "api", "fuel", "dashboard", "leaderboard", "agents", "agent", "v1", "docs", "help", "support", "team", "fee-sources"]);

export type AgentInput = { name?: unknown; display_name?: unknown; description?: unknown; x_handle?: unknown; website?: unknown };

/** Validates and normalises agent fields. Returns an error message or the clean values. */
export function cleanAgent(input: AgentInput, isNew: boolean): { error: string } | { value: Record<string, string | null> } {
  const v: Record<string, string | null> = {};
  if (isNew) {
    const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
    if (!NAME_RE.test(name)) return { error: "'name' must be 3–32 characters: a-z, 0-9 and hyphens, not starting or ending with a hyphen." };
    if (RESERVED.has(name)) return { error: `'${name}' is reserved.` };
    v.name = name;
  } else if (input.name !== undefined) {
    return { error: "An agent's name can't change: Blinks and memos in the wild point at it." };
  }
  const str = (k: keyof AgentInput, max: number, required = false) => {
    if (input[k] === undefined) {
      if (required) return `'${k}' is required.`;
      return null;
    }
    if (input[k] === null || input[k] === "") {
      if (required) return `'${k}' is required.`;
      v[k] = null;
      return null;
    }
    if (typeof input[k] !== "string") return `'${k}' must be a string.`;
    const s = (input[k] as string).trim();
    if (s.length > max) return `'${k}' must be at most ${max} characters.`;
    v[k] = s;
    return null;
  };
  const err =
    str("display_name", 48, isNew) ??
    str("description", 280) ??
    str("x_handle", 16) ??
    str("website", 200);
  if (err) return { error: err };
  if (v.x_handle) {
    v.x_handle = v.x_handle.replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(v.x_handle)) return { error: "'x_handle' must be a valid X handle." };
  }
  if (v.website && !/^https:\/\/[^\s]+$/.test(v.website)) return { error: "'website' must start with https://" };
  return { value: v };
}

type StatsRow = {
  wallet: string;
  name: string;
  display_name: string;
  description: string | null;
  x_handle: string | null;
  website: string | null;
  created_at: string;
  balance_micro: number;
  jobs_completed: number;
  community_micro: number;
  supporters: number;
  self_fuel_micro: number;
};

export function agentView(r: StatsRow) {
  return {
    name: r.name,
    display_name: r.display_name,
    description: r.description,
    x_handle: r.x_handle,
    website: r.website,
    wallet: r.wallet,
    balance_usd: microToUsd(r.balance_micro),
    jobs_completed: Number(r.jobs_completed),
    community_fuel_usd: microToUsd(r.community_micro),
    supporters: Number(r.supporters),
    self_fuel_usd: microToUsd(r.self_fuel_micro),
    created_at: r.created_at,
  };
}

export async function getAgent(name: string) {
  if (!NAME_RE.test(name)) return null;
  const db = supabaseAdmin();
  const { data } = await db.from("agent_stats").select("*").eq("name", name).maybeSingle();
  if (!data) return null;
  const { data: sup } = await db.rpc("fuel_agent_supporters", { p_wallet: data.wallet, p_limit: 20 });
  return {
    ...agentView(data as StatsRow),
    top_supporters: ((sup ?? []) as { supporter_wallet: string; total_micro: number; topups: number; last_at: string }[]).map((s) => ({
      wallet: s.supporter_wallet,
      total_usd: microToUsd(s.total_micro),
      topups: Number(s.topups),
      last_at: s.last_at,
    })),
  };
}

export async function listAgents(sort: "fuel" | "jobs" | "new", limit: number) {
  const col = sort === "jobs" ? "jobs_completed" : sort === "new" ? "created_at" : "community_micro";
  const { data } = await supabaseAdmin().from("agent_stats").select("*").order(col, { ascending: false }).limit(Math.min(Math.max(limit, 1), 100));
  return ((data ?? []) as StatsRow[]).map(agentView);
}

export async function topFuellers(limit: number) {
  const { data } = await supabaseAdmin().rpc("fuel_top_fuellers", { p_limit: Math.min(Math.max(limit, 1), 100) });
  return ((data ?? []) as { supporter_wallet: string; total_micro: number; agents: number; topups: number }[]).map((f) => ({
    wallet: f.supporter_wallet,
    total_usd: microToUsd(f.total_micro),
    agents_fuelled: Number(f.agents),
    topups: Number(f.topups),
  }));
}
