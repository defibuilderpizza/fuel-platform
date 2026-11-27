"use client";

import { useEffect, useState } from "react";

// A progress bar for a running request. Fuel can't see inside a model while it works, so the
// bar is time-based: it eases toward 95% over the model's typical run time and only shows 100%
// when the result is back. The label says what's actually happening (queued, working, elapsed).

export default function Progress({ startedAt, typicalSeconds, done, label }: { startedAt: number | null; typicalSeconds: number; done: boolean; label?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null || done) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt, done]);
  if (startedAt === null) return null;

  const elapsed = Math.max(0, (now - startedAt) / 1000);
  // 63% at the typical time, 86% at twice it, never past 95% until it's done.
  const pct = done ? 100 : Math.min(95, 95 * (1 - Math.exp(-elapsed / Math.max(1, typicalSeconds))));
  const over = !done && elapsed > typicalSeconds * 1.5;
  const fmt = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

  return (
    <div className="space-y-1.5" aria-live="polite">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Request progress" className="h-2 w-full overflow-hidden rounded-full bg-black/10">
        <div className={`h-full rounded-full bg-accent transition-[width] duration-300 ease-out ${done ? "" : "animate-pulse"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="flex justify-between gap-3 text-xs text-muted">
        <span>{done ? "Done" : (label ?? "Working…")}</span>
        <span className="tabular-nums">
          {fmt(elapsed)}
          {!done && ` · usually ~${fmt(typicalSeconds)}`}
          {over && " · taking longer than usual"}
        </span>
      </p>
    </div>
  );
}
