// Explanatory diagrams. Flat, in the five greys, sized to read on a phone (the wide ones
// switch to a vertical layout under the sm breakpoint).

const mono = "var(--font-geist-mono), ui-monospace, monospace";
const sans = "var(--font-inter), ui-sans-serif, sans-serif";

// ── A job's path, request to receipt ───────────────────────────────────────
const STEPS = [
  { k: "Request", t: "Agent calls the API", d: "POST /v1/chat/completions", icon: "req" },
  { k: "Hold", t: "Price is held", d: "hold $0.0004 of balance", icon: "hold" },
  { k: "Route", t: "Cheapest healthy provider", d: "together · $0.16 / 1M", icon: "route" },
  { k: "Run", t: "Job runs, streams back", d: "897 ms · failover ready", icon: "run" },
  { k: "Settle", t: "Exact cost charged", d: "charged $0.000044", icon: "settle" },
] as const;

function StepIcon({ kind }: { kind: (typeof STEPS)[number]["icon"] }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      {kind === "req" && <path {...s} d="M4 6h16v10H8l-4 4zM8 10h8M8 13h5" />}
      {kind === "hold" && <path {...s} d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5zM12 15v2" />}
      {kind === "route" && <path {...s} d="M4 12h5c3 0 3-6 6-6h5M9 12c3 0 3 6 6 6h5M17 3l3 3-3 3M17 15l3 3-3 3" />}
      {kind === "run" && <path {...s} d="M13 3 6 13h5l-1 8 7-10h-5z" />}
      {kind === "settle" && <path {...s} d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />}
    </svg>
  );
}

