"use client";

import { useMemo, useState } from "react";
import type { Rate } from "@/lib/market";

const usd = (n: number) => (n === 0 ? "$0" : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const ctx = (n: number | null) => (!n ? "—" : n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export default function MarketTable({ rates }: { rates: Rate[] }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "chat" | "embedding">("all");
  const rows = useMemo(
    () => rates.filter((r) => (kind === "all" || r.kind === kind) && r.model.toLowerCase().includes(q.trim().toLowerCase())),
    [rates, q, kind],
  );
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-3 sm:px-5">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" aria-label="Search models" className="w-full max-w-xs rounded-lg border border-line-strong bg-white/70 px-3 py-1.5 text-sm" />
        <div role="tablist" className="flex gap-1 text-sm">
          {(["all", "chat", "embedding"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`rounded-md px-2.5 py-1 capitalize ${kind === k ? "bg-white/80 font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px] sm:min-w-[760px] sm:text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-faint">
            <tr className="border-b border-line">
              <th className="px-3 py-2.5 font-medium sm:px-5 sm:py-3">Model</th>
              <th className="hidden px-3 py-3 font-medium sm:table-cell">Type</th>
              <th className="px-2 py-2.5 text-right font-medium sm:px-3 sm:py-3">Agents pay<span className="hidden sm:inline"> · in / out</span></th>
              <th className="px-3 py-2.5 text-right font-medium sm:py-3"><span className="sm:hidden">To beat</span><span className="hidden sm:inline">Seller price to beat</span></th>
              <th className="hidden px-3 py-3 text-right font-medium sm:table-cell">Providers</th>
              <th className="hidden px-5 py-3 text-right font-medium sm:table-cell">Context</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const lane = r.model.startsWith("fuel-lane/");
              return (
                <tr key={r.model} className="row-hover">
                  <td className="max-w-[140px] truncate px-3 py-2 font-mono text-[11px] sm:max-w-[280px] sm:px-5 sm:py-3 sm:text-xs" title={r.model}>
                    {r.model}
                  </td>
                  <td className="hidden px-3 py-3 text-muted sm:table-cell">{r.kind}</td>
                  <td className="px-2 py-2 text-right tabular-nums sm:px-3 sm:py-3">
                    <span className="font-semibold">{usd(r.agent_price.in)}</span>
                    {r.kind === "chat" && <span className="text-muted"> / {usd(r.agent_price.out)}</span>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums sm:px-3 sm:py-3">
                    {lane ? (
                      <span className="text-xs text-muted">laptop lane · fixed</span>
                    ) : (
                      <>
                        {usd(r.low.in)}
                        {r.kind === "chat" && <span className="text-muted"> / {usd(r.low.out)}</span>}
                      </>
                    )}
                  </td>
                  <td className="hidden px-3 py-3 text-right tabular-nums sm:table-cell">
                    {lane ? "laptops" : r.providers}
                    {r.sellers > 0 && <span className="ml-1 text-xs text-muted">({r.sellers} seller{r.sellers > 1 ? "s" : ""})</span>}
                    {r.fuel_operated > 0 && (
                      <span className="ml-1 rounded bg-black/10 px-1 py-0.5 text-[10px] font-medium text-muted" title="Fuel also runs this model on its own GPU, for compute-credit holders only. It isn't in these prices and never competes with sellers.">
                        + Fuel credits capacity
                      </span>
                    )}
                  </td>
                  <td className="hidden px-5 py-3 text-right tabular-nums text-muted sm:table-cell">{ctx(r.context)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-muted">
                  No models match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-5 py-3 text-xs text-muted">USD per 1M tokens. Agents pay the cheapest healthy route plus Fuel&apos;s margin; the seller price to beat is that route&apos;s own price. Also available as JSON at /v1/market.</p>
    </div>
  );
}
