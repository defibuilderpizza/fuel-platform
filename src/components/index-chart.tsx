"use client";

import { useMemo, useRef, useState } from "react";

type Pt = { at: string; level: number; median_usd: number; models: number };

// Area chart of the Fuel Compute Index with a hover crosshair. A flat or single-point
// series still draws (as a level line), so the chart works from the index's first day.

const pad = { l: 8, r: 52, t: 14, b: 26 };

export default function IndexChart({ series, height = 220 }: { series: Pt[]; height?: number }) {
  const W = 760;
  const H = height;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const pts = series.length === 1 ? [series[0], { ...series[0], at: new Date(Date.parse(series[0].at) + 60_000).toISOString() }] : series;
    const t0 = Date.parse(pts[0].at);
    const t1 = Date.parse(pts[pts.length - 1].at);
    const lo = Math.min(...pts.map((p) => p.level));
    const hi = Math.max(...pts.map((p) => p.level));
    const span = Math.max(hi - lo, Math.max(hi, 1) * 0.02); // at least ±1% so flat lines sit mid-chart
    const y0 = lo - span * 0.25;
    const y1 = hi + span * 0.25;
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    const xy = pts.map((p) => [x(Date.parse(p.at)), y(p.level)] as const);
    const line = xy.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join(" ");
    const area = `${line} L${xy[xy.length - 1][0].toFixed(1)} ${H - pad.b} L${xy[0][0].toFixed(1)} ${H - pad.b} Z`;
    const ticks = [y0 + (y1 - y0) * 0.2, (y0 + y1) / 2, y0 + (y1 - y0) * 0.8];
    const days = (t1 - t0) / 86_400_000;
    const fmtT = (t: number) =>
      days > 2 ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : new Date(t).toISOString().slice(11, 16);
    return { pts, xy, line, area, ticks, y, t0, t1, fmtT };
  }, [series, H]);

  function onMove(e: React.PointerEvent) {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    geo.xy.forEach(([a], i) => {
      if (Math.abs(a - px) < Math.abs(geo.xy[best][0] - px)) best = i;
    });
    setHover(best);
  }

  const h = hover === null ? null : geo.pts[Math.min(hover, geo.pts.length - 1)];
  const hx = hover === null ? 0 : geo.xy[hover][0];
  const hy = hover === null ? 0 : geo.xy[hover][1];

  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Fuel Compute Index over time">
        <defs>
          <linearGradient id="fciArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#474747" stopOpacity="0.28" />
            <stop offset="1" stopColor="#474747" stopOpacity="0" />
          </linearGradient>
        </defs>
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={geo.y(v)} y2={geo.y(v)} stroke="rgba(0,0,0,0.07)" />
            <text x={W - pad.r + 8} y={geo.y(v) + 3.5} fontSize={10.5} fontFamily="var(--font-geist-mono), monospace" fill="#6c6c6c">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="rgba(0,0,0,0.12)" />
        <path d={geo.area} fill="url(#fciArea)" />
        <path d={geo.line} fill="none" stroke="#262626" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={geo.xy[geo.xy.length - 1][0]} cy={geo.xy[geo.xy.length - 1][1]} r={4} fill="#262626" />
        <circle cx={geo.xy[geo.xy.length - 1][0]} cy={geo.xy[geo.xy.length - 1][1]} r={8} fill="#262626" opacity={0.15} className="blink" />
        <text x={pad.l} y={H - 8} fontSize={10.5} fontFamily="var(--font-geist-mono), monospace" fill="#6c6c6c">
          {geo.fmtT(geo.t0)}
        </text>
        <text x={W - pad.r} y={H - 8} textAnchor="end" fontSize={10.5} fontFamily="var(--font-geist-mono), monospace" fill="#6c6c6c">
          {series.length === 1 ? "started" : geo.fmtT(geo.t1)}
        </text>
        {h && (
          <g>
            <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} stroke="rgba(0,0,0,0.25)" strokeDasharray="3 3" />
            <circle cx={hx} cy={hy} r={4.5} fill="#fff" stroke="#262626" strokeWidth={1.8} />
          </g>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-0 rounded-lg bg-[#262626] px-2.5 py-1.5 text-[11px] text-white shadow-lg"
          style={{ left: `${(hx / W) * 100}%`, transform: `translateX(${hx / W > 0.7 ? "-105%" : "8px"})` }}
        >
          <p className="font-semibold tabular-nums">{h.level.toFixed(2)}</p>
          <p className="text-white/70 tabular-nums">
            ${h.median_usd.toFixed(4)} / 1M · {h.models} models
          </p>
          <p className="text-white/50">{new Date(h.at).toISOString().replace("T", " ").slice(0, 16)} UTC</p>
        </div>
      )}
    </div>
  );
}
