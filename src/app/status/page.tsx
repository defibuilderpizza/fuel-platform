import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Eyebrow } from "@/components/ui";
import { systemStatus, type Level } from "@/lib/status";

export const metadata: Metadata = {
  title: "Status",
  description: "Live status of Fuel: API, compute providers, GPU sellers, the laptop lane and deposits.",
};

const LABEL: Record<Level, string> = { operational: "Operational", degraded: "Degraded", down: "Down", idle: "Idle" };
const DOT: Record<Level, string> = { operational: "bg-ok", degraded: "bg-amber-500", down: "bg-bad", idle: "bg-[#9b9b9b]" };
const TEXT: Record<Level, string> = { operational: "text-ok", degraded: "text-amber-700", down: "text-bad", idle: "text-faint" };

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 sm:space-y-8 px-4 py-8 sm:py-14">
      <section className="space-y-3">
        <Eyebrow>Status</Eyebrow>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">System status</h1>
        <p className="text-muted">Measured from real jobs: every provider attempt is recorded, so these numbers are what agents actually got.</p>
      </section>
      <Suspense fallback={<div className="h-96 rounded-3xl border border-line bg-card" />}>
        <Live />
      </Suspense>
    </main>
  );
}

async function Live() {
  await connection();
  const s = await systemStatus();
  const groups = [...new Set(s.components.map((c) => c.group))];
  const headline = s.level === "operational" ? "All systems operational" : s.level === "degraded" ? "Some systems degraded" : s.level === "down" ? "Major outage" : "Idle";
  const updated = new Date(s.updated_at).toISOString().slice(11, 16);
  return (
    <div className="space-y-8">
      {/* banner */}
      <div className={`flex items-center gap-4 rounded-3xl p-6 sm:p-8 ${s.level === "operational" ? "bg-[#474747] text-white" : "border border-line bg-card"}`}>
        <span className="relative flex h-4 w-4">
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-50 ${DOT[s.level]}`} />
          <span className={`relative inline-flex h-4 w-4 rounded-full ${DOT[s.level]}`} />
        </span>
        <div className="flex-1">
          <p className="text-xl font-semibold tracking-tight sm:text-2xl">{headline}</p>
          <p className={`text-sm ${s.level === "operational" ? "text-white/65" : "text-muted"}`}>Updated {updated} UTC · refreshes every 30 s</p>
        </div>
      </div>

      {/* 24h */}
      <div className="rounded-3xl border border-line bg-card p-6 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <p className="font-semibold tracking-tight">Jobs, last 24 hours</p>
          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-xs text-faint">jobs</dt>
              <dd className="font-semibold tabular-nums">{s.jobs_24h.toLocaleString("en-US")}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">succeeded</dt>
              <dd className="font-semibold tabular-nums">{s.success_24h === null ? "–" : `${s.success_24h}%`}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">median time</dt>
              <dd className="font-semibold tabular-nums">{s.p50_ms_24h === null ? "–" : `${s.p50_ms_24h} ms`}</dd>
            </div>
          </dl>
        </div>
        <div className="mt-6 flex h-14 items-end gap-[3px]" role="img" aria-label="Success rate per hour, last 24 hours">
          {s.hours.map((h) => {
            const tone = h.jobs === 0 ? "bg-black/10" : (h.rate ?? 0) >= 95 ? "bg-[#474747]" : (h.rate ?? 0) >= 60 ? "bg-amber-500" : "bg-bad";
            const height = h.jobs === 0 ? 18 : 40 + Math.min(60, Math.log10(h.jobs + 1) * 30);
            return (
              <div key={h.hour} className="group relative flex-1">
                <div className={`w-full rounded-[3px] ${tone} transition-opacity group-hover:opacity-70`} style={{ height: `${height}%`, minHeight: 6 }} />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-[#262626] px-2 py-1 text-[11px] text-white group-hover:block">
                  {h.hour.slice(11, 16)} UTC · {h.jobs ? `${h.jobs} jobs · ${h.rate}%` : "no jobs"}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between font-mono text-[10px] text-faint">
          <span>24 h ago</span>
          <span>now</span>
        </div>
      </div>

      {/* components */}
      {groups.map((g) => (
        <div key={g} className="overflow-hidden rounded-3xl border border-line bg-card">
          <p className="border-b border-line px-6 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{g}</p>
          <ul className="divide-y divide-line">
            {s.components
              .filter((c) => c.group === g)
              .map((c) => (
                <li key={c.id} className="row-hover flex flex-wrap items-center gap-x-6 gap-y-1 px-6 py-4">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.level]}`} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted">{c.detail}</p>
                  </div>
                  {c.success_1h !== null && <span className="font-mono text-xs tabular-nums text-muted">{c.success_1h}% ok</span>}
                  {c.p50_ms !== null && <span className="font-mono text-xs tabular-nums text-muted">{c.p50_ms} ms</span>}
                  <span className={`w-24 text-right text-sm font-medium ${TEXT[c.level]}`}>{LABEL[c.level]}</span>
                </li>
              ))}
          </ul>
        </div>
      ))}

      <p className="text-center text-xs text-faint">
        Machine-readable: <code className="font-mono">GET /v1/status</code>. If one provider fails, Fuel fails jobs over to the next cheapest automatically.
      </p>
    </div>
  );
}
