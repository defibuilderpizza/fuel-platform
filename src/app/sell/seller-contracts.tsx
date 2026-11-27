"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fuelCall, useFuelKey } from "@/components/fuel-key";

// Sellers sell capacity forward: a price ceiling for a set volume and term, backed by a bond,
// paid a premium at the end if they deliver.

type Terms = { terms_days: number[]; bond_pct: number; max_premium_pct: number; breach_hours: number };
type Contract = {
  id: string;
  model: string;
  ceiling_in: number;
  ceiling_out: number;
  volume_mtok: number;
  term_days: number;
  premium_pct: number;
  notional_usd: number;
  bond_usd: number;
  premium_usd: number;
  status: "offered" | "active" | "completed" | "breached" | "rejected" | "withdrawn";
  used_mtok: number;
  failing_since: string | null;
  note: string | null;
  created_at: string;
  ends_at: string | null;
};
type SellerView = { sellers: { status: string; models: { model: string; kind: string; input_per_mtok: number; output_per_mtok: number; probe_ok: boolean | null }[] }[] };

const usd = (n: number) => (n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const field = "w-full rounded-lg border border-line-strong bg-white/70 px-3 py-2 text-sm";
const BADGE: Record<Contract["status"], string> = {
  offered: "bg-[#d4d4d4] text-ink",
  active: "bg-ok/10 text-ok",
  completed: "bg-black/10 text-muted",
  breached: "bg-bad/10 text-bad",
  rejected: "bg-black/10 text-muted",
  withdrawn: "bg-black/10 text-muted",
};
const LABEL: Record<Contract["status"], string> = {
  offered: "Waiting for Fuel",
  active: "Active",
  completed: "Completed",
  breached: "Breached",
  rejected: "Not accepted",
  withdrawn: "Withdrawn",
};

export default function SellerContracts() {
  const key = useFuelKey();
  const [terms, setTerms] = useState<Terms | null>(null);
  const [list, setList] = useState<Contract[]>([]);
  const [models, setModels] = useState<SellerView["sellers"][number]["models"]>([]);
  const [live, setLive] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ model: "", ceiling_in: "", ceiling_out: "", volume: "100", term: "90", premium: "2" });

  const load = useCallback(async () => {
    if (!key) return;
    try {
      const [c, v] = await Promise.all([fuelCall<{ terms: Terms; data: Contract[] }>(key, "/v1/sellers/contracts"), fuelCall<SellerView>(key, "/v1/sellers/me")]);
      setTerms(c.terms);
      setList(c.data);
      const s = v.sellers[0];
      setLive(s?.status === "approved");
      const ok = (s?.models ?? []).filter((m) => m.kind === "chat" && m.probe_ok);
      setModels(ok);
      setF((x) => (x.model || !ok[0] ? x : { ...x, model: ok[0].model, ceiling_in: String(ok[0].input_per_mtok), ceiling_out: String(ok[0].output_per_mtok) }));
    } catch {
      /* signed out or not a seller yet */
    }
  }, [key]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const calc = useMemo(() => {
    const ci = Number(f.ceiling_in);
    const co = Number(f.ceiling_out);
    const v = Number(f.volume);
    const p = Number(f.premium);
    if (![ci, co, v, p].every(Number.isFinite) || !terms) return null;
    const notional = v * ((ci * 3 + co) / 4);
    return { notional, bond: notional * (terms.bond_pct / 100), premium: notional * (p / 100) };
  }, [f, terms]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await fuelCall<{ bond_usd: number; premium_usd: number }>(key, "/v1/sellers/contracts", {
        model: f.model,
        ceiling_in: Number(f.ceiling_in),
        ceiling_out: Number(f.ceiling_out),
        volume_mtok: Number(f.volume),
        term_days: Number(f.term),
        premium_pct: Number(f.premium),
      });
      setMsg({ text: `Offer sent. ${usd(r.bond_usd)} bond held from your balance; you'll earn ${usd(r.premium_usd)} if Fuel accepts and you deliver.` });
      await load();
    } catch (err) {
      setMsg({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    setBusy(true);
    try {
      await fuelCall(key, `/v1/sellers/contracts/${id}/withdraw`, {});
      await load();
    } catch (err) {
      setMsg({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="contracts" className="scroll-mt-24 grid items-start gap-8 lg:grid-cols-[0.8fr_1.2fr]">
      <div className="space-y-4 rounded-2xl border border-line bg-card p-5 sm:p-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">Capacity contracts</p>
        <h2 className="text-3xl font-bold tracking-tight">Sell your compute forward</h2>
        <p className="text-sm text-muted">
          Promise a price ceiling on one of your models for 30, 60 or 90 days, and earn a premium for it. Fuel uses these promises to keep compute affordable when
          market prices rise.
        </p>
        <ol className="space-y-3 text-sm">
          {[
            ["You set the terms", "A model, the most you'll charge, how many tokens, how long, and the premium you want."],
            ["You post a bond", `${terms?.bond_pct ?? 20}% of the contract's value, held from your Fuel balance.`],
            ["Fuel accepts", "The term starts. Your price for that model can't go above the ceiling, and the model stays listed."],
            ["Deliver, get paid", "At the end (or once the volume is served) the bond comes back plus the premium."],
            ["Break it, lose the bond", `If the model is down for more than ${terms?.breach_hours ?? 24} hours, the bond goes to Fuel's reserve.`],
          ].map(([t, b], i) => (
            <li key={t} className="grid grid-cols-[28px_1fr]">
              <span className="font-mono text-faint">0{i + 1}/</span>
              <div>
                <p className="font-semibold">{t}</p>
                <p className="mt-0.5 text-muted">{b}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="border-t border-line pt-4 text-xs text-muted">
          Routing stays cheapest-first, so you&apos;re still competing on price. The ceiling only matters if the market goes above it, which is exactly when your
          promise is worth the most.
        </p>
      </div>

      <div className="space-y-4">
        {!key ? (
          <div className="rounded-2xl border border-dashed border-line-strong p-5 sm:p-8 text-sm text-muted">Sign in above with your seller wallet to offer contracts.</div>
        ) : !live || models.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong p-5 sm:p-8 text-sm text-muted">
            Contracts open once your listing is live with at least one passing chat model.
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-card p-6">
            <p className="font-semibold tracking-tight">New offer</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="text-faint">Model</span>
                <select
                  className={field}
                  value={f.model}
                  onChange={(e) => {
                    const m = models.find((x) => x.model === e.target.value);
                    setF({ ...f, model: e.target.value, ceiling_in: String(m?.input_per_mtok ?? ""), ceiling_out: String(m?.output_per_mtok ?? "") });
                  }}
                >
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.model} (now ${m.input_per_mtok} / ${m.output_per_mtok})
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-faint">Ceiling, input (USD / 1M)</span>
                <input className={field} inputMode="decimal" value={f.ceiling_in} onChange={(e) => setF({ ...f, ceiling_in: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-faint">Ceiling, output (USD / 1M)</span>
                <input className={field} inputMode="decimal" value={f.ceiling_out} onChange={(e) => setF({ ...f, ceiling_out: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-faint">Volume (million tokens)</span>
                <input className={field} inputMode="numeric" value={f.volume} onChange={(e) => setF({ ...f, volume: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-faint">Term</span>
                <select className={field} value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })}>
                  {(terms?.terms_days ?? [30, 60, 90]).map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="text-faint">Premium you ask for (% of value, up to {terms?.max_premium_pct ?? 5}%)</span>
                <input className={field} inputMode="decimal" value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} />
              </label>
            </div>
            {calc && (
              <dl className="grid grid-cols-3 gap-3 rounded-xl bg-white/50 p-4 text-sm">
                <div>
                  <dt className="text-xs text-faint">Contract value</dt>
                  <dd className="font-semibold tabular-nums">{usd(calc.notional)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-faint">Bond held</dt>
                  <dd className="font-semibold tabular-nums">{usd(calc.bond)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-faint">You earn</dt>
                  <dd className="font-semibold tabular-nums text-ok">+{usd(calc.premium)}</dd>
                </div>
              </dl>
            )}
            {msg && <p className={`text-sm ${msg.bad ? "text-bad" : "text-ok"}`}>{msg.text}</p>}
            <button disabled={busy} className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50">
              {busy ? "Sending…" : "Offer contract"}
            </button>
          </form>
        )}

        {list.length > 0 && (
          <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
            {list.map((c) => {
              const pct = Math.min(100, (c.used_mtok / c.volume_mtok) * 100);
              return (
                <div key={c.id} className="rounded-2xl border border-line bg-card p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-sm">{c.model}</p>
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${BADGE[c.status]}`}>{LABEL[c.status]}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    ≤ ${c.ceiling_in} in / ${c.ceiling_out} out · {c.volume_mtok.toLocaleString("en-US")}M tokens · {c.term_days} days · bond {usd(c.bond_usd)} · premium{" "}
                    {usd(c.premium_usd)}
                    {c.ends_at && c.status === "active" ? ` · ends ${c.ends_at.slice(0, 10)}` : ""}
                  </p>
                  {c.status === "active" && (
                    <div className="mt-3">
                      <div className="h-1.5 rounded-full bg-black/10">
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="mt-1 text-[11px] text-faint">
                        {c.used_mtok.toLocaleString("en-US")}M of {c.volume_mtok.toLocaleString("en-US")}M served
                        {c.failing_since && <span className="text-bad"> · model failing since {c.failing_since.slice(11, 16)} UTC: fix it within {terms?.breach_hours ?? 24} h</span>}
                      </p>
                    </div>
                  )}
                  {c.note && c.status !== "active" && <p className="mt-2 text-xs text-muted">{c.note}</p>}
                  {c.status === "offered" && (
                    <button disabled={busy} onClick={() => withdraw(c.id)} className="mt-3 rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                      Withdraw offer
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
