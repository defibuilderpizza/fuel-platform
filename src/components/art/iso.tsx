// A tiny isometric toolkit for Fuel's illustrations. World axes: x runs down-right, y runs
// down-left, z is up. Boxes show their top, their +y face (front-left) and their +x face
// (front-right), lit from the top-left, all in the five greys.

export type Pt = [number, number];
const C = Math.cos(Math.PI / 6);

export const P = (x: number, y: number, z: number): Pt => [(x - y) * C, (x + y) * 0.5 - z];
export const pts = (ps: Pt[]) => ps.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");

/** Point on a quad (corners in order a→b→c→d) at (u along a→b, v along a→d). */
export function onQuad(q: Pt[], u: number, v: number): Pt {
  const [a, b, c, d] = q;
  const top: Pt = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  const bot: Pt = [d[0] + (c[0] - d[0]) * u, d[1] + (c[1] - d[1]) * u];
  return [top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v];
}
/** Sub-rectangle of a quad, in quad coordinates. */
export const subQuad = (q: Pt[], u0: number, v0: number, u1: number, v1: number): Pt[] => [onQuad(q, u0, v0), onQuad(q, u1, v0), onQuad(q, u1, v1), onQuad(q, u0, v1)];

export function faces(x: number, y: number, z: number, w: number, d: number, h: number) {
  return {
    top: [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)] as Pt[],
    // front-left face (+y), corners: top-left, top-right, bottom-right, bottom-left
    left: [P(x, y + d, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x, y + d, z)] as Pt[],
    // front-right face (+x)
    right: [P(x + w, y + d, z + h), P(x + w, y, z + h), P(x + w, y, z), P(x + w, y + d, z)] as Pt[],
  };
}

export type Shade = { top: string; left: string; right: string; stroke?: string };
export const LIGHT: Shade = { top: "#fbfbfb", left: "#e2e2e2", right: "#c9c9c9", stroke: "rgba(0,0,0,0.12)" };
export const MID: Shade = { top: "#d9d9d9", left: "#b3b3b3", right: "#8f8f8f", stroke: "rgba(0,0,0,0.14)" };
export const DARK: Shade = { top: "#6c6c6c", left: "#4f4f4f", right: "#3a3a3a", stroke: "rgba(0,0,0,0.25)" };
export const GLASS: Shade = { top: "rgba(255,255,255,0.75)", left: "rgba(255,255,255,0.45)", right: "rgba(255,255,255,0.3)", stroke: "rgba(255,255,255,0.9)" };

export function Box({ x, y, z, w, d, h, shade = LIGHT, children }: { x: number; y: number; z: number; w: number; d: number; h: number; shade?: Shade; children?: React.ReactNode }) {
  const f = faces(x, y, z, w, d, h);
  const sw = 0.75;
  return (
    <g>
      <polygon points={pts(f.left)} fill={shade.left} stroke={shade.stroke} strokeWidth={sw} strokeLinejoin="round" />
      <polygon points={pts(f.right)} fill={shade.right} stroke={shade.stroke} strokeWidth={sw} strokeLinejoin="round" />
      <polygon points={pts(f.top)} fill={shade.top} stroke={shade.stroke} strokeWidth={sw} strokeLinejoin="round" />
      {children}
    </g>
  );
}

/** Soft elliptical contact shadow under an object footprint. */
export function Shadow({ x, y, w, d, spread = 1.15, opacity = 0.18 }: { x: number; y: number; w: number; d: number; spread?: number; opacity?: number }) {
  const [cx, cy] = P(x + w / 2, y + d / 2, 0);
  const rx = ((w + d) / 2) * C * spread;
  const ry = ((w + d) / 4) * spread;
  return <ellipse cx={cx} cy={cy + 2} rx={rx} ry={ry} fill="url(#isoShadow)" opacity={opacity / 0.18} />;
}

/** Shared gradients; render once inside each illustration's <svg>. */
export function IsoDefs() {
  return (
    <defs>
      <radialGradient id="isoShadow">
        <stop offset="0" stopColor="#000" stopOpacity="0.22" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="isoScreen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#5a5a5a" />
        <stop offset="1" stopColor="#2f2f2f" />
      </linearGradient>
      <linearGradient id="isoSheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
        <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

/** A flat floor plate with a faint grid. */
export function Floor({ x, y, w, d, step = 20 }: { x: number; y: number; w: number; d: number; step?: number }) {
  const lines = [];
  for (let i = step; i < w; i += step) lines.push([P(x + i, y, 0), P(x + i, y + d, 0)]);
  for (let j = step; j < d; j += step) lines.push([P(x, y + j, 0), P(x + w, y + j, 0)]);
  return (
    <g>
      <polygon points={pts([P(x, y, 0), P(x + w, y, 0), P(x + w, y + d, 0), P(x, y + d, 0)])} fill="rgba(255,255,255,0.45)" stroke="rgba(0,0,0,0.08)" />
      {lines.map(([a, b], i) => (
        <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(0,0,0,0.05)" />
      ))}
    </g>
  );
}

/** Fit a drawing: give the world-space bounds you used, get a viewBox string. */
export function viewBoxFor(corners: [number, number, number][], pad = 12) {
  const p = corners.map(([x, y, z]) => P(x, y, z));
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return `${x0.toFixed(0)} ${y0.toFixed(0)} ${(Math.max(...xs) - x0 + pad).toFixed(0)} ${(Math.max(...ys) - y0 + pad).toFixed(0)}`;
}
