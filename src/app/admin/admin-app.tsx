"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Stat } from "@/components/ui";
import CreditsPanel, { type CreditsAdmin } from "./credits-panel";
import ContractsPanel, { type ContractsAdmin } from "./contracts-panel";
import FuelOperatedForm from "./fuel-operated-form";

// Operator view: money, jobs, the free-trial pot, sellers (with overrides) and anything that
// needs attention. Locked by FUEL_ADMIN_TOKEN, kept only in this tab's sessionStorage.

type Overview = {
  jobs: { last_24h: number; last_30d: number; failed_30d: number; by_provider_30d: Record<string, number> };
  money: { charged_24h_usd: number; margin_24h_usd: number; charged_30d_usd: number; margin_30d_usd: number; deposits_30d_usd: number; customer_balances_usd: number; credit_owed_usd: number };
  accounts: number;
  faucet: { enabled: boolean; pot_usd: number; pot_used_usd: number; trial_usd: number; credit_share: number };
  private_topups_needing_review: { signature: string; status: string; asset: string; created_at: string }[];
  deposit_scanner: { address: string; scanned_at: string | null }[];
  sellers_pending: number;
  compliance?: {
    suspended_accounts: { wallet: string; suspended_at: string; suspended_reason: string | null }[];
    blocked_deposits: { signature: string; sender: string; asset: string; amount_raw: string; reason: string; created_at: string }[];
    sanctioned_wallets: number;
  };
};
type SellerModel = { model: string; kind: string; input_per_mtok: number; output_per_mtok: number; probe_ok: boolean | null; probe_ms: number | null; probe_error: string | null; probed_at: string | null };
type Seller = {
  id: string;
  wallet: string;
  name: string;
  endpoint_url: string;
  contact: string | null;
  status: "pending" | "approved" | "rejected" | "paused";
  review_note: string | null;
  created_at: string;
  has_api_key: boolean;
  models: SellerModel[];
  jobs_served: number;
  earned_usd: number;
  operated_by_fuel: boolean;
  locked_cost_hr: number | null;
  locked_tps: number | null;
  locked_until: string | null;
};

const STORE = "fuel.admin.token";
const subs = new Set<() => void>();
const readToken = () => {
  try {
    return sessionStorage.getItem(STORE);
  } catch {
    return null;
  }
};
function setToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(STORE, t);
    else sessionStorage.removeItem(STORE);
  } catch {}
  subs.forEach((f) => f());
}
const useToken = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    readToken,
    () => null,
  );

