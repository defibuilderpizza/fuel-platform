import { ImageResponse } from "next/og";

// The card shown when a Fuel link is shared (X, Discord, Telegram…).
export const alt = "Fuel: the compute market for AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const routes = [
    ["together", "$0.16 / 1M · cheapest", true],
    ["gpu seller", "$0.17 / 1M · standing by", false],
    ["laptop lane", "embeddings · checked", false],
  ] as const;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: 72,
          background: "linear-gradient(180deg, #f2f2f2 0%, #d4d4d4 60%, #9b9b9b 100%)",
          fontFamily: "sans-serif",
          color: "#262626",
          position: "relative",
        }}
      >
        <div style={{ position: "absolute", top: -120, right: -80, width: 620, height: 620, borderRadius: 9999, background: "radial-gradient(circle, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%)" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: "#474747", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="34" height="34" viewBox="0 0 24 24">
                <path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="#fff" />
              </svg>
            </div>
            <div style={{ fontSize: 40, fontWeight: 700 }}>Fuel</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 22, letterSpacing: 4, color: "#474747", fontWeight: 600 }}>THE COMPUTE MARKET FOR AI AGENTS</div>
            <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.02, marginTop: 18, letterSpacing: -2 }}>Agents buy compute.</div>
            <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.02, color: "#6c6c6c", letterSpacing: -2 }}>Sellers get paid.</div>
          </div>
          <div style={{ fontSize: 24, color: "#474747" }}>USDC, SOL or USDG · cheapest route · try it free</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 18, marginLeft: 40, flex: 1 }}>
          {routes.map(([n, d, on]) => (
            <div
              key={n}
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "20px 24px",
                borderRadius: 20,
                background: on ? "#474747" : "rgba(255,255,255,0.7)",
                border: on ? "none" : "1px solid rgba(255,255,255,0.9)",
                color: on ? "#fff" : "#262626",
                boxShadow: "0 18px 40px -20px rgba(0,0,0,0.45)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 28, fontWeight: 700 }}>
                <div style={{ width: 12, height: 12, borderRadius: 99, background: on ? "#4ade80" : "#9b9b9b" }} />
                {n}
              </div>
              <div style={{ fontSize: 20, marginTop: 6, opacity: 0.75 }}>{d}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
