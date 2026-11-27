// Isometric scenes for Fuel's three audiences plus the laptop lane. Pure SVG in the five greys;
// small parts animate (status lights, traffic) and stop for reduced motion.

import { Box, DARK, Floor, IsoDefs, LIGHT, MID, P, Shadow, faces, onQuad, pts, subQuad, viewBoxFor, type Pt } from "./iso";

const mono = "var(--font-geist-mono), ui-monospace, monospace";
const sans = "var(--font-inter), ui-sans-serif, sans-serif";

/** Fuel's bolt drawn onto any quad (e.g. a box's top face). */
function BoltOn({ q, fill = "#fff" }: { q: Pt[]; fill?: string }) {
  const uv: [number, number][] = [
    [0.58, 0.12], [0.26, 0.56], [0.47, 0.56], [0.4, 0.9], [0.76, 0.42], [0.54, 0.42], [0.63, 0.12],
  ];
  return <polygon points={pts(uv.map(([u, v]) => onQuad(q, u, v)))} fill={fill} />;
}

/** A flat label floating in screen space. */
function Chip({ at, children, dark = false, w = 92 }: { at: Pt; children: React.ReactNode; dark?: boolean; w?: number }) {
  return (
    <g transform={`translate(${at[0] - w / 2} ${at[1] - 13})`}>
      <rect width={w} height={26} rx={8} fill={dark ? "#3a3a3a" : "rgba(255,255,255,0.92)"} stroke={dark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.1)"} />
      <text x={w / 2} y={17} textAnchor="middle" fontSize={10.5} fontFamily={mono} fill={dark ? "#fff" : "#262626"}>
        {children}
      </text>
    </g>
  );
}

