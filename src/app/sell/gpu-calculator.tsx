"use client";

import { useEffect, useMemo, useState } from "react";

// "What would a GPU earn me on Fuel?" Rent or buy a GPU, serve a model, sell at the price that
// wins jobs today. Presets are researched market figures (Nov 2026) and every number is
// editable; prices move daily, so check live rates before spending anything.

type Rate = { model: string; kind: string; providers: number; low: { in: number; out: number }; to_win: { in: number; out: number } };

type Preset = {
  id: string;
  label: string;
  rentHr: number; // typical on-demand $/GPU-hour
  buyUsd: number; // card (+ share of a host machine for data-centre GPUs)
  watts: number; // GPU + share of host, at the wall
  tps: number; // total tokens/s with batching (input + output), a middle estimate
  model: string; // a model this GPU can serve that's on Fuel's market
  note: string;
};

const PRESETS: Preset[] = [
  {
    id: "h100",
    label: "H100 80GB",
    rentHr: 2.33,
    buyUsd: 38000,
    watts: 1000,
    tps: 5000,
    model: "openai/gpt-oss-120b",
    note: "Rent: RunPod $1.99 community / $2.89 secure, Lambda $2.99–3.99, marketplace floor ~$0.66, median ~$2.33. Buy: ~$30–32k card + host. Throughput for gpt-oss-120b on vLLM: ~2,500–10,000 tokens/s total depending on load.",
  },
  {
    id: "rtx5090",
    label: "RTX 5090 32GB",
    rentHr: 0.6,
    buyUsd: 6500,
    watts: 750,
    tps: 2500,
    model: "Qwen/Qwen3.5-9B",
    note: "Rent: from ~$0.29/hr on marketplaces. Buy: MSRP $1,999 but selling ~$3.7–6.9k in Nov 2026. 575 W card. Serves ~8–30B models.",
  },
  {
    id: "rtx4090",
    label: "RTX 4090 24GB",
    rentHr: 0.4,
    buyUsd: 2500,
    watts: 600,
    tps: 1500,
    model: "Qwen/Qwen3.5-9B",
    note: "Rent: RunPod $0.34 community / $0.89 secure, marketplace median ~$0.40. Buy: ~$1.2–1.5k used, up to ~$5k new. 450 W card. Serves ~8–27B models.",
  },
];

const typical = (p: { in: number; out: number }) => (p.in * 3 + p.out) / 4;
const usd = (n: number, dp = 2) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const field = "w-full rounded-lg border border-line-strong bg-white/70 px-3 py-2 text-sm tabular-nums";
const HOURS_MONTH = 730;

