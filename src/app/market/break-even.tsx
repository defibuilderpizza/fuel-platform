"use client";

import { useState } from "react";
import type { Rate } from "@/lib/market";

// Break-even price for a GPU seller: hourly cost ÷ tokens produced per hour (at the utilisation
// you expect), compared against the live price for a model.

const usd = (n: number) => (!Number.isFinite(n) ? "—" : n < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export default function BreakEven({ rates }: { rates: Rate[] }) {
  const chat = rates.filter((r) => r.kind === "chat");
  // Default to a mainstream model rather than the cheapest tiny one.
  const [model, setModel] = useState(chat.find((r) => r.model === "openai/gpt-oss-120b")?.model ?? chat[Math.floor(chat.length / 2)]?.model ?? "");
  const [hourly, setHourly] = useState("2.00");
  const [tps, setTps] = useState("6000");
  const [util, setUtil] = useState("70");
  const [outShare, setOutShare] = useState("25");

  const h = Number(hourly);
  const t = Number(tps);
  const u = Math.min(Math.max(Number(util), 1), 100) / 100;
  const tokensPerHour = t * 3600 * u;
  const costPerM = tokensPerHour > 0 ? (h / tokensPerHour) * 1_000_000 : NaN;
  const rate = chat.find((r) => r.model === model);
  // The market's blended price for the same mix of input and output tokens.
  const o = Math.min(Math.max(Number(outShare), 0), 100) / 100;
  const blended = rate ? rate.low.in * (1 - o) + rate.low.out * o : NaN;
  const margin = blended - costPerM;
  const field = "mt-1 w-full rounded-lg border border-line-strong bg-white/70 px-3 py-2 text-sm tabular-nums";

  return (
    <div className="space-y-5 rounded-2xl border border-line bg-card p-5 sm:p-7">
      <div>
        <p className="font-semibold">Break-even calculator</p>
        <p className="mt-1 text-sm text-muted">What does a million tokens cost you to serve, and how does that compare with the market?</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted">GPU cost per hour (USD)</span>
          <input inputMode="decimal" value={hourly} onChange={(e) => setHourly(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Throughput (tokens / second, all requests)</span>
          <input inputMode="numeric" value={tps} onChange={(e) => setTps(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Expected utilisation (%)</span>
          <input inputMode="numeric" value={util} onChange={(e) => setUtil(e.target.value)} className={field} />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Share of tokens that are output (%)</span>
          <input inputMode="numeric" value={outShare} onChange={(e) => setOutShare(e.target.value)} className={field} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-muted">Compare with model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={field}>
            {chat.map((r) => (
              <option key={r.model} value={r.model}>
                {r.model}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-white/60 p-4">
          <p className="text-xs text-faint">Your cost per 1M tokens</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{usd(costPerM)}</p>
        </div>
        <div className="rounded-xl border border-line bg-white/60 p-4">
          <p className="text-xs text-faint">Market price to beat (same mix)</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{usd(blended)}</p>
        </div>
        <div className="rounded-xl border border-line bg-white/60 p-4">
          <p className="text-xs text-faint">Room per 1M tokens</p>
          <p className={`mt-1 text-xl font-semibold tabular-nums ${margin > 0 ? "text-ok" : "text-bad"}`}>{Number.isFinite(margin) ? (margin >= 0 ? usd(margin) : `−${usd(-margin)}`) : "—"}</p>
        </div>
      </div>
      {rate && Number.isFinite(costPerM) && (
        <p className="text-sm">
          {margin > 0 ? (
            <>
              You can undercut today&apos;s cheapest route and still make money. Try{" "}
              <span className="font-semibold">
                {usd(Math.max(costPerM * 1.15, rate.to_win.in))} in / {usd(Math.max(costPerM * 1.15, rate.to_win.out))} out
              </span>{" "}
              per 1M tokens, then adjust.
            </>
          ) : (
            <>Your cost is above what this model sells for today. Raise throughput or utilisation, use a cheaper GPU, or pick a model where you have an edge.</>
          )}
        </p>
      )}
      <p className="text-xs text-muted">
        Throughput is total tokens per second across all concurrent requests (with batching, often thousands for small models on one GPU). Prices are USD per 1M tokens.
      </p>
    </div>
  );
}
