"use client";

// Capacity contracts for the operator: how much compute cost is capped, offers to decide on,
// active contracts (usage, health) and recent outcomes.

export type ContractsAdmin = {
  hedge: {
    active: number;
    offered: number;
    volume_left_mtok: number;
    protected_usd: number;
    in_the_money_usd: number;
    saved_at: Record<"10" | "20" | "50" | "100", number>;
    fuel_operated: { name: string; live: boolean; cost_hr: number; until: string; capacity_left_mtok: number; cost_per_mtok_full_load: number }[];
  };
  data: {
    id: string;
    seller_name: string | null;
    wallet: string;
    model: string;
    ceiling_in: number;
    ceiling_out: number;
    volume_mtok: number;
    term_days: number;
    premium_pct: number;
    notional_usd: number;
    bond_usd: number;
    premium_usd: number;
    status: string;
    used_mtok: number;
    failing_since: string | null;
    note: string | null;
    created_at: string;
    ends_at: string | null;
    settled_at: string | null;
  }[];
};

const usd = (n: number) => `$${n.toFixed(2)}`;

export default function ContractsPanel({ c, act, busy }: { c: ContractsAdmin; act: (id: string, action: string) => void; busy: boolean }) {
  const offered = c.data.filter((x) => x.status === "offered");
  const active = c.data.filter((x) => x.status === "active");
  const closed = c.data.filter((x) => !["offered", "active"].includes(x.status)).slice(0, 8);
  return (
    <section className="space-y-3">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Capacity contracts</p>
        <p className="mt-1 text-sm text-muted">Sellers&apos; price ceilings: compute cost Fuel has locked in. Premiums come out of the credit reserve when a contract completes.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Cost locked in", usd(c.hedge.protected_usd), `${c.hedge.volume_left_mtok.toLocaleString("en-US")}M tokens left · ${c.hedge.active} active`],
          ["Cheaper than market by", usd(c.hedge.in_the_money_usd), "on the volume left, today"],
          ["Saved if prices +20%", usd(c.hedge.saved_at["20"]), `+50%: ${usd(c.hedge.saved_at["50"])} · +100%: ${usd(c.hedge.saved_at["100"])}`],
          ["Offers waiting", String(c.hedge.offered), "accept to start the term"],
        ].map(([k, v, h]) => (
          <div key={k} className="rounded-xl border border-line bg-card p-4">
            <p className="text-[11px] uppercase tracking-wider text-faint">{k}</p>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{v}</p>
            <p className="mt-1 text-xs text-muted">{h}</p>
          </div>
        ))}
      </div>

      {[
        ["Offers", offered],
        ["Active", active],
        ["Recent outcomes", closed],
      ].map(([title, rows]) =>
        (rows as ContractsAdmin["data"]).length === 0 ? null : (
          <div key={title as string} className="overflow-hidden rounded-2xl border border-line bg-card">
            <p className="border-b border-line px-5 py-2.5 text-sm font-semibold">{title as string}</p>
            <ul className="max-h-96 overflow-y-auto pr-1 divide-y divide-line">
              {(rows as ContractsAdmin["data"]).map((x) => {
                const pct = Math.min(100, (x.used_mtok / x.volume_mtok) * 100);
                return (
                  <li key={x.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p>
                        <span className="font-medium">{x.seller_name ?? x.wallet.slice(0, 6)}</span> <span className="font-mono text-xs text-muted">{x.model}</span>
                      </p>
                      <p className="text-xs text-muted">
                        ≤ ${x.ceiling_in} / ${x.ceiling_out} · {x.volume_mtok.toLocaleString("en-US")}M · {x.term_days} d · value {usd(x.notional_usd)} · bond {usd(x.bond_usd)} · premium{" "}
                        {usd(x.premium_usd)} ({x.premium_pct}%)
                      </p>
                      {x.status === "active" && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="h-1.5 w-40 rounded-full bg-black/10">
                            <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[11px] text-faint">
                            {Math.round(pct)}% served · ends {x.ends_at?.slice(0, 10)}
                            {x.failing_since && <span className="text-bad"> · failing since {x.failing_since.slice(0, 16).replace("T", " ")}</span>}
                          </span>
                        </div>
                      )}
                      {x.note && x.status !== "active" && x.status !== "offered" && <p className="mt-1 text-xs text-muted">{x.note}</p>}
                    </div>
                    {x.status === "offered" && (
                      <div className="flex gap-2">
                        <button disabled={busy} onClick={() => act(x.id, "accept")} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-50">
                          Accept
                        </button>
                        <button disabled={busy} onClick={() => act(x.id, "reject")} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                          Reject
                        </button>
                      </div>
                    )}
                    {x.status === "active" && (
                      <div className="flex gap-2">
                        <button disabled={busy} onClick={() => act(x.id, "complete")} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                          Complete now
                        </button>
                        <button disabled={busy} onClick={() => act(x.id, "breach")} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                          Mark breached
                        </button>
                      </div>
                    )}
                    {!["offered", "active"].includes(x.status) && <span className="text-xs capitalize text-muted">{x.status}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        ),
      )}
      {c.hedge.fuel_operated.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-line bg-card">
          <p className="border-b border-line px-5 py-2.5 text-sm font-semibold">Fuel-operated GPUs (locked cost)</p>
          <ul className="max-h-96 overflow-y-auto pr-1 divide-y divide-line">
            {c.hedge.fuel_operated.map((h) => (
              <li key={h.name} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-sm">
                <span className={`h-2 w-2 rounded-full ${h.live ? "bg-ok" : "bg-bad"}`} />
                <span className="min-w-0 flex-1 font-medium">{h.name}</span>
                <span className="tabular-nums text-muted">{usd(h.cost_hr)}/hr until {h.until.slice(0, 10)}</span>
                <span className="tabular-nums text-muted">{h.capacity_left_mtok.toLocaleString("en-US")}M tokens left at full load</span>
                <span className="tabular-nums">${h.cost_per_mtok_full_load} / 1M at full load</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.data.length === 0 && <p className="rounded-2xl border border-dashed border-line-strong p-6 text-center text-sm text-muted">No contracts yet. Sellers offer them from /sell.</p>}
    </section>
  );
}