/** A flat stack of coins (isometric cylinders). */
function Coins({ x, y, n = 3, r = 9 }: { x: number; y: number; n?: number; r?: number }) {
  const rx = r * 1.22;
  const ry = r * 0.7;
  return (
    <g>
      {Array.from({ length: n }, (_, i) => {
        const [cx, cy] = P(x, y, i * 4);
        return (
          <g key={i}>
            <path d={`M${cx - rx} ${cy} v4 a${rx} ${ry} 0 0 0 ${rx * 2} 0 v-4`} fill="#8f8f8f" stroke="rgba(0,0,0,0.2)" strokeWidth={0.6} />
            <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={i === n - 1 ? "#e2e2e2" : "#c9c9c9"} stroke="rgba(0,0,0,0.2)" strokeWidth={0.6} />
            {i === n - 1 && (
              <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={9} fontWeight={700} fontFamily={sans} fill="#474747">
                $
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ── Agents: an agent unit with a terminal, paying from its own coins ─────────
export function AgentArt({ className = "" }: { className?: string }) {
  const unit = faces(40, 40, 0, 60, 60, 52);
  const screen = subQuad(unit.left, 0.12, 0.16, 0.88, 0.7);
  return (
    <svg viewBox={viewBoxFor([[0, 0, 0], [150, 0, 0], [0, 150, 0], [150, 150, 0], [40, 40, 100]])} className={className} role="img" aria-label="An agent with its own wallet">
      <IsoDefs />
      <Floor x={0} y={0} w={150} d={150} step={25} />
      <Shadow x={40} y={40} w={60} d={60} />
      <Box x={40} y={40} z={0} w={60} d={60} h={52} shade={LIGHT}>
        <polygon points={pts(screen)} fill="url(#isoScreen)" />
        {[0.22, 0.42, 0.62].map((v, i) => (
          <polygon key={v} points={pts(subQuad(screen, 0.1, v, [0.62, 0.8, 0.45][i], v + 0.09))} fill={i === 0 ? "#cfcfcf" : "#8f8f8f"} />
        ))}
        <polygon points={pts(subQuad(screen, 0.1, 0.78, 0.2, 0.88))} fill="#fff" className="blink" />
        {/* status light on the right face */}
        <circle cx={onQuad(unit.right, 0.2, 0.2)[0]} cy={onQuad(unit.right, 0.2, 0.2)[1]} r={2.4} fill="#15803d" className="blink" />
      </Box>
      {/* antenna */}
      <line x1={P(70, 70, 52)[0]} y1={P(70, 70, 52)[1]} x2={P(70, 70, 74)[0]} y2={P(70, 70, 74)[1]} stroke="#6c6c6c" strokeWidth={1.5} />
      <circle cx={P(70, 70, 76)[0]} cy={P(70, 70, 76)[1]} r={3.5} fill="#474747" />
      <Coins x={118} y={58} n={4} />
      {/* payment arc: coins → agent */}
      <path d={`M${P(118, 58, 22)[0]} ${P(118, 58, 22)[1]} Q ${P(112, 50, 70)[0]} ${P(112, 50, 70)[1]} ${P(90, 50, 54)[0]} ${P(90, 50, 54)[1]}`} fill="none" stroke="#474747" strokeWidth={1.3} className="flow" />
      <Chip at={P(14, 112, 70)} w={104}>
        wallet 7xK…q9
      </Chip>
    </svg>
  );
}

// ── Teams: a Fuel hub feeding several agents, each with its own limit ───────
export function TeamArt({ className = "" }: { className?: string }) {
  const agents: [number, number, number][] = [
    [10, 70, 0.35],
    [70, 10, 0.7],
    [130, 70, 0.5],
    [70, 130, 0.2],
  ];
  const hub = faces(62, 62, 0, 36, 36, 26);
  const order = [...agents].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  return (
    <svg viewBox={viewBoxFor([[0, 0, 0], [160, 0, 0], [0, 160, 0], [160, 160, 0], [80, 10, 60]])} className={className} role="img" aria-label="A team: one hub funding several agents, each with a spending limit">
      <IsoDefs />
      <Floor x={0} y={0} w={160} d={160} step={20} />
      {agents.map(([x, y]) => {
        const a = P(80, 80, 0);
        const b = P(x + 10, y + 10, 0);
        return (
          <g key={`${x}-${y}`}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#9b9b9b" strokeWidth={1.2} />
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#474747" strokeWidth={1.2} className="flow" />
          </g>
        );
      })}
      {order.slice(0, 2).map(([x, y, used]) => (
        <AgentCube key={`${x}${y}`} x={x} y={y} used={used} />
      ))}
      <Shadow x={62} y={62} w={36} d={36} />
      <Box x={62} y={62} z={0} w={36} d={36} h={26} shade={DARK}>
        <BoltOn q={hub.top} />
      </Box>
      {order.slice(2).map(([x, y, used]) => (
        <AgentCube key={`${x}${y}`} x={x} y={y} used={used} />
      ))}
      <Chip at={P(104, 6, 62)} w={96}>
        limit $5 / day
      </Chip>
    </svg>
  );
}

function AgentCube({ x, y, used }: { x: number; y: number; used: number }) {
  const f = faces(x, y, 0, 20, 20, 20);
  const gauge = subQuad(f.left, 0.15, 0.62, 0.85, 0.78);
  return (
    <g>
      <Shadow x={x} y={y} w={20} d={20} />
      <Box x={x} y={y} z={0} w={20} d={20} h={20} shade={LIGHT}>
        <polygon points={pts(gauge)} fill="rgba(0,0,0,0.12)" />
        <polygon points={pts(subQuad(gauge, 0, 0, used, 1))} fill="#474747" />
        <circle cx={onQuad(f.left, 0.5, 0.32)[0]} cy={onQuad(f.left, 0.5, 0.32)[1]} r={2} fill="#474747" />
      </Box>
    </g>
  );
}

// ── Sellers: GPU racks with live status lights and a price tag ──────────────
export function SellerArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox={viewBoxFor([[0, 0, 0], [170, 0, 0], [0, 150, 0], [170, 150, 0], [40, 30, 140]])} className={className} role="img" aria-label="GPU servers selling compute at their own price">
      <IsoDefs />
      <Floor x={0} y={0} w={170} d={150} step={25} />
      <Rack x={30} y={30} w={44} d={40} h={118} units={7} />
      <Rack x={100} y={58} w={40} d={36} h={74} units={4} shade="mid" />
      <Chip at={P(150, 20, 92)} dark w={100}>
        $0.15 / 1M ✓
      </Chip>
    </svg>
  );
}

function Rack({ x, y, w, d, h, units, shade = "light" }: { x: number; y: number; w: number; d: number; h: number; units: number; shade?: "light" | "mid" }) {
  const f = faces(x, y, 0, w, d, h);
  const pad = 0.08;
  const span = (1 - pad * 2) / units;
  return (
    <g>
      <Shadow x={x} y={y} w={w} d={d} />
      <Box x={x} y={y} z={0} w={w} d={d} h={h} shade={shade === "mid" ? MID : LIGHT}>
        {Array.from({ length: units }, (_, i) => {
          const v0 = pad + i * span + span * 0.12;
          const unit = subQuad(f.left, 0.1, v0, 0.9, v0 + span * 0.76);
          return (
            <g key={i}>
              <polygon points={pts(unit)} fill={shade === "mid" ? "#5c5c5c" : "#474747"} />
              {[0.45, 0.55, 0.65, 0.75].map((u) => {
                const a = onQuad(unit, u, 0.25);
                const b = onQuad(unit, u, 0.75);
                return <line key={u} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(255,255,255,0.18)" strokeWidth={0.8} />;
              })}
              <circle cx={onQuad(unit, 0.14, 0.5)[0]} cy={onQuad(unit, 0.14, 0.5)[1]} r={1.6} fill={i % 3 === 1 ? "#d4d4d4" : "#4ade80"} className="blink" style={{ animationDelay: `${(i * 0.37) % 1.6}s` }} />
              <circle cx={onQuad(unit, 0.24, 0.5)[0]} cy={onQuad(unit, 0.24, 0.5)[1]} r={1.3} fill="#9b9b9b" />
            </g>
          );
        })}
        {/* vents on the side */}
        {Array.from({ length: Math.floor(units * 1.5) }, (_, i) => {
          const v = 0.1 + (i * 0.8) / Math.floor(units * 1.5);
          const a = onQuad(f.right, 0.2, v);
          const b = onQuad(f.right, 0.8, v);
          return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(0,0,0,0.1)" strokeWidth={0.8} />;
        })}
      </Box>
    </g>
  );
}

// ── Laptop lane: a laptop running embeddings, vectors floating off the screen ──
export function LaptopArt({ className = "" }: { className?: string }) {
  const base = faces(20, 40, 0, 96, 64, 5);
  // screen: hinge on the base's back edge (y = 40), leaning back
  const screen: Pt[] = [P(20, 26, 70), P(116, 26, 70), P(116, 40, 5), P(20, 40, 5)];
  const inner = subQuad(screen, 0.05, 0.07, 0.95, 0.9);
  const bars = [0.55, 0.8, 0.35, 0.65, 0.9, 0.45, 0.7, 0.3, 0.6, 0.85, 0.4, 0.75, 0.5, 0.95, 0.38, 0.68];
  const keys = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 11; c++) keys.push(subQuad(base.top, 0.06 + c * 0.08, 0.1 + r * 0.11, 0.06 + c * 0.08 + 0.065, 0.1 + r * 0.11 + 0.085));
  return (
    <svg viewBox={viewBoxFor([[0, 0, 0], [150, 0, 0], [0, 130, 0], [150, 130, 0], [20, 26, 96]])} className={className} role="img" aria-label="A laptop running embedding jobs in a browser tab">
      <IsoDefs />
      <Floor x={0} y={0} w={150} d={130} step={25} />
      <Shadow x={20} y={40} w={96} d={64} />
      <Box x={20} y={40} z={0} w={96} d={64} h={5} shade={LIGHT}>
        {keys.map((k, i) => (
          <polygon key={i} points={pts(k)} fill="#e6e6e6" stroke="rgba(0,0,0,0.08)" strokeWidth={0.5} />
        ))}
        <polygon points={pts(subQuad(base.top, 0.36, 0.6, 0.64, 0.9))} fill="#ececec" stroke="rgba(0,0,0,0.08)" strokeWidth={0.5} />
      </Box>
      <polygon points={pts(screen)} fill="#cfcfcf" stroke="rgba(0,0,0,0.15)" strokeWidth={0.75} />
      <polygon points={pts(inner)} fill="url(#isoScreen)" />
      {bars.map((h, i) => {
        const u0 = 0.06 + i * 0.056;
        return <polygon key={i} points={pts(subQuad(inner, u0, 0.88 - h * 0.62, u0 + 0.034, 0.88))} fill={i % 4 === 0 ? "#f4f4f4" : "#9b9b9b"} className="eq" style={{ animationDelay: `${(i * 0.13) % 1.2}s` }} />;
      })}
      <polygon points={pts(subQuad(inner, 0.06, 0.06, 0.4, 0.14))} fill="rgba(255,255,255,0.35)" />
      {/* vectors drifting up out of the screen */}
      {[
        [40, 20, 96, "[0.12,"],
        [86, 14, 108, "-0.43,"],
        [128, 18, 92, "0.88…]"],
      ].map(([x, y, z, t], i) => {
        const at = P(x as number, y as number, z as number);
        return (
          <g key={i} className="drift" style={{ animationDelay: `${i * 0.8}s` }}>
            <rect x={at[0] - 24} y={at[1] - 10} width={48} height={20} rx={6} fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" />
            <text x={at[0]} y={at[1] + 3.5} textAnchor="middle" fontSize={9.5} fontFamily={mono} fill="#474747">
              {t}
            </text>
          </g>
        );
      })}
      <Chip at={P(140, 120, 26)} w={88}>
        ✓ verified
      </Chip>
    </svg>
  );
}
