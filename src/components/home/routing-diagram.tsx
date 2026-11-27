// Hero illustration: an agent's job going through Fuel to the cheapest provider, with a
// failover route standing by. Drawn in the five-grey palette; the chosen route animates.

type Route = { name: string; detail: string; state: "chosen" | "backup" | "lane" };

export default function RoutingDiagram({ cheapest }: { cheapest?: { model: string; price: string } }) {
  const routes: Route[] = [
    { name: "together", detail: cheapest ? `${cheapest.price}/1M · cheapest` : "cheapest now", state: "chosen" },
    { name: "gpu seller", detail: "failover · standing by", state: "backup" },
    { name: "laptop lane", detail: "embeddings · checked", state: "lane" },
  ];
  const ys = [56, 172, 288];

  return (
    <figure className="relative w-full">
      <svg viewBox="0 0 560 380" className="h-auto w-full" role="img" aria-label="An agent's job goes to Fuel, which routes it to the cheapest provider, with a backup ready.">
        <defs>
          <linearGradient id="fuelTile" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6c6c6c" />
            <stop offset="1" stopColor="#474747" />
          </linearGradient>
          <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#000" floodOpacity="0.08" />
          </filter>
        </defs>

        {/* connectors */}
        <path d="M150 190 H222" stroke="#474747" strokeWidth="1.5" fill="none" />
        <path d="M150 190 H222" stroke="#474747" strokeWidth="1.5" fill="none" className="flow" />
        {ys.map((y, i) => {
          const d = `M338 190 C 372 190, 372 ${y + 28}, 396 ${y + 28}`;
          const r = routes[i];
          return (
            <g key={r.name}>
              <path d={d} stroke={r.state === "chosen" ? "#474747" : "#9b9b9b"} strokeWidth={r.state === "chosen" ? 1.75 : 1.25} strokeDasharray={r.state === "backup" ? "4 5" : undefined} fill="none" />
              {r.state === "chosen" && <path d={d} stroke="#262626" strokeWidth="1.75" fill="none" className="flow" />}
            </g>
          );
        })}

        {/* agent */}
        <g filter="url(#soft)">
          <rect x="16" y="146" width="134" height="88" rx="14" fill="rgba(255,255,255,0.78)" stroke="rgba(0,0,0,0.1)" />
        </g>
        <text x="34" y="176" fontSize="10" letterSpacing="1.4" fill="#6c6c6c" fontFamily="var(--font-geist-mono), monospace">
          AGENT
        </text>
        <text x="34" y="198" fontSize="15" fontWeight="600" fill="#262626" fontFamily="var(--font-inter), sans-serif">
          summarise()
        </text>
        <text x="34" y="218" fontSize="10.5" fill="#6c6c6c" fontFamily="var(--font-geist-mono), monospace">
          wallet 7xK…q9
        </text>

        {/* fuel */}
        <g filter="url(#soft)">
          <rect x="222" y="136" width="116" height="108" rx="18" fill="url(#fuelTile)" />
        </g>
        <path d="M284 158 L262 186 h19 l-2 20 22-29 h-19 l2-19z" fill="#ffffff" />
        <text x="280" y="226" textAnchor="middle" fontSize="13" fontWeight="600" fill="#ffffff" fontFamily="var(--font-inter), sans-serif">
          Fuel
        </text>

        {/* providers */}
        {ys.map((y, i) => {
          const r = routes[i];
          const chosen = r.state === "chosen";
          return (
            <g key={r.name}>
              <g filter="url(#soft)">
                <rect
                  x="396"
                  y={y}
                  width="156"
                  height="56"
                  rx="12"
                  fill={chosen ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.6)"}
                  stroke={chosen ? "#474747" : "rgba(0,0,0,0.1)"}
                  strokeWidth={chosen ? 1.5 : 1}
                />
              </g>
              <circle cx="412" cy={y + 21} r="4" fill={chosen ? "#15803d" : r.state === "backup" ? "#9b9b9b" : "#6c6c6c"} />
              <text x="424" y={y + 25} fontSize="13" fontWeight="600" fill="#262626" fontFamily="var(--font-inter), sans-serif">
                {r.name}
              </text>
              <text x="408" y={y + 43} fontSize="9.5" fill="#6c6c6c" fontFamily="var(--font-geist-mono), monospace">
                {r.detail}
              </text>
            </g>
          );
        })}

        {/* receipt chip */}
        <g filter="url(#soft)">
          <rect x="184" y="276" width="192" height="68" rx="12" fill="rgba(255,255,255,0.8)" stroke="rgba(0,0,0,0.1)" />
        </g>
        <text x="200" y="298" fontSize="9.5" letterSpacing="1.2" fill="#6c6c6c" fontFamily="var(--font-geist-mono), monospace">
          RECEIPT
        </text>
        <text x="200" y="318" fontSize="12" fill="#262626" fontFamily="var(--font-geist-mono), monospace">
          $0.000044 · 897ms
        </text>
        <text x="200" y="334" fontSize="10" fill="#6c6c6c" fontFamily="var(--font-geist-mono), monospace">
          provider: together
        </text>
        <path d="M280 244 V276" stroke="#9b9b9b" strokeWidth="1.25" strokeDasharray="2 4" />
      </svg>
      {cheapest && <figcaption className="sr-only">Cheapest right now: {cheapest.model} at {cheapest.price} per million tokens.</figcaption>}
    </figure>
  );
}
