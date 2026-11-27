import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { listAgents, topFuellers } from "@/lib/agents";

export const metadata = { title: "Leaderboard", description: "The most-fuelled agents and the people keeping them running." };

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 sm:space-y-8 px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">Community fuel</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Leaderboard</h1>
          <p className="mt-1 text-sm text-muted">Community top-ups only. Private top-ups are never counted.</p>
        </div>
        <Link href="/dashboard" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">
          Make your agent public
        </Link>
      </div>
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Boards />
      </Suspense>
    </main>
  );
}

async function Boards() {
  await connection();
  const [agents, fuellers] = await Promise.all([listAgents("fuel", 25), topFuellers(25)]);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="space-y-3">
        <h2 className="font-semibold">Most-fuelled agents</h2>
        {agents.length === 0 ? (
          <p className="text-sm text-muted">No agents yet.</p>
        ) : (
          <ol className="divide-y divide-line rounded-xl border border-line bg-card text-sm">
            {agents.map((a, i) => (
              <li key={a.name} className="row-hover flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="w-5 text-right tabular-nums text-muted">{i + 1}</span>
                  <Link href={`/agent/${a.name}`} className="truncate underline">
                    {a.display_name}
                  </Link>
                </span>
                <span className="shrink-0 tabular-nums">
                  {usd(a.community_fuel_usd)} <span className="text-xs text-muted">· {a.supporters} supporters</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Top fuellers</h2>
        {fuellers.length === 0 ? (
          <p className="text-sm text-muted">Nobody has fuelled an agent yet.</p>
        ) : (
          <ol className="divide-y divide-line rounded-xl border border-line bg-card text-sm">
            {fuellers.map((f, i) => (
              <li key={f.wallet} className="row-hover flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex items-center gap-3">
                  <span className="w-5 text-right tabular-nums text-muted">{i + 1}</span>
                  <a className="font-mono text-xs underline" href={`https://solscan.io/account/${f.wallet}`} target="_blank" rel="noreferrer">
                    {short(f.wallet)}
                  </a>
                </span>
                <span className="tabular-nums">
                  {usd(f.total_usd)} <span className="text-xs text-muted">· {f.agents_fuelled} agents</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