export default function GpuCalculator() {
  const [rates, setRates] = useState<Rate[]>([]);
  const [presetId, setPresetId] = useState("h100");
  const p = PRESETS.find((x) => x.id === presetId)!;
  const [mode, setMode] = useState<"rent" | "own">("rent");
  const [v, setV] = useState({ rentHr: String(p.rentHr), buyUsd: String(p.buyUsd), watts: String(p.watts), tps: String(p.tps), years: "3", kwh: "0.15", util: "50", model: p.model });

  useEffect(() => {
    fetch("/v1/market")
      .then((r) => r.json())
      .then((j) => setRates((j.data ?? []).filter((r: Rate) => r.kind === "chat" && r.providers > 0)))
      .catch(() => {});
  }, []);

  function pick(id: string) {
    const n = PRESETS.find((x) => x.id === id)!;
    setPresetId(id);
    setV({ ...v, rentHr: String(n.rentHr), buyUsd: String(n.buyUsd), watts: String(n.watts), tps: String(n.tps), model: n.model });
  }

  const r = useMemo(() => {
    const rate = rates.find((x) => x.model === v.model);
    const win = rate ? typical(rate.to_win) : null; // $/1M you'd charge to be the cheapest
    const tps = Number(v.tps);
    const util = Math.min(100, Math.max(0, Number(v.util))) / 100;
    const powerHr = (Number(v.watts) / 1000) * Number(v.kwh);
    const ownHr = Number(v.buyUsd) / (Math.max(0.5, Number(v.years)) * 8760) + powerHr; // depreciation + power, every hour
    const costHr = mode === "rent" ? Number(v.rentHr) : ownHr;
    const mtokHr = (tps * 3600) / 1e6;
    const revFull = win === null ? null : mtokHr * win;
    const rev = revFull === null ? null : revFull * util;
    // Renting: you pay only while the GPU is on (assume on all month). Owning: costs run regardless.
    const profitHr = rev === null ? null : rev - costHr;
    const breakEvenUtil = revFull ? costHr / revFull : null;
    const costPerM = mtokHr > 0 ? costHr / (mtokHr * Math.max(util, 0.01)) : null;
    // Owning: months of (earnings − power) to recover the purchase price.
    const paybackMonths = mode === "own" && rev !== null && rev - powerHr > 0 ? Number(v.buyUsd) / ((rev - powerHr) * HOURS_MONTH) : null;
    return { win, mtokHr, revFull, rev, costHr, profitHr, breakEvenUtil, costPerM, powerHr, paybackMonths };
  }, [rates, v, mode]);

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });

  return (
    <section id="gpu-calculator" className="scroll-mt-24 rounded-3xl border border-line bg-card p-6 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">GPU calculator</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight">What would a GPU earn on Fuel?</h2>
          <p className="mt-2 text-sm text-muted">Rent or buy a GPU, serve a model, and sell at the price that wins jobs today. Every number is editable.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-white/40 p-1 text-sm">
          {PRESETS.map((x) => (
            <button key={x.id} onClick={() => pick(x.id)} className={`rounded-md px-3 py-1.5 ${presetId === x.id ? "bg-white/90 font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <div className="flex gap-1 rounded-lg bg-white/40 p-1 text-sm">
            {(["rent", "own"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`flex-1 rounded-md px-3 py-1.5 ${mode === m ? "bg-white/90 font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
                {m === "rent" ? "Rent it" : "Buy it"}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === "rent" ? (
              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="text-faint">Rental price (USD per GPU-hour)</span>
                <input className={field} inputMode="decimal" value={v.rentHr} onChange={set("rentHr")} />
              </label>
            ) : (
              <>
                <label className="space-y-1 text-xs">
                  <span className="text-faint">Purchase price (USD, incl. host share)</span>
                  <input className={field} inputMode="decimal" value={v.buyUsd} onChange={set("buyUsd")} />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-faint">Write it off over (years)</span>
                  <input className={field} inputMode="decimal" value={v.years} onChange={set("years")} />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-faint">Power at the wall (watts)</span>
                  <input className={field} inputMode="decimal" value={v.watts} onChange={set("watts")} />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-faint">Electricity (USD per kWh)</span>
                  <input className={field} inputMode="decimal" value={v.kwh} onChange={set("kwh")} />
                </label>
              </>
            )}
            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="text-faint">Model you&apos;d serve (live price to beat on Fuel)</span>
              <select className={field} value={v.model} onChange={set("model")}>
                {(rates.length ? rates : [{ model: v.model } as Rate]).map((x) => (
                  <option key={x.model} value={x.model}>
                    {x.model}
                    {x.to_win ? ` · win at ${usd(typical(x.to_win), 3)} / 1M` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-faint">Throughput (tokens/s, all users)</span>
              <input className={field} inputMode="numeric" value={v.tps} onChange={set("tps")} />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-faint">Busy (% of hours with jobs)</span>
              <input className={field} inputMode="numeric" value={v.util} onChange={set("util")} />
            </label>
          </div>
          <p className="text-xs leading-relaxed text-faint">{p.note}</p>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {[
              ["Costs you", `${usd(r.costHr)}/hr`, mode === "own" ? `write-off + ${usd(r.powerHr)}/hr power` : "rental, while it's on"],
              ["Earns at full load", r.revFull === null ? "–" : `${usd(r.revFull)}/hr`, `${r.mtokHr.toFixed(1)}M tokens/hr × ${r.win ? usd(r.win, 3) : "–"}/1M`],
              ["Earns at your load", r.rev === null ? "–" : `${usd(r.rev)}/hr`, `${v.util}% busy`],
              ["Your cost per 1M", r.costPerM === null ? "–" : usd(r.costPerM, 3), r.win ? `market: ${usd(r.win, 3)}` : ""],
            ].map(([k, val, h]) => (
              <div key={k} className="rounded-xl bg-white/50 p-4">
                <p className="text-[11px] uppercase tracking-wider text-faint">{k}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{val}</p>
                <p className="mt-0.5 text-[11px] text-muted">{h}</p>
              </div>
            ))}
          </div>
          <div className={`rounded-2xl p-5 ${r.profitHr !== null && r.profitHr >= 0 ? "bg-[#474747] text-white" : "border border-bad/30 bg-bad/5"}`}>
            <p className={`text-xs ${r.profitHr !== null && r.profitHr >= 0 ? "text-white/60" : "text-bad"}`}>Per month (730 hours)</p>
            <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight">{r.profitHr === null ? "–" : `${r.profitHr >= 0 ? "+" : ""}${usd(r.profitHr * HOURS_MONTH, 0)}`}</p>
            <p className={`mt-2 text-sm ${r.profitHr !== null && r.profitHr >= 0 ? "text-white/70" : "text-muted"}`}>
              {r.breakEvenUtil === null
                ? "Pick a model with a live price."
                : r.breakEvenUtil > 1
                  ? "Loses money even at 100% busy: this GPU can't serve this model cheaply enough. Try another model, more throughput, or a cheaper GPU."
                  : `Breaks even at ${Math.round(r.breakEvenUtil * 100)}% busy.`}
              {r.paybackMonths !== null && r.paybackMonths > 0 && r.paybackMonths < 600 && ` Pays for itself in about ${Math.round(r.paybackMonths)} months.`}
            </p>
          </div>
          <p className="text-xs text-muted">
            You&apos;re only sent jobs when you&apos;re the cheapest healthy option, and how busy you are depends on how many agents use Fuel. Start by renting by the hour, watch
            real demand, then decide whether to buy.
          </p>
        </div>
      </div>
    </section>
  );
}
