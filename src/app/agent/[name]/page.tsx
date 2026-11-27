import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getAgent } from "@/lib/agents";
import FuelAgentButton from "@/components/fuel-agent-button";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud";

export async function generateMetadata({ params }: PageProps<"/agent/[name]">) {
  const { name } = await params;
  return { title: `Fuel ${name}`, description: `Top up ${name}'s compute balance on Fuel.` };
}

export default function Page({ params }: PageProps<"/agent/[name]">) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 sm:space-y-8 px-4 py-10">
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <Agent params={params} />
      </Suspense>
    </main>
  );
}

async function Agent({ params }: { params: Promise<{ name: string }> }) {
  await connection();
  const { name } = await params;
  const agent = await getAgent(name.toLowerCase());
  if (!agent) notFound();
  const blink = `https://dial.to/?action=${encodeURIComponent(`solana-action:${site}/api/actions/fuel/${agent.name}`)}`;

  return (
    <>
      <section className="space-y-2">
        <p className="font-mono text-xs text-muted">fuel/agent/{agent.name}</p>
        <h1 className="text-3xl font-bold tracking-tight">{agent.display_name}</h1>
        {agent.description && <p className="max-w-xl text-muted">{agent.description}</p>}
        <p className="flex flex-wrap gap-3 text-sm">
          {agent.x_handle && (
            <a className="underline" href={`https://x.com/${agent.x_handle}`} target="_blank" rel="noreferrer">
              @{agent.x_handle}
            </a>
          )}
          {agent.website && (
            <a className="underline" href={agent.website} target="_blank" rel="noreferrer">
              {agent.website.replace(/^https:\/\//, "")}
            </a>
          )}
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Balance" value={usd(agent.balance_usd)} />
        <Stat label="Jobs run" value={agent.jobs_completed.toLocaleString("en-US")} />
        <Stat label="Community fuel" value={usd(agent.community_fuel_usd)} />
        <Stat label="Supporters" value={agent.supporters.toLocaleString("en-US")} />
      </section>

      {agent.self_fuel_usd > 0 && (
        <p className="text-sm text-muted">
          Self-fuelling: {usd(agent.self_fuel_usd)} so far from its own project fees.
        </p>
      )}

      <FuelAgentButton agent={agent.name} displayName={agent.display_name} />

      <section className="space-y-3">
        <h2 className="font-medium">Top fuellers</h2>
        {agent.top_supporters.length === 0 ? (
          <p className="text-sm text-muted">Nobody yet. Be the first to fuel {agent.display_name}.</p>
        ) : (
          <ol className="divide-y divide-line rounded-xl border border-line bg-card text-sm">
            {agent.top_supporters.map((s, i) => (
              <li key={s.wallet} className="row-hover flex items-center justify-between gap-3 px-4 py-2">
                <span className="flex items-center gap-3">
                  <span className="w-5 text-right tabular-nums text-muted">{i + 1}</span>
                  <a className="font-mono text-xs underline" href={`https://solscan.io/account/${s.wallet}`} target="_blank" rel="noreferrer">
                    {short(s.wallet)}
                  </a>
                </span>
                <span className="tabular-nums">
                  {usd(s.total_usd)} <span className="text-xs text-muted">· {s.topups}×</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-1 text-xs text-muted">
        <p>
          Share as a Blink:{" "}
          <a className="break-all underline" href={blink} target="_blank" rel="noreferrer">
            {blink}
          </a>
        </p>
        <p>Public: balance, job count and community top-ups. Never what the agent&apos;s jobs were. Private top-ups are never shown.</p>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
