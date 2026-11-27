"use client";

import { useState } from "react";

// Mark a seller listing as Fuel's own GPU and record what it costs (e.g. a prepaid rental).

export default function FuelOperatedForm({
  s,
  save,
}: {
  s: { operated_by_fuel: boolean; locked_cost_hr: number | null; locked_tps: number | null; locked_until: string | null };
  save: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(s.operated_by_fuel);
  const [cost, setCost] = useState(s.locked_cost_hr?.toString() ?? "");
  const [tps, setTps] = useState(s.locked_tps?.toString() ?? "");
  const [until, setUntil] = useState(s.locked_until?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);
  const field = "w-full rounded-lg border border-line-strong bg-white/80 px-2 py-1.5 text-sm";

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline">
        {s.operated_by_fuel ? "Edit Fuel-operated details" : "This is Fuel's own GPU…"}
      </button>
    );
  }
  return (
    <form
      className="mt-4 space-y-3 rounded-xl bg-white/50 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await save({
            action: "fuel_operated",
            operated_by_fuel: on,
            locked_cost_hr: cost === "" ? null : Number(cost),
            locked_tps: tps === "" ? null : Number(tps),
            locked_until: until || null,
          });
          setOpen(false);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        Operated by Fuel (labelled publicly, no contracts, no bond or premium)
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs">
          <span className="text-faint">Locked cost (USD / hour)</span>
          <input className={field} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.28" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-faint">Throughput (tokens/s)</span>
          <input className={field} inputMode="numeric" value={tps} onChange={(e) => setTps(e.target.value)} placeholder="1500" />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-faint">Locked until</span>
          <input type="date" className={field} value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      </div>
      <div className="flex gap-2">
        <button disabled={busy} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-50">
          Save
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2">
          Cancel
        </button>
      </div>
    </form>
  );
}
