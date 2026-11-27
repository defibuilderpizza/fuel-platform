"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { connectWallet, fuelCall, saveKey, useFuelKey } from "@/components/fuel-key";

type Role = "owner" | "admin" | "member" | "agent";
type TeamRef = { id: string; name: string; role: Role };
type Agent = {
  wallet: string;
  label: string | null;
  public_name: string | null;
  balance_usd: number;
  held_usd: number;
  owes: boolean;
  spent_today_usd: number;
  spent_30d_usd: number;
  jobs_30d: number;
  limits: { daily_usd: number | null; per_job_usd: number | null };
};
type Overview = {
  team: { id: string; name: string };
  your_role: Role;
  totals: { agents: number; balance_usd: number; spent_today_usd: number; spent_30d_usd: number; jobs_30d: number };
  agents: Agent[];
  people: { wallet: string; role: Role; label: string | null }[];
  receipts: { id: string; agent: string; agent_label: string | null; model: string; status: string; provider: string | null; price_usd: number; created_at: string }[];
  invites: { code: string; role: string; uses_left: number; expires_at: string }[];
};

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const usd = (n: number, dp = 2) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(dp)}`;
const field = "rounded-lg border border-line-strong bg-white/70 px-3 py-2 text-sm";

const noSubscribe = () => () => {};

/** Arrived from /trial: where the team's free credits are claimed. */
function TrialNote() {
  return (
    <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 text-sm">
      <p className="font-medium">Free trial: free credits on your wallet</p>
      <p className="mt-1 text-muted">
        Sign in here, then{" "}
        <Link href="/dashboard?trial=1" className="underline">
          claim the free credits on the dashboard
        </Link>{" "}
        with the same wallet. Create a team below and fund your agents from it.
      </p>
    </div>
  );
}

export default function TeamsApp() {
  const key = useFuelKey();
  const trial = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).has("trial"), () => false);
  const [teams, setTeams] = useState<TeamRef[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [newName, setNewName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [paste, setPaste] = useState("");
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!key) return;
    let stale = false;
    fuelCall<{ data: TeamRef[] }>(key, "/v1/teams")
      .then((r) => {
        if (stale) return;
        const humanTeams = r.data.filter((t) => t.role !== "agent");
        setTeams(humanTeams);
        setSelected((s) => s ?? humanTeams[0]?.id ?? null);
      })
      .catch((e) => {
        if (!stale && String(e.message).toLowerCase().includes("api key")) saveKey(null);
      });
    return () => {
      stale = true;
    };
  }, [key, tick]);

  useEffect(() => {
    if (!key || !selected) return;
    let stale = false;
    fuelCall<Overview>(key, `/v1/teams/${selected}`)
      .then((o) => {
        if (!stale) setOv(o);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [key, selected, tick]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ text: ok });
      refresh();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    }
  };

  if (!key) {
    return (
      <div className="max-w-md space-y-4">
        {trial && <TrialNote />}
        <div className="space-y-4 rounded-2xl border border-line bg-card p-5 sm:p-7">
        <p className="font-semibold">Sign in with your own wallet</p>
        <p className="text-sm text-muted">Use the wallet you fund your agents from. Your agents keep their own wallets.</p>
        <button
          onClick={() => connectWallet("teams").catch((e) => setMsg({ text: e.message, bad: true }))}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong sm:text-base"
        >
          Connect wallet
        </button>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (paste.trim()) saveKey(paste.trim());
          }}
        >
          <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="or paste a Fuel API key" className={`${field} w-full font-mono`} />
          <button className="rounded-lg px-4 text-sm btn-2">Use</button>
        </form>
        {msg && <p className="text-sm text-bad">{msg.text}</p>}
        </div>
      </div>
    );
  }

  const manage = ov?.your_role === "owner" || ov?.your_role === "admin";

  return (
    <>
    {trial && <TrialNote />}
    <div className="mt-4 grid items-start gap-6 lg:grid-cols-[260px_1fr]">
      {/* Sidebar: teams, create, join */}
      <aside className="space-y-4">
        <div className="rounded-2xl border border-line bg-card p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Your teams</p>
          {teams?.length ? (
            <ul className="max-h-80 overflow-y-auto pr-1 space-y-1">
              {teams.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelected(t.id)}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected === t.id ? "bg-white/80 font-medium shadow-sm" : "text-muted hover:text-ink"}`}
                  >
                    {t.name} <span className="text-xs text-faint">· {t.role}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{teams ? "No teams yet." : "Loading…"}</p>
          )}
        </div>
        <form
          className="space-y-2 rounded-2xl border border-line bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const t = await fuelCall<{ id: string }>(key, "/v1/teams", { name: newName });
              setSelected(t.id);
              setNewName("");
            }, "Team created.");
          }}
        >
          <p className="text-xs font-medium uppercase tracking-wider text-faint">New team</p>
          <input required minLength={2} maxLength={48} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Team name" className={`${field} w-full`} />
          <button className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-strong">Create team</button>
        </form>
        <form
          className="space-y-2 rounded-2xl border border-line bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => fuelCall(key, "/v1/teams/join", { code: joinCode }), "Joined.").then(() => setJoinCode(""));
          }}
        >
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Join with a code</p>
          <input required value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="FUEL-XXXXX-XXXXX" className={`${field} w-full font-mono`} />
          <button className="w-full rounded-lg px-3 py-2 text-sm btn-2">Join</button>
        </form>
        <button onClick={() => saveKey(null)} className="text-xs text-muted hover:text-ink">
          Sign out
        </button>
      </aside>

      {/* Main: the selected team */}
      <section className="min-w-0 space-y-5">
        {msg && <p className={`rounded-lg border border-line bg-card px-4 py-2 text-sm ${msg.bad ? "text-bad" : "text-muted"}`}>{msg.text}</p>}
        {!ov ? (
          <div className="rounded-2xl border border-dashed border-line-strong p-5 sm:p-10 text-center text-muted">Create a team, or join one with a code, to see your agents here.</div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-2xl font-bold tracking-tight">{ov.team.name}</h2>
              <span className="text-sm text-muted">you&apos;re {ov.your_role}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ["Agents", String(ov.totals.agents)],
                ["Combined balance", usd(ov.totals.balance_usd)],
                ["Spent today", usd(ov.totals.spent_today_usd, 4)],
                ["Spent 30 days", usd(ov.totals.spent_30d_usd, 4)],
              ].map(([l, v]) => (
                <div key={l} className="rounded-xl border border-line bg-card p-4">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-faint">{l}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{v}</p>
                </div>
              ))}
            </div>

            <div className="overflow-hidden rounded-2xl border border-line bg-card">
              <p className="border-b border-line px-5 py-3 font-semibold">Agents</p>
              {ov.agents.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted">No agents yet. Create an agent invite below and redeem it with the agent&apos;s own API key.</p>
              ) : (
                <ul className="max-h-[32rem] divide-y divide-line overflow-y-auto">
                  {ov.agents.map((a) => (
                    <AgentRow key={a.wallet} a={a} manage={manage} onAct={act} teamId={ov.team.id} apiKey={key} />
                  ))}
                </ul>
              )}
            </div>

            {manage && <Invites ov={ov} apiKey={key} onAct={act} />}

            <div className="grid gap-5 md:grid-cols-[1fr_1.4fr]">
              <div className="rounded-2xl border border-line bg-card p-5">
                <p className="mb-3 font-semibold">People</p>
                <ul className="max-h-80 overflow-y-auto pr-1 space-y-2 text-sm">
                  {ov.people.map((p) => (
                    <li key={p.wallet} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{short(p.wallet)}</span>
                      <span className="text-muted">{p.role}</span>
                      {manage && p.role !== "owner" && (p.role !== "admin" || ov.your_role === "owner") && (
                        <button onClick={() => act(() => del(key, `/v1/teams/${ov.team.id}/members/${p.wallet}`), "Removed.")} className="text-xs text-bad hover:underline">
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-line bg-card p-5">
                <p className="mb-3 font-semibold">Recent receipts, all agents</p>
                {ov.receipts.length === 0 ? (
                  <p className="text-sm text-muted">No jobs yet.</p>
                ) : (
                  <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
                    {ov.receipts.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="text-muted">{r.agent_label ?? short(r.agent)}</span>
                        <span className="max-w-48 truncate font-mono text-xs">{r.model}</span>
                        <span className="tabular-nums">{usd(r.price_usd, 6)}</span>
                        <span className={`text-xs ${r.status === "succeeded" ? "text-ok" : "text-muted"}`}>{r.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
    </>
  );
}

async function del(key: string, path: string) {
  const res = await fetch(path, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? "Request failed");
  return j;
}
async function patch(key: string, path: string, body: unknown) {
  const res = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? "Request failed");
  return j;
}

function AgentRow({ a, manage, onAct, teamId, apiKey }: { a: Agent; manage: boolean; onAct: (fn: () => Promise<unknown>, ok: string) => void; teamId: string; apiKey: string }) {
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState(a.limits.daily_usd?.toString() ?? "");
  const [perJob, setPerJob] = useState(a.limits.per_job_usd?.toString() ?? "");
  const [fund, setFund] = useState("");
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <li className="row-hover px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-40 flex-1">
          <p className="font-medium">{a.label ?? short(a.wallet)}</p>
          <p className="font-mono text-[11px] text-faint">{short(a.wallet)}{a.public_name ? ` · /agent/${a.public_name}` : ""}</p>
        </div>
        <Cell l="Balance" v={usd(a.balance_usd)} tone={a.owes ? "text-bad" : undefined} />
        <Cell l="Today" v={usd(a.spent_today_usd, 4)} />
        <Cell l="30 days" v={usd(a.spent_30d_usd, 4)} />
        <Cell l="Jobs (30d)" v={String(a.jobs_30d)} />
        <Cell l="Daily limit" v={a.limits.daily_usd == null ? "none" : usd(a.limits.daily_usd)} />
        {manage && (
          <button onClick={() => setOpen(!open)} className="text-sm font-medium text-accent hover:underline">
            {open ? "Close" : "Manage"}
          </button>
        )}
      </div>
      {open && manage && (
        <div className="mt-3 grid gap-3 rounded-xl border border-line bg-white/50 p-4 md:grid-cols-3">
          <form
            className="space-y-2 md:col-span-2"
            onSubmit={(e) => {
              e.preventDefault();
              onAct(() => patch(apiKey, `/v1/teams/${teamId}/agents/${a.wallet}`, { daily_usd: num(daily), per_job_usd: num(perJob) }), "Limits saved.");
            }}
          >
            <p className="text-xs font-medium text-faint">Limits (USD, blank = none)</p>
            <div className="flex flex-wrap gap-2">
              <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" placeholder="per day" className={`${field} w-32`} />
              <input value={perJob} onChange={(e) => setPerJob(e.target.value)} inputMode="decimal" placeholder="per job" className={`${field} w-32`} />
              <button className="rounded-lg px-3 py-2 text-sm btn-2">Save limits</button>
            </div>
          </form>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              onAct(() => fuelCall(apiKey, `/v1/teams/${teamId}/agents/${a.wallet}/fund`, { usd: Number(fund) }), `Moved $${Number(fund).toFixed(2)} to the agent.`);
              setFund("");
            }}
          >
            <p className="text-xs font-medium text-faint">Fund from your balance</p>
            <div className="flex gap-2">
              <input required value={fund} onChange={(e) => setFund(e.target.value)} inputMode="decimal" placeholder="$" className={`${field} w-24`} />
              <button className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-strong">Fund</button>
            </div>
          </form>
          <button onClick={() => onAct(() => del(apiKey, `/v1/teams/${teamId}/members/${a.wallet}`), "Agent removed from the team.")} className="justify-self-start text-xs text-bad hover:underline md:col-span-3">
            Remove from team (the agent keeps its wallet and balance)
          </button>
        </div>
      )}
    </li>
  );
}

function Cell({ l, v, tone }: { l: string; v: string; tone?: string }) {
  return (
    <div className="min-w-20">
      <p className="text-[11px] text-faint">{l}</p>
      <p className={`text-sm font-semibold tabular-nums ${tone ?? ""}`}>{v}</p>
    </div>
  );
}

function Invites({ ov, apiKey, onAct }: { ov: Overview; apiKey: string; onAct: (fn: () => Promise<unknown>, ok: string) => void }) {
  const [last, setLast] = useState<{ code: string; role: string; site: string } | null>(null);
  const create = (role: "agent" | "member" | "admin") =>
    onAct(async () => {
      const r = await fuelCall<{ code: string; role: string }>(apiKey, `/v1/teams/${ov.team.id}/invites`, { role });
      setLast({ ...r, site: window.location.origin });
    }, `New ${role} invite created.`);
  return (
    <div className="space-y-4 rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-semibold">Invite</p>
        <div className="flex flex-wrap gap-2 text-sm">
          <button onClick={() => create("agent")} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-strong">
            Add an agent
          </button>
          <button onClick={() => create("member")} className="rounded-lg px-3 py-1.5 btn-2">
            Invite a member
          </button>
          {ov.your_role === "owner" && (
            <button onClick={() => create("admin")} className="rounded-lg px-3 py-1.5 btn-2">
              Invite an admin
            </button>
          )}
        </div>
      </div>
      {last && (
        <div className="space-y-2 rounded-xl border border-line bg-white/60 p-4 text-sm">
          <p>
            Code: <span className="select-all font-mono font-semibold">{last.code}</span> <span className="text-muted">· single use · 7 days</span>
          </p>
          {last.role === "agent" ? (
            <>
              <p className="text-muted">The agent joins with its own API key (that&apos;s how the team proves it controls the agent&apos;s wallet):</p>
              <pre className="overflow-x-auto rounded-lg bg-[#2f2f2f] p-3 font-mono text-xs text-white/85">{`curl -X POST ${last.site}/v1/teams/join \\
  -H "Authorization: Bearer <AGENT_API_KEY>" \\
  -d '{"code":"${last.code}","label":"research-bot"}'`}</pre>
            </>
          ) : (
            <p className="text-muted">They sign in on this page and use “Join with a code”.</p>
          )}
        </div>
      )}
      {ov.invites.length > 0 && (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
          {ov.invites.map((i) => (
            <li key={i.code} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="font-mono text-xs">{i.code}</span>
              <span className="text-muted">
                {i.role} · {i.uses_left} use{i.uses_left === 1 ? "" : "s"} left · until {new Date(i.expires_at).toLocaleDateString()}
              </span>
              <button
                onClick={() =>
                  onAct(async () => {
                    const res = await fetch(`/v1/teams/${ov.team.id}/invites`, {
                      method: "DELETE",
                      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                      body: JSON.stringify({ code: i.code }),
                    });
                    if (!res.ok) throw new Error("Could not cancel.");
                  }, "Invite cancelled.")
                }
                className="text-xs text-bad hover:underline"
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