const usd = (n: number, dp = 2) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(dp)}`;
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const ago = (iso: string | null, now: number) => {
  if (!iso) return "never";
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const STATUS: Record<Seller["status"], string> = {
  approved: "bg-ok/10 text-ok",
  pending: "bg-amber-500/15 text-amber-800",
  paused: "bg-black/10 text-muted",
  rejected: "bg-bad/10 text-bad",
};

export default function AdminApp() {
  const token = useToken();
  const [draft, setDraft] = useState("");
  const [ov, setOv] = useState<Overview | null>(null);
  const [sellers, setSellers] = useState<Seller[] | null>(null);
  const [credits, setCredits] = useState<CreditsAdmin | null>(null);
  const [contracts, setContracts] = useState<ContractsAdmin | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Seller["status"]>("all");
  const [now, setNow] = useState(0);
  const [asking, setAsking] = useState<{ id: string; action: "pause" | "reject"; note: string } | null>(null);

  const call = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const r = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", "x-admin-token": token ?? "" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) {
        setToken(null);
        throw new Error("That admin token isn't right.");
      }
      if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      return j as T;
    },
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [o, s, c] = await Promise.all([call<Overview>("/v1/admin/overview"), call<{ data: Seller[] }>("/v1/admin/sellers"), call<CreditsAdmin>("/v1/admin/credits")]);
      setCredits(c);
      setContracts(await call<ContractsAdmin>("/v1/admin/contracts"));
      setOv(o);
      setSellers(s.data);
      setNow(Date.now());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [token, call]);

  useEffect(() => {
    // Load on sign-in, then refresh every minute.
    const first = setTimeout(load, 0);
    const t = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function act(id: string, action: "approve" | "pause" | "reject" | "probe", note?: string) {
    setAsking(null);
    setBusy(id + action);
    try {
      await call(`/v1/admin/sellers/${id}`, { action, note });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md space-y-4 rounded-3xl border border-line bg-card p-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Admin</p>
        <h1 className="text-2xl font-bold tracking-tight">Operator sign-in</h1>
        <p className="text-sm text-muted">
          Paste the admin token (<code className="font-mono">FUEL_ADMIN_TOKEN</code> in <code className="font-mono">.env.local</code>). It stays in this tab only.
        </p>
        {err && <p className="text-sm text-bad">{err}</p>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) {
              setErr(null);
              setToken(draft.trim());
              setDraft("");
            }
          }}
        >
          <input type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="fadm_…" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/70 px-3 py-2 font-mono text-sm" />
          <button className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">Open</button>
        </form>
      </div>
    );
  }

  const shown = (sellers ?? []).filter((s) => filter === "all" || s.status === filter);
  const potLeft = ov ? Math.max(0, ov.faucet.pot_usd - ov.faucet.pot_used_usd) : 0;
  const attention = ov
    ? [
        ...(ov.private_topups_needing_review.length ? [`${ov.private_topups_needing_review.length} private top-up(s) not credited`] : []),
        ...(ov.compliance?.blocked_deposits.length ? [`${ov.compliance.blocked_deposits.length} deposit(s) from sanctioned wallets (not credited)`] : []),
        ...(ov.compliance && ov.compliance.sanctioned_wallets === 0 ? ["Sanctions list is empty: run scripts/sanctions-sync.mjs"] : []),
        ...(ov.deposit_scanner.some((d) => !d.scanned_at || now - Date.parse(d.scanned_at) > 20 * 60_000) ? ["Deposit scanner hasn't run in 20+ min"] : []),
        ...(ov.faucet.enabled && potLeft < ov.faucet.trial_usd ? ["Free-trial pot is used up"] : []),
        ...((sellers ?? []).some((s) => s.status === "approved" && s.models.every((m) => !m.probe_ok)) ? ["An approved seller has no passing models"] : []),
        ...(credits && credits.config.enabled && !credits.selling.open ? [`Credit sales paused: ${credits.selling.reason}`] : []),
        ...(credits && credits.surplus_usd < 0 ? [`Credit reserve is short by $${Math.abs(credits.surplus_usd).toFixed(2)}`] : []),
      ]
    : [];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Admin</p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight">Operations</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/status" className="rounded-lg px-4 py-2 text-sm font-medium btn-2">
            Status page
          </Link>
          <button onClick={load} className="rounded-lg px-4 py-2 text-sm font-medium btn-2">
            Refresh
          </button>
          <button onClick={() => setToken(null)} className="rounded-lg px-4 py-2 text-sm font-medium btn-2">
            Lock
          </button>
        </div>
      </div>

      {err && <p className="rounded-lg bg-bad/10 px-4 py-3 text-sm text-bad">{err}</p>}

      {ov && (
        <>
          <div className={`rounded-2xl p-5 ${attention.length ? "border border-amber-500/40 bg-amber-500/10" : "border border-line bg-card"}`}>
            <p className="font-semibold">{attention.length ? "Needs attention" : "Nothing needs attention"}</p>
            {attention.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                {attention.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
          </div>

          <section className="space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Money</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Margin, 24 h" value={usd(ov.money.margin_24h_usd, 4)} hint={`on ${usd(ov.money.charged_24h_usd, 4)} charged`} />
              <Stat label="Margin, 30 d" value={usd(ov.money.margin_30d_usd, 4)} hint={`on ${usd(ov.money.charged_30d_usd, 4)} charged`} />
              <Stat label="Deposits, 30 d" value={usd(ov.money.deposits_30d_usd)} />
              <Stat label="Customer balances" value={usd(ov.money.customer_balances_usd)} hint={ov.money.credit_owed_usd ? `${usd(ov.money.credit_owed_usd)} owed on credit` : "no credit owed"} />
            </div>
          </section>

          <section className="space-y-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Activity</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Jobs, 24 h" value={ov.jobs.last_24h.toLocaleString("en-US")} />
              <Stat label="Jobs, 30 d" value={ov.jobs.last_30d.toLocaleString("en-US")} hint={`${ov.jobs.failed_30d} failed`} tone={ov.jobs.failed_30d > ov.jobs.last_30d * 0.05 ? "bad" : undefined} />
              <Stat label="Accounts" value={ov.accounts.toLocaleString("en-US")} />
              <Stat
                label="Free-trial pot"
                value={`${usd(potLeft)} left`}
                hint={`${usd(ov.faucet.pot_used_usd)} of ${usd(ov.faucet.pot_usd)} used · ${ov.faucet.enabled ? "on" : "off"}`}
                tone={potLeft < ov.faucet.trial_usd ? "bad" : undefined}
              />
            </div>
            {Object.keys(ov.jobs.by_provider_30d).length > 0 && (
              <div className="rounded-2xl border border-line bg-card p-5">
                <p className="text-sm font-semibold">Jobs by provider, 30 d</p>
                <div className="mt-3 space-y-2">
                  {Object.entries(ov.jobs.by_provider_30d)
                    .sort((a, b) => b[1] - a[1])
                    .map(([p, n]) => (
                      <div key={p} className="grid grid-cols-[120px_1fr_60px] items-center gap-3 text-sm">
                        <span className="truncate text-muted">{p}</span>
                        <div className="h-2 rounded-full bg-black/5">
                          <div className="h-2 rounded-full bg-accent" style={{ width: `${(n / Math.max(1, ov.jobs.last_30d)) * 100}%` }} />
                        </div>
                        <span className="text-right font-mono text-xs tabular-nums">{n}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {credits && (
        <CreditsPanel
          c={credits}
          act={async (body) => {
            try {
              await call("/v1/admin/credits", body);
              await load();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        />
      )}

      {contracts && (
        <ContractsPanel
          c={contracts}
          busy={!!busy}
          act={async (id, action) => {
            setBusy(id + action);
            try {
              await call(`/v1/admin/contracts/${id}`, { action });
              await load();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Sellers</p>
            <p className="mt-1 text-sm text-muted">Approved automatically when a model passes its test. Pause or reject to override; that sticks until you approve again.</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-white/40 p-1 text-sm">
            {(["all", "approved", "pending", "paused", "rejected"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2.5 py-1 capitalize ${filter === f ? "bg-white/90 font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {sellers === null ? (
          <div className="h-32 animate-pulse rounded-2xl border border-line bg-card" />
        ) : shown.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line-strong p-8 text-center text-sm text-muted">No sellers{filter === "all" ? " yet" : ` with status “${filter}”`}.</p>
        ) : (
          shown.map((s) => (
            <div key={s.id} className="rounded-2xl border border-line bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold tracking-tight">{s.name}</p>
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium capitalize ${STATUS[s.status]}`}>{s.status}</span>
                    {s.operated_by_fuel && <span className="rounded-md bg-[#474747] px-2 py-0.5 text-xs font-medium text-white">Fuel-operated</span>}
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted">{s.endpoint_url}</p>
                  <p className="mt-0.5 text-xs text-faint">
                    {short(s.wallet)} · {s.contact ?? "no contact"} · applied {ago(s.created_at, now)} · {s.has_api_key ? "key stored" : "no key"}
                  </p>
                  {s.review_note && <p className="mt-1 text-xs text-muted">{s.review_note}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button disabled={!!busy} onClick={() => act(s.id, "probe")} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                    {busy === s.id + "probe" ? "Testing…" : "Re-test"}
                  </button>
                  {s.status !== "approved" && (
                    <button disabled={!!busy} onClick={() => act(s.id, "approve")} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-50">
                      Approve
                    </button>
                  )}
                  {s.status !== "paused" && (
                    <button disabled={!!busy} onClick={() => setAsking({ id: s.id, action: "pause", note: "" })} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                      Pause
                    </button>
                  )}
                  {s.status !== "rejected" && (
                    <button disabled={!!busy} onClick={() => setAsking({ id: s.id, action: "reject", note: "" })} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2 disabled:opacity-50">
                      Reject
                    </button>
                  )}
                </div>
              </div>
              {asking?.id === s.id && (
                <form
                  className="mt-4 flex flex-wrap gap-2 rounded-xl bg-white/50 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(s.id, asking.action, asking.note.trim() || undefined);
                  }}
                >
                  <input
                    autoFocus
                    value={asking.note}
                    onChange={(e) => setAsking({ ...asking, note: e.target.value })}
                    placeholder={`Reason to ${asking.action} (shown to the seller)`}
                    className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/80 px-3 py-1.5 text-sm"
                  />
                  <button className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium capitalize text-white hover:bg-accent-strong">{asking.action}</button>
                  <button type="button" onClick={() => setAsking(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2">
                    Cancel
                  </button>
                </form>
              )}
              <div className="mt-4 max-h-[28rem] overflow-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="sticky top-0 bg-card text-[11px] uppercase tracking-wider text-faint backdrop-blur">
                    <tr>
                      <th className="py-1.5 font-medium">Model</th>
                      <th className="py-1.5 font-medium">Price in / out</th>
                      <th className="py-1.5 font-medium">Test</th>
                      <th className="py-1.5 text-right font-medium">Tested</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {s.models.map((m) => (
                      <tr key={m.model}>
                        <td className="py-2 font-mono text-xs">{m.model}</td>
                        <td className="py-2 font-mono text-xs tabular-nums">
                          ${m.input_per_mtok} / ${m.output_per_mtok}
                        </td>
                        <td className={`py-2 text-xs ${m.probe_ok ? "text-ok" : "text-bad"}`}>{m.probe_ok ? `✓ ${m.probe_ms} ms` : `✕ ${m.probe_error ?? "not tested"}`}</td>
                        <td className="py-2 text-right text-xs text-faint">{ago(m.probed_at, now)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted">
                <span className="font-semibold text-ink">{s.jobs_served}</span> jobs served · earned <span className="font-semibold text-ink">{usd(s.earned_usd, 4)}</span>
                {s.operated_by_fuel && s.locked_cost_hr !== null && (
                  <>
                    {" "}
                    · locked at <span className="font-semibold text-ink">{usd(Number(s.locked_cost_hr))}/hr</span>
                    {s.locked_until ? ` until ${s.locked_until.slice(0, 10)}` : ""}
                  </>
                )}
              </p>
              <FuelOperatedForm
                s={s}
                save={async (body) => {
                  try {
                    await call(`/v1/admin/sellers/${s.id}`, body);
                    await load();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              />
            </div>
          ))
        )}
      </section>

      {ov && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-5">
            <p className="text-sm font-semibold">Deposit scanner</p>
            <ul className="max-h-96 overflow-y-auto pr-1 mt-3 space-y-1.5 text-sm">
              {ov.deposit_scanner.map((d) => (
                <li key={d.address} className="flex justify-between gap-3">
                  <span className="font-mono text-xs text-muted">{short(d.address)}</span>
                  <span className="text-xs">{ago(d.scanned_at, now)}</span>
                </li>
              ))}
              {ov.deposit_scanner.length === 0 && <li className="text-xs text-muted">No scans recorded.</li>}
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-card p-5">
            <p className="text-sm font-semibold">Private top-ups not credited</p>
            <ul className="max-h-96 overflow-y-auto pr-1 mt-3 space-y-1.5 text-sm">
              {ov.private_topups_needing_review.map((r) => (
                <li key={r.signature} className="flex justify-between gap-3">
                  <a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted hover:underline">
                    {r.signature.slice(0, 10)}…
                  </a>
                  <span className="text-xs">
                    {r.asset} · {r.status} · {ago(r.created_at, now)}
                  </span>
                </li>
              ))}
              {ov.private_topups_needing_review.length === 0 && <li className="text-xs text-muted">None.</li>}
            </ul>
          </div>
          {ov.compliance && (
            <div className="rounded-2xl border border-line bg-card p-5 lg:col-span-2">
              <p className="text-sm font-semibold">Compliance</p>
              <p className="mt-1 text-xs text-muted">
                {ov.compliance.sanctioned_wallets} sanctioned wallet(s) screened (OFAC SDN, refreshed daily at 03:00 UTC). Suspend or restore with POST /v1/admin/accounts/:wallet.
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold text-muted">Suspended accounts</p>
                  <ul className="max-h-96 overflow-y-auto pr-1 mt-1.5 space-y-1.5 text-sm">
                    {ov.compliance.suspended_accounts.map((a) => (
                      <li key={a.wallet} className="flex justify-between gap-3">
                        <span className="font-mono text-xs text-muted">{short(a.wallet)}</span>
                        <span className="text-xs">
                          {a.suspended_reason ?? "no reason given"} · {ago(a.suspended_at, now)}
                        </span>
                      </li>
                    ))}
                    {ov.compliance.suspended_accounts.length === 0 && <li className="text-xs text-muted">None.</li>}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold text-muted">Blocked deposits (not credited)</p>
                  <ul className="max-h-96 overflow-y-auto pr-1 mt-1.5 space-y-1.5 text-sm">
                    {ov.compliance.blocked_deposits.map((b) => (
                      <li key={b.signature} className="flex justify-between gap-3">
                        <a href={`https://solscan.io/tx/${b.signature}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted hover:underline">
                          {b.signature.slice(0, 10)}…
                        </a>
                        <span className="text-xs">
                          {b.asset} from {short(b.sender)} · {ago(b.created_at, now)}
                        </span>
                      </li>
                    ))}
                    {ov.compliance.blocked_deposits.length === 0 && <li className="text-xs text-muted">None.</li>}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
      <AdminPayouts call={call} />
    </div>
  );
}

type AdminPayout = { id: string; wallet: string; amount_usd: number; status: string; note: string | null; signature: string | null; requested_at: string; pay_link?: string; reference?: string };
type AdminCall = <T>(path: string, body?: unknown) => Promise<T>;

/**
 * Earnings payouts queue. Approve → a Solana Pay link to sign in your own wallet (Fuel holds no key
 * that can send money); the cron spots the transfer by its reference and marks it paid. Or paste the
 * transaction signature. Reject puts the amount back on the account.
 */
function AdminPayouts({ call }: { call: AdminCall }) {
  const [data, setData] = useState<{ open: AdminPayout[]; recent: AdminPayout[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sig, setSig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    call<{ open: AdminPayout[]; recent: AdminPayout[] }>("/v1/admin/payouts").then(setData).catch((e) => setMsg((e as Error).message));
  }, [call]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);
  async function act(id: string, body: Record<string, string>) {
    setBusy(id + body.action);
    setMsg(null);
    try {
      await call(`/v1/admin/payouts/${id}`, body);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  if (!data) return null;
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold">Earnings payouts</p>
        <p className="text-xs text-muted">{data.open.length} open</p>
      </div>
      <p className="text-xs text-muted">
        Approve, then open the pay link in your wallet (or send that USDC amount to the wallet by hand and paste the signature). Fuel checks the transfer on-chain before marking it paid.
      </p>
      {msg && <p className="text-sm text-bad">{msg}</p>}
      <ul className="max-h-96 overflow-y-auto pr-1 space-y-3 text-sm">
        {data.open.map((p) => (
          <li key={p.id} className="space-y-2 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>${p.amount_usd.toFixed(2)}</strong> USDC to <span className="font-mono text-xs">{p.wallet}</span>
              </span>
              <span className="text-xs text-muted">
                {p.status} · {new Date(p.requested_at).toLocaleString()}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {p.status === "requested" && (
                <button disabled={!!busy} onClick={() => act(p.id, { action: "approve" })} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                  Approve
                </button>
              )}
              {p.pay_link && (
                <a href={p.pay_link} className="rounded-lg px-3 py-1.5 text-xs font-medium btn-2">
                  Pay in wallet
                </a>
              )}
              <button
                disabled={!!busy}
                onClick={() => {
                  const note = window.prompt("Reason for rejecting (shown to the user)") ?? "";
                  if (note) void act(p.id, { action: "reject", note });
                }}
                className="text-xs text-bad underline disabled:opacity-50"
              >
                Reject
              </button>
            </div>
            {p.status === "approved" && (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(p.id, { action: "paid", signature: (sig[p.id] ?? "").trim() });
                }}
              >
                <input value={sig[p.id] ?? ""} onChange={(e) => setSig((s) => ({ ...s, [p.id]: e.target.value }))} placeholder="Transaction signature (if sent by hand)" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/70 px-3 py-1.5 font-mono text-xs" />
                <button disabled={!!busy || !sig[p.id]} className="rounded-lg px-3 py-1.5 text-xs btn-2 disabled:opacity-50">
                  Mark paid
                </button>
              </form>
            )}
          </li>
        ))}
        {data.open.length === 0 && <li className="text-xs text-muted">No open payouts.</li>}
      </ul>
      {data.recent.length > 0 && (
        <ul className="max-h-96 overflow-y-auto pr-1 space-y-1.5 text-sm">
          {data.recent.map((p) => (
            <li key={p.id} className="flex flex-wrap justify-between gap-2 border-t border-line pt-1.5 text-xs">
              <span className="font-mono text-muted">{p.wallet.slice(0, 4)}…{p.wallet.slice(-4)}</span>
              <span>
                ${p.amount_usd.toFixed(2)} · {p.status}
              </span>
              {p.signature ? (
                <a href={`https://solscan.io/tx/${p.signature}`} target="_blank" rel="noreferrer" className="font-mono text-muted hover:underline">
                  {p.signature.slice(0, 10)}…
                </a>
              ) : (
                <span className="text-muted">{p.note ?? "—"}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