export function JobFlow() {
  return (
    <div className="relative">
      {/* connector rail with a travelling packet */}
      <div aria-hidden className="absolute left-[10%] right-[10%] top-7 hidden h-px bg-black/15 sm:block">
        <span className="packet absolute -top-[3px] h-[7px] w-[7px] rounded-full bg-[#262626] shadow-[0_0_0_4px_rgba(38,38,38,0.12)]" />
      </div>
      <div aria-hidden className="absolute bottom-6 left-7 top-6 w-px bg-black/15 sm:hidden" />
      <ol className="relative grid gap-5 sm:grid-cols-5 sm:gap-3">
        {STEPS.map((s, i) => (
          <li key={s.k} className="flex gap-4 sm:flex-col sm:items-center sm:gap-0 sm:text-center">
            <span className="relative z-10 grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-white/80 bg-card text-ink shadow-sm">
              <StepIcon kind={s.icon} />
              <span className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-accent font-mono text-[10px] text-white">{i + 1}</span>
            </span>
            <div className="sm:mt-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{s.k}</p>
              <p className="mt-0.5 font-semibold tracking-tight">{s.t}</p>
              <p className="mt-1 inline-block rounded-md bg-white/60 px-1.5 py-0.5 font-mono text-[11px] text-muted">{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Where an agent's dollar goes ────────────────────────────────────────────
export function MoneyFlow({ markupPct }: { markupPct: number }) {
  const paid = 1 + markupPct / 100;
  const sellerH = 150;
  const fuelH = Math.max(10, (sellerH * markupPct) / 100);
  const total = sellerH + fuelH;
  const y0 = 40;
  return (
    <svg viewBox="0 0 640 250" className="h-auto w-full" role="img" aria-label={`An agent pays $${paid.toFixed(2)}; the seller gets $1.00, their own price; Fuel keeps $${(paid - 1).toFixed(2)}.`}>
      <defs>
        <linearGradient id="mfSeller" x1="0" x2="1">
          <stop offset="0" stopColor="#474747" stopOpacity="0.85" />
          <stop offset="1" stopColor="#6c6c6c" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="mfFuel" x1="0" x2="1">
          <stop offset="0" stopColor="#474747" stopOpacity="0.5" />
          <stop offset="1" stopColor="#9b9b9b" stopOpacity="0.6" />
        </linearGradient>
      </defs>
      {/* source bar */}
      <rect x={150} y={y0} width={14} height={total} rx={3} fill="#262626" />
      <text x={136} y={y0 + total / 2 - 8} textAnchor="end" fontSize={13} fontWeight={600} fontFamily={sans} fill="#262626">
        Agent pays
      </text>
      <text x={136} y={y0 + total / 2 + 12} textAnchor="end" fontSize={20} fontWeight={700} fontFamily={sans} fill="#262626">
        ${paid.toFixed(2)}
      </text>
      {/* bands */}
      <path d={`M164 ${y0} C 320 ${y0}, 320 ${y0 + 4}, 470 ${y0 + 4} L 470 ${y0 + 4 + sellerH} C 320 ${y0 + 4 + sellerH}, 320 ${y0 + sellerH}, 164 ${y0 + sellerH} Z`} fill="url(#mfSeller)" />
      <path d={`M164 ${y0 + sellerH} C 320 ${y0 + sellerH}, 320 ${y0 + sellerH + 34}, 470 ${y0 + sellerH + 34} L 470 ${y0 + sellerH + 34 + fuelH} C 320 ${y0 + sellerH + 34 + fuelH}, 320 ${y0 + total}, 164 ${y0 + total} Z`} fill="url(#mfFuel)" />
      {/* sinks */}
      <rect x={470} y={y0 + 4} width={14} height={sellerH} rx={3} fill="#474747" />
      <rect x={470} y={y0 + sellerH + 34} width={14} height={fuelH} rx={3} fill="#9b9b9b" />
      <text x={498} y={y0 + 4 + sellerH / 2 - 8} fontSize={13} fontWeight={600} fontFamily={sans} fill="#262626">
        Seller
      </text>
      <text x={498} y={y0 + 4 + sellerH / 2 + 12} fontSize={20} fontWeight={700} fontFamily={sans} fill="#262626">
        $1.00
      </text>
      <text x={498} y={y0 + 4 + sellerH / 2 + 30} fontSize={11} fontFamily={mono} fill="#6c6c6c">
        their own price
      </text>
      <text x={498} y={y0 + sellerH + 34 + fuelH / 2 + 4} fontSize={12} fontFamily={sans} fill="#4a4a4a">
        <tspan fontWeight={600} fill="#262626">
          Fuel ${(paid - 1).toFixed(2)}
        </tspan>{" "}
        · {markupPct}% on top
      </text>
      <text x={317} y={y0 + sellerH / 2 + 8} textAnchor="middle" fontSize={11} fontFamily={mono} fill="rgba(255,255,255,0.85)">
        per job, to their balance
      </text>
    </svg>
  );
}

// ── Laptop lane: how a result is checked before anyone is paid ─────────────
export function LaneVerify({ share }: { share: number }) {
  const box = (x: number, y: number, w: number, h: number, dark = false) => (
    <rect x={x} y={y} width={w} height={h} rx={12} fill={dark ? "#474747" : "rgba(255,255,255,0.85)"} stroke={dark ? "none" : "rgba(0,0,0,0.1)"} />
  );
  const label = (x: number, y: number, top: string, main: string, dark = false) => (
    <>
      <text x={x} y={y} textAnchor="middle" fontSize={9.5} letterSpacing={1.2} fontFamily={mono} fill={dark ? "rgba(255,255,255,0.6)" : "#6c6c6c"}>
        {top}
      </text>
      <text x={x} y={y + 18} textAnchor="middle" fontSize={13} fontWeight={600} fontFamily={sans} fill={dark ? "#fff" : "#262626"}>
        {main}
      </text>
    </>
  );
  const laptop = (cx: number, cy: number) => (
    <g transform={`translate(${cx - 22} ${cy - 16})`}>
      <rect x={6} y={0} width={32} height={21} rx={2.5} fill="#474747" />
      <rect x={9} y={3} width={26} height={15} rx={1} fill="#6c6c6c" />
      <path d="M0 24 h44 l-4 5 h-36 z" fill="#9b9b9b" />
    </g>
  );
  return (
    <svg viewBox="0 0 640 260" className="h-auto w-full" role="img" aria-label="Each task goes, encrypted, to two laptops. Results are compared, with hidden test inputs mixed in; only matching results are paid.">
      {/* task */}
      {box(10, 98, 120, 64)}
      {label(70, 122, "TASK", "Encrypted job")}
      {/* paths */}
      {[70, 190].map((y) => (
        <g key={y}>
          <path d={`M130 130 C 170 130, 170 ${y}, 210 ${y}`} fill="none" stroke="#9b9b9b" strokeWidth={1.4} />
          <path d={`M130 130 C 170 130, 170 ${y}, 210 ${y}`} fill="none" stroke="#262626" strokeWidth={1.4} className="flow" />
          <path d={`M350 ${y} C 390 ${y}, 390 130, 430 130`} fill="none" stroke="#9b9b9b" strokeWidth={1.4} />
        </g>
      ))}
      {/* laptops */}
      {[
        [70, "Laptop A"],
        [190, "Laptop B"],
      ].map(([y, n]) => (
        <g key={n as string}>
          {box(210, (y as number) - 34, 140, 68)}
          {laptop(240, y as number)}
          <text x={270} y={(y as number) - 2} fontSize={13} fontWeight={600} fontFamily={sans} fill="#262626">
            {n}
          </text>
          <text x={270} y={(y as number) + 15} fontSize={9.5} fontFamily={mono} fill="#6c6c6c">
            runs locally
          </text>
        </g>
      ))}
      {/* canary */}
      <g>
        <rect x={214} y={118} width={132} height={24} rx={12} fill="rgba(255,255,255,0.6)" stroke="rgba(0,0,0,0.15)" strokeDasharray="3 3" />
        <text x={280} y={134} textAnchor="middle" fontSize={10} fontFamily={mono} fill="#4a4a4a">
          + hidden test inputs
        </text>
      </g>
      {/* compare */}
      {box(430, 98, 92, 64, true)}
      {label(476, 122, "COMPARE", "Match ✓", true)}
      <path d="M522 130 H 548" stroke="#262626" strokeWidth={1.4} markerEnd="url(#lvArrow)" />
      <defs>
        <marker id="lvArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="#262626" />
        </marker>
      </defs>
      {box(552, 98, 80, 64)}
      {label(592, 122, "PAID", `${share}%`)}
    </svg>
  );
}

// ── Team structure: you, your team, your agents and their limits ───────────
export function TeamDiagram() {
  const agents = [
    { n: "research-bot", spent: 3.1, limit: 5 },
    { n: "support-bot", spent: 1.2, limit: 4 },
    { n: "scraper", spent: 0.4, limit: 2 },
  ];
  return (
    <svg viewBox="0 0 520 300" className="h-auto w-full" role="img" aria-label="An owner and admins fund one team; each agent in it has its own wallet and daily limit.">
      {/* people */}
      {[
        [60, "Owner"],
        [160, "Admin"],
      ].map(([x, r]) => (
        <g key={r as string}>
          <circle cx={x as number} cy={40} r={20} fill="rgba(255,255,255,0.85)" stroke="rgba(0,0,0,0.12)" />
          <circle cx={x as number} cy={35} r={6} fill="#6c6c6c" />
          <path d={`M${(x as number) - 10} 52 a10 8 0 0 1 20 0`} fill="#6c6c6c" />
          <text x={x as number} y={76} textAnchor="middle" fontSize={11} fontFamily={mono} fill="#4a4a4a">
            {r}
          </text>
        </g>
      ))}
      <path d="M60 84 C 60 104, 110 104, 110 118 M160 84 C 160 104, 110 104, 110 118" fill="none" stroke="#9b9b9b" strokeWidth={1.3} />
      {/* team */}
      <rect x={30} y={118} width={160} height={58} rx={14} fill="#474747" />
      <text x={110} y={142} textAnchor="middle" fontSize={9.5} letterSpacing={1.2} fontFamily={mono} fill="rgba(255,255,255,0.6)">
        TEAM
      </text>
      <text x={110} y={162} textAnchor="middle" fontSize={14} fontWeight={600} fontFamily={sans} fill="#fff">
        Acme agents
      </text>
      {/* agents */}
      {agents.map((a, i) => {
        const y = 30 + i * 92;
        const pct = a.spent / a.limit;
        return (
          <g key={a.n}>
            <path d={`M190 147 C 240 147, 240 ${y + 34}, 290 ${y + 34}`} fill="none" stroke="#9b9b9b" strokeWidth={1.3} />
            <path d={`M190 147 C 240 147, 240 ${y + 34}, 290 ${y + 34}`} fill="none" stroke="#262626" strokeWidth={1.3} className="flow" />
            <rect x={290} y={y} width={220} height={68} rx={12} fill="rgba(255,255,255,0.85)" stroke="rgba(0,0,0,0.1)" />
            <text x={306} y={y + 24} fontSize={13} fontWeight={600} fontFamily={sans} fill="#262626">
              {a.n}
            </text>
            <text x={494} y={y + 24} textAnchor="end" fontSize={11} fontFamily={mono} fill="#4a4a4a">
              ${a.spent.toFixed(2)} / ${a.limit}
            </text>
            <rect x={306} y={y + 38} width={188} height={6} rx={3} fill="rgba(0,0,0,0.08)" />
            <rect x={306} y={y + 38} width={188 * pct} height={6} rx={3} fill={pct > 0.6 ? "#474747" : "#6c6c6c"} />
            <text x={306} y={y + 58} fontSize={9.5} fontFamily={mono} fill="#6c6c6c">
              own wallet · daily limit
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── How Fuel fits together (docs) ───────────────────────────────────────────
export function Architecture() {
  const node = (x: number, y: number, w: number, h: number, top: string, main: string, sub?: string, dark = false) => (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} fill={dark ? "#474747" : "rgba(255,255,255,0.88)"} stroke={dark ? "none" : "rgba(0,0,0,0.1)"} />
      <text x={x + 14} y={y + 20} fontSize={9} letterSpacing={1.2} fontFamily={mono} fill={dark ? "rgba(255,255,255,0.6)" : "#6c6c6c"}>
        {top}
      </text>
      <text x={x + 14} y={y + 39} fontSize={13} fontWeight={600} fontFamily={sans} fill={dark ? "#fff" : "#262626"}>
        {main}
      </text>
      {sub && (
        <text x={x + 14} y={y + 56} fontSize={10} fontFamily={mono} fill={dark ? "rgba(255,255,255,0.7)" : "#6c6c6c"}>
          {sub}
        </text>
      )}
    </g>
  );
  const wire = (d: string, live = false) => (
    <g>
      <path d={d} fill="none" stroke="#9b9b9b" strokeWidth={1.3} />
      {live && <path d={d} fill="none" stroke="#262626" strokeWidth={1.3} className="flow" />}
    </g>
  );
  return (
    <svg viewBox="0 0 760 300" className="h-auto w-full" role="img" aria-label="Agents call Fuel's OpenAI-compatible API; Fuel checks the key and balance, routes to providers, GPU sellers or the laptop lane, and records a receipt. Deposits arrive from Solana.">
      {node(10, 40, 170, 70, "CLIENT", "Agent / OpenAI SDK", "base_url = fuel/v1")}
      {node(10, 190, 170, 70, "DEPOSITS", "USDC · SOL · USDG", "Solana · Robinhood Chain")}
      {wire("M180 75 H 260", true)}
      {wire("M180 225 C 220 225, 220 190, 260 190")}
      {/* fuel core */}
      <rect x={260} y={30} width={240} height={240} rx={18} fill="rgba(255,255,255,0.4)" stroke="rgba(0,0,0,0.12)" />
      <text x={276} y={54} fontSize={9.5} letterSpacing={1.2} fontFamily={mono} fill="#6c6c6c">
        FUEL
      </text>
      {node(276, 66, 208, 50, "1", "Key + balance check", undefined, true)}
      {node(276, 126, 208, 50, "2", "Router · cheapest healthy", undefined, true)}
      {node(276, 186, 208, 70, "3", "Ledger + receipt", "hold → settle, exact cost", true)}
      {/* providers */}
      {[
        [30, "PROVIDER", "Hosted APIs", "together, …"],
        [118, "SELLERS", "GPU endpoints", "their own price"],
        [206, "LAPTOP LANE", "Browser tabs", "cross-checked"],
      ].map(([y, t, m, s], i) => (
        <g key={t as string}>
          {wire(`M500 151 C 540 151, 540 ${(y as number) + 35}, 580 ${(y as number) + 35}`, i === 0)}
          {node(580, y as number, 170, 70, t as string, m as string, s as string)}
        </g>
      ))}
    </svg>
  );
}

// ── Market price chart (blended cost of a typical 3:1 job) ─────────────────
export function PriceChart({ rows }: { rows: { model: string; price: number; sellers: number }[] }) {
  const data = rows.slice(0, 14);
  if (data.length === 0) return null;
  const W = 720;
  const rowH = 26;
  const left = 230;
  const right = 70;
  const top = 26;
  const H = top + data.length * rowH + 12;
  const min = Math.min(...data.map((d) => d.price));
  const max = Math.max(...data.map((d) => d.price));
  // log scale so a $0.05 and a $5 model are both readable
  const lo = Math.log10(Math.max(min / 1.6, 0.001));
  const hi = Math.log10(max * 1.15);
  const x = (v: number) => left + ((Math.log10(v) - lo) / (hi - lo)) * (W - left - right);
  const ticks = [0.01, 0.03, 0.1, 0.3, 1, 3, 10].filter((t) => Math.log10(t) >= lo && Math.log10(t) <= hi);
  const fmt = (v: number) => (v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Cheapest price per 1M tokens for each chat model, typical job mix, log scale.">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} y1={top - 6} x2={x(t)} y2={H - 8} stroke="rgba(0,0,0,0.07)" />
          <text x={x(t)} y={top - 12} textAnchor="middle" fontSize={10} fontFamily={mono} fill="#6c6c6c">
            ${t}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const y = top + i * rowH;
        const name = d.model.split("/").slice(1).join("/") || d.model;
        return (
          <g key={d.model} className="bar-row">
            <text x={left - 12} y={y + 16} textAnchor="end" fontSize={11.5} fontFamily={mono} fill="#262626">
              {name.length > 30 ? name.slice(0, 29) + "…" : name}
            </text>
            <rect x={left} y={y + 6} width={W - left - right} height={14} rx={4} fill="rgba(255,255,255,0.35)" />
            <rect x={left} y={y + 6} width={Math.max(4, x(d.price) - left)} height={14} rx={4} fill={i === 0 ? "#262626" : "#6c6c6c"} opacity={1 - i * 0.03} className="grow" style={{ animationDelay: `${i * 40}ms` }} />
            <text x={x(d.price) + 8} y={y + 17} fontSize={11} fontWeight={600} fontFamily={sans} fill="#262626">
              {fmt(d.price)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
