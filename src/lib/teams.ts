import "server-only";
import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { microToUsd } from "@/lib/money";

// Team accounts: one place for the people running several agents.

export type Role = "owner" | "admin" | "member" | "agent";

export async function roleIn(teamId: string, wallet: string): Promise<Role | null> {
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) return null;
  const { data } = await supabaseAdmin().from("team_members").select("role").eq("team_id", teamId).eq("wallet", wallet).maybeSingle();
  return (data?.role as Role) ?? null;
}
export const canManage = (r: Role | null) => r === "owner" || r === "admin";
export const canView = (r: Role | null) => r === "owner" || r === "admin" || r === "member";

export function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = randomBytes(10);
  const s = [...b].map((x) => alphabet[x % alphabet.length]).join("");
  return `FUEL-${s.slice(0, 5)}-${s.slice(5)}`;
}

export async function myTeams(wallet: string) {
  const db = supabaseAdmin();
  const { data } = await db.from("team_members").select("team_id, role, teams(name, owner, created_at)").eq("wallet", wallet);
  return (data ?? []).map((r) => {
    const t = r.teams as unknown as { name: string; owner: string; created_at: string } | null;
    return { id: r.team_id as string, role: r.role as Role, name: t?.name ?? "", created_at: t?.created_at ?? null };
  });
}

/** Everything a team member sees: agents with spend and limits, totals, people, recent receipts. */
export async function teamOverview(teamId: string, viewerRole: Role) {
  const db = supabaseAdmin();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [{ data: team }, { data: members }] = await Promise.all([
    db.from("teams").select("id, name, owner, created_at").eq("id", teamId).single(),
    db.from("team_members").select("wallet, role, label, joined_at").eq("team_id", teamId).order("joined_at"),
  ]);
  const agentWallets = (members ?? []).filter((m) => m.role === "agent").map((m) => m.wallet);

  const [{ data: accounts }, { data: jobs30 }, { data: publicAgents }, { data: receipts }, invites] = await Promise.all([
    agentWallets.length ? db.from("accounts").select("wallet, balance_micro, held_micro, daily_limit_micro, per_job_limit_micro, debt_since").in("wallet", agentWallets) : Promise.resolve({ data: [] }),
    agentWallets.length
      ? db.from("jobs").select("wallet, price_micro, created_at").in("wallet", agentWallets).eq("status", "succeeded").gte("created_at", since30)
      : Promise.resolve({ data: [] }),
    agentWallets.length ? db.from("agents").select("wallet, name, display_name").in("wallet", agentWallets) : Promise.resolve({ data: [] }),
    agentWallets.length
      ? db.from("jobs").select("id, wallet, model, status, provider, price_micro, input_tokens, output_tokens, latency_ms, created_at").in("wallet", agentWallets).order("created_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
    viewerRole === "owner" || viewerRole === "admin"
      ? db.from("team_invites").select("code, role, uses_left, expires_at, created_at").eq("team_id", teamId).gt("uses_left", 0).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  const acc = new Map((accounts ?? []).map((a) => [a.wallet, a]));
  const pub = new Map((publicAgents ?? []).map((a) => [a.wallet, a]));
  const memberLabel = new Map((members ?? []).map((m) => [m.wallet, m.label]));
  const spend = new Map<string, { today: number; d30: number; jobs30: number }>();
  for (const j of jobs30 ?? []) {
    const s = spend.get(j.wallet) ?? { today: 0, d30: 0, jobs30: 0 };
    s.d30 += Number(j.price_micro ?? 0);
    s.jobs30 += 1;
    if (new Date(j.created_at) >= today) s.today += Number(j.price_micro ?? 0);
    spend.set(j.wallet, s);
  }

  const agents = agentWallets.map((w) => {
    const a = acc.get(w);
    const s = spend.get(w) ?? { today: 0, d30: 0, jobs30: 0 };
    const p = pub.get(w);
    return {
      wallet: w,
      label: memberLabel.get(w) ?? p?.display_name ?? null,
      public_name: p?.name ?? null,
      balance_usd: microToUsd(a?.balance_micro ?? 0),
      held_usd: microToUsd(a?.held_micro ?? 0),
      owes: Number(a?.balance_micro ?? 0) < 0,
      spent_today_usd: microToUsd(s.today),
      spent_30d_usd: microToUsd(s.d30),
      jobs_30d: s.jobs30,
      limits: {
        daily_usd: a?.daily_limit_micro == null ? null : microToUsd(a.daily_limit_micro),
        per_job_usd: a?.per_job_limit_micro == null ? null : microToUsd(a.per_job_limit_micro),
      },
    };
  });

  return {
    team: { id: team!.id, name: team!.name, created_at: team!.created_at },
    your_role: viewerRole,
    totals: {
      agents: agents.length,
      balance_usd: agents.reduce((t, a) => t + a.balance_usd, 0),
      spent_today_usd: agents.reduce((t, a) => t + a.spent_today_usd, 0),
      spent_30d_usd: agents.reduce((t, a) => t + a.spent_30d_usd, 0),
      jobs_30d: agents.reduce((t, a) => t + a.jobs_30d, 0),
    },
    agents,
    people: (members ?? []).filter((m) => m.role !== "agent").map((m) => ({ wallet: m.wallet, role: m.role, label: m.label, joined_at: m.joined_at })),
    receipts: (receipts ?? []).map((r) => ({
      id: r.id,
      agent: r.wallet,
      agent_label: memberLabel.get(r.wallet) ?? pub.get(r.wallet)?.display_name ?? null,
      model: r.model,
      status: r.status,
      provider: r.provider,
      price_usd: microToUsd(r.price_micro ?? 0),
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      latency_ms: r.latency_ms,
      created_at: r.created_at,
    })),
    invites: invites.data ?? [],
  };
}
