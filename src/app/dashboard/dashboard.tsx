"use client";

import Link from "next/link";
import bs58 from "bs58";
import { getWallets } from "@wallet-standard/app";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { connectEvmWallet } from "@/components/fuel-key";

type AgentProfile = { name: string; display_name: string; description: string | null; x_handle: string | null; website: string | null };
type Faucet = {
  enabled: boolean;
  trial: { amount_usd: number; claimed: boolean; tokens_estimate: number | null; tokens_model: string };
  credit: { limit_usd: number; used_usd: number; available_usd: number; due_at: string | null; overdue: boolean; paid_in_total_usd: number; share_of_topups: number };
  rules: { max_credit_per_agent_usd: number | null; due_days: number; pot_left_usd: number };
};
type Account = {
  wallet: string;
  balance_usd: number;
  held_usd: number;
  available_usd: number;
  spent_today_usd: number;
  jobs_completed: number;
  limits: { daily_usd: number | null; per_job_usd: number | null; remaining_today_usd: number | null };
  deposit: { address: string | null; how: string; chain?: "solana" | "robinhood"; chain_id?: number; assets?: Record<string, string> };
  agent: AgentProfile | null;
  faucet: Faucet;
};
type Job = {
  id: string;
  model: string;
  kind: string;
  status: string;
  provider: string | null;
  price_usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  failovers: number;
  created_at: string;
};
type Deposit = { signature: string; asset: string; amount: number; credited_usd: number; created_at: string; private?: boolean; status?: string };
type RingInfo = { enabled: boolean; ring_address?: string; max_per_topup_usd?: number | null; limited_beta?: boolean; network?: string };
type Key = { id: string; prefix: string; label: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null };

type SolanaProvider = {
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signMessage: (msg: Uint8Array, display?: string) => Promise<{ signature: Uint8Array }>;
};

const STORE = "fuel.dashboard.key";
const usd = (n: number, dp = 4) => `$${n.toFixed(dp)}`;
const when = (iso: string) => new Date(iso).toLocaleString();

function getWallet(): SolanaProvider | null {
  const w = window as unknown as { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider };
  return w.phantom?.solana ?? w.solana ?? null;
}

// The API key lives in sessionStorage (this tab only). A tiny store so React can read it without effects.
const listeners = new Set<() => void>();
let memoryKey: string | null = null; // used if storage is blocked
function load(): string | null {
  try {
    return sessionStorage.getItem(STORE) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}
function save(key: string | null) {
  memoryKey = key;
  try {
    if (key) sessionStorage.setItem(STORE, key);
    else sessionStorage.removeItem(STORE);
  } catch {}
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const noSubscribe = () => () => {};

export default function Dashboard() {
  const key = useSyncExternalStore(subscribe, load, () => null);
  const setKey = save;
  // Arrived from /trial: talk about the trial and put the claim first.
  const trial = useSyncExternalStore(noSubscribe, () => new URLSearchParams(window.location.search).has("trial"), () => false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [ring, setRing] = useState<RingInfo | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasteKey, setPasteKey] = useState("");

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      return body;
    },
    [key],
  );

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!key) return;
    let stale = false;
    (async () => {
      try {
        const [a, j, d, k, p, r] = await Promise.all([
          call("/v1/account"),
          call("/v1/jobs?limit=100"),
          call("/v1/topups"),
          call("/v1/auth/keys"),
          call("/v1/topups/private/history"),
          fetch("/v1/topups/private").then((x) => x.json()),
        ]);
        if (stale) return;
        setAccount(a);
        setJobs(j.data);
        setDeposits(
          [...d.data, ...p.data.map((x: Deposit) => ({ ...x, private: true }))].sort((x: Deposit, y: Deposit) => y.created_at.localeCompare(x.created_at)),
        );
        setRing(r);
        setKeys(k.data);
        setError(null);
      } catch (e) {
        if (stale) return;
        setError((e as Error).message);
        if ((e as Error).message.toLowerCase().includes("api key")) save(null);
      }
    })();
    return () => {
      stale = true;
    };
  }, [key, call, tick]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const provider = getWallet();
      if (!provider) throw new Error("No Solana wallet found in this browser. Install Phantom, or paste an API key below.");
      const { publicKey } = await provider.connect();
      const wallet = publicKey.toString();
      const n = await fetch("/v1/auth/nonce", { method: "POST", body: JSON.stringify({ wallet }), headers: { "content-type": "application/json" } }).then((r) => r.json());
      if (!n.message) throw new Error(n?.error?.message ?? "Could not start sign-in.");
      const { signature } = await provider.signMessage(new TextEncoder().encode(n.message), "utf8");
      const sig = btoa(String.fromCharCode(...signature));
      const res = await fetch("/v1/auth/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, nonce: n.nonce, signature: sig, label: "dashboard" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "Sign-in failed.");
      save(body.api_key);
      setNewKey(body.api_key);
      setKey(body.api_key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    save(null);
    setKey(null);
    setAccount(null);
    setNewKey(null);
  }

  if (!key) {
    return (
      <Shell>
        <div className="mx-auto mt-8 max-w-md space-y-5 sm:mt-16 sm:space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">{trial ? "Start your free trial" : "Dashboard"}</h1>
            <p className="mt-2 text-sm text-muted">
              {trial
                ? "Connect the agent's wallet and sign a message (it costs nothing). Then claim your free credits and copy your API key."
                : "Your wallet is your account. Sign a message to see your balance, receipts and limits. Signing costs nothing."}
            </p>
          </div>
          <button onClick={connect} disabled={busy} className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50 sm:py-3 sm:text-base">
            {busy ? "Waiting for wallet…" : "Connect Solana wallet · USDC, SOL"}
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const k = await connectEvmWallet("dashboard");
                save(k);
                setNewKey(k);
                setKey(k);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="w-full rounded-lg px-4 py-2.5 text-sm font-medium btn-2 disabled:opacity-50 sm:py-3 sm:text-base"
          >
            Connect EVM wallet · USDG
          </button>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (pasteKey.trim()) {
                save(pasteKey.trim());
                setKey(pasteKey.trim());
              }
            }}
          >
            <label className="text-xs text-muted">Or use an existing API key</label>
            <div className="flex gap-2">
              <input value={pasteKey} onChange={(e) => setPasteKey(e.target.value)} placeholder="fuel_sk_…" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-sm" />
              <button className="rounded-lg px-4 text-sm btn-2">Open</button>
            </div>
          </form>
          {error && <p className="text-sm text-bad">{error}</p>}
        </div>
      </Shell>
    );
  }

  return (
    <Shell onSignOut={signOut}>
      {newKey && (
        <div className="rounded-lg border border-accent/50 bg-accent/10 p-4 text-sm">
          <p className="font-medium">Your new API key. Copy it now: it won&apos;t be shown again.</p>
          <code className="mt-2 block break-all rounded bg-bg p-2 font-mono text-xs border border-line">{newKey}</code>
          <button onClick={() => setNewKey(null)} className="mt-2 text-xs text-muted underline">I&apos;ve saved it</button>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {account && (
        <>
          <p className="truncate font-mono text-xs text-muted">{account.wallet}</p>
          {trial && account.faucet?.enabled && !account.faucet.trial.claimed && <FaucetPanel faucet={account.faucet} balance={account.balance_usd} call={call} onDone={refresh} />}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Available" value={usd(account.available_usd, 2)} />
            <Stat label="Held for running jobs" value={usd(account.held_usd, 4)} />
            <Stat label="Spent today (UTC)" value={usd(account.spent_today_usd, 4)} />
            <Stat label="Jobs completed" value={String(account.jobs_completed)} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <TopUp account={account} call={call} onDone={refresh} />
            <Limits account={account} call={call} onDone={refresh} />
          </div>
          {account.faucet?.enabled && !(trial && !account.faucet.trial.claimed) && <FaucetPanel faucet={account.faucet} balance={account.balance_usd} call={call} onDone={refresh} />}
          {ring?.enabled && <PrivateTopUp ring={ring} call={call} onDone={refresh} />}
          <AgentPanel key={account.agent?.name ?? "new"} agent={account.agent} call={call} onDone={refresh} />
          <Earnings key={`earn-${tick}`} call={call} onDone={refresh} />
        </>
      )}
      <Section title="Receipts">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted">No jobs yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-card text-xs uppercase text-muted backdrop-blur">
                <tr>
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Model</th>
                  <th className="py-2 pr-4">Provider</th>
                  <th className="py-2 pr-4 text-right">Tokens in/out</th>
                  <th className="py-2 pr-4 text-right">Time (ms)</th>
                  <th className="py-2 pr-4 text-right">Price</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-line">
                    <td className="whitespace-nowrap py-2 pr-4 text-muted">{when(j.created_at)}</td>
                    <td className="max-w-56 truncate py-2 pr-4 font-mono text-xs">{j.model}</td>
                    <td className="py-2 pr-4">
                      {j.provider ?? "—"}
                      {j.failovers > 0 && <span className="ml-1 text-xs text-accent">+{j.failovers} failover</span>}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{j.input_tokens ?? "—"} / {j.output_tokens ?? "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{j.latency_ms ?? "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{usd(j.price_usd, 6)}</td>
                    <td className="py-2">{j.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Deposits">
        {deposits.length === 0 ? (
          <p className="text-sm text-muted">No deposits yet.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto pr-1 space-y-1 text-sm">
            {deposits.map((d) => (
              <li key={d.signature + (d.private ? ":p" : "")} className="flex flex-wrap justify-between gap-2 border-t border-line py-2">
                <span className="text-muted">
                  {when(d.created_at)}
                  {d.private && <span className="ml-2 rounded bg-private/10 px-1.5 py-0.5 text-xs text-private">private</span>}
                </span>
                <span>
                  {d.amount} {d.asset} → <strong>{usd(d.credited_usd, 2)}</strong>
                  {d.status && d.status !== "credited" && <span className="ml-2 text-xs text-accent">{d.status.replace("_", " ")}</span>}
                </span>
                <a className="font-mono text-xs text-muted underline" href={`https://solscan.io/tx/${d.signature}`} target="_blank" rel="noreferrer">
                  {d.signature.slice(0, 10)}…
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="API keys">
        <ul className="max-h-80 overflow-y-auto pr-1 space-y-1 text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2">
              <span className="font-mono text-xs">{k.prefix}…</span>
              <span className="text-muted">{k.label ?? "no label"}</span>
              <span className="text-muted">{k.last_used_at ? `used ${when(k.last_used_at)}` : "never used"}</span>
              {k.revoked_at ? (
                <span className="text-xs text-muted">revoked</span>
              ) : (
                <button
                  className="text-xs text-bad underline"
                  onClick={async () => {
                    await call(`/v1/auth/keys/${k.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
                    void refresh();
                  }}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </Section>
      <OwnKeys call={call} />
    </Shell>
  );
}

type ByokInfo = { available: string[]; fee_usd_per_job: number; keys: { provider: string; key: string; added_at: string }[] };

type Payout = { id: string; amount_usd: number; status: string; signature: string | null; note: string | null; requested_at: string; paid_at: string | null };
type PayoutInfo = { available_usd: number; earned_total_usd: number; paid_out_usd: number; minimum_usd: number; payouts: Payout[] };

/** Earnings payouts in USDC: only shown to wallets that have earned (GPU sellers, laptop-lane workers). */
function Earnings({ call, onDone }: { call: Call; onDone: () => void }) {
  const [info, setInfo] = useState<PayoutInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      (call("/v1/payouts") as Promise<PayoutInfo>).then(setInfo).catch(() => setInfo(null));
    }, 0);
    return () => clearTimeout(t);
  }, [call]);
  if (!info || (info.earned_total_usd <= 0 && info.payouts.length === 0)) return null;
  const open = info.payouts.find((p) => p.status === "requested" || p.status === "approved");
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Earnings payouts">
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Stat label="Earned in total" value={usd(info.earned_total_usd, 2)} />
        <Stat label="Paid out" value={usd(info.paid_out_usd, 2)} />
        <Stat label="You can withdraw" value={usd(info.available_usd, 2)} />
      </div>
      <p className="mb-3 text-sm text-muted">
        Withdraw what you&apos;ve earned selling compute or running the laptop lane, in USDC (Solana wallets) or USDG on Robinhood Chain (EVM wallets) to this wallet. Deposits can&apos;t be withdrawn. Minimum {usd(info.minimum_usd, 2)}; payouts are reviewed and sent within a few days.
      </p>
      {open ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
          <span>
            {usd(open.amount_usd, 2)} payout {open.status === "approved" ? "approved, being sent" : "waiting for review"}
          </span>
          {open.status === "requested" && (
            <button disabled={busy} className="text-xs text-bad underline disabled:opacity-50" onClick={() => act(() => call(`/v1/payouts/${open.id}/cancel`, { method: "POST" }), "Cancelled. The amount is back in your balance.")}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => call("/v1/payouts", { method: "POST", body: JSON.stringify({ amount_usd: Number(amount) }) }), "Requested. You'll see it here when it's paid.");
          }}
        >
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount in USD" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/70 px-3 py-1.5 text-sm" />
          <button type="button" className="rounded-lg px-3 py-1.5 text-sm btn-2" onClick={() => setAmount(String(Math.floor(info.available_usd * 100) / 100))}>
            Max
          </button>
          <button disabled={busy || info.available_usd < info.minimum_usd} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50">
            Request payout
          </button>
        </form>
      )}
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
      {info.payouts.length > 0 && (
        <ul className="mt-3 max-h-80 overflow-y-auto pr-1 space-y-1 text-sm">
          {info.payouts.map((p) => (
            <li key={p.id} className="flex flex-wrap justify-between gap-2 border-t border-line py-2">
              <span className="text-muted">{when(p.requested_at)}</span>
              <span>
                {usd(p.amount_usd, 2)} · {p.status}
                {p.note && p.status === "rejected" && <span className="ml-1 text-xs text-muted">({p.note})</span>}
              </span>
              {p.signature ? (
                <a className="font-mono text-xs text-muted underline" href={`https://solscan.io/tx/${p.signature}`} target="_blank" rel="noreferrer">
                  {p.signature.slice(0, 10)}…
                </a>
              ) : (
                <span className="text-xs text-muted">—</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Bring your own key: only shown once a provider is switched on for BYOK. */
function OwnKeys({ call }: { call: Call }) {
  const [info, setInfo] = useState<ByokInfo | null>(null);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    (call("/v1/byok") as Promise<ByokInfo>)
      .then((i) => {
        setInfo(i);
        setProvider((p) => p || i.available[0] || "");
      })
      .catch(() => setInfo(null));
  }, [call]);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);
  if (!info || info.available.length === 0) return null;
  return (
    <Section title="Your own provider keys">
      <p className="mb-3 text-sm text-muted">
        Use your own {info.available.join(" or ")} key: the provider bills you directly, and Fuel adds routing, receipts and limits
        {info.fee_usd_per_job ? ` for $${info.fee_usd_per_job} a job` : " at no charge"}. Call models as <code className="font-mono">openai/…</code> or{" "}
        <code className="font-mono">anthropic/…</code>. Keys are encrypted and never shown again.
      </p>
      <ul className="mb-3 space-y-1 text-sm">
        {info.keys.map((k) => (
          <li key={k.provider} className="flex items-center justify-between gap-2 border-t border-line py-2">
            <span className="capitalize">{k.provider}</span>
            <span className="font-mono text-xs text-muted">{k.key}</span>
            <button
              className="text-xs text-bad underline"
              onClick={async () => {
                await call(`/v1/byok/${k.provider}`, { method: "DELETE" }).catch((e) => setMsg(e.message));
                load();
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          try {
            await call("/v1/byok", { method: "POST", body: JSON.stringify({ provider, api_key: key }) });
            setKey("");
            setMsg("Key saved.");
            load();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded-lg border border-line-strong bg-white/70 px-2 py-1.5 text-sm capitalize">
          {info.available.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Your API key" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/70 px-3 py-1.5 text-sm" />
        <button className="rounded-lg px-3 py-1.5 text-sm font-medium btn-2">Save key</button>
      </form>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </Section>
  );
}

function Shell({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8">
      {onSignOut && (
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <button onClick={onSignOut} className="text-sm text-muted hover:text-ink">
            Sign out
          </button>
        </div>
      )}
      {children}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line p-4">
      <h2 className="mb-3 font-medium">{title}</h2>
      {children}
    </section>
  );
}

type Call = (path: string, init?: RequestInit) => Promise<unknown>;

function TopUp({ account, call, onDone }: { account: Account; call: Call; onDone: () => void }) {
  const [sig, setSig] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Section title="Top up">
      {account.deposit.address ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted">{account.deposit.chain === "robinhood" ? "Send USDG on Robinhood Chain from your wallet to:" : "Send USDC or SOL from your wallet to:"}</p>
          <code className="block break-all rounded bg-bg p-2 font-mono text-xs border border-line">{account.deposit.address}</code>
          <p className="text-muted">
            {account.deposit.chain === "robinhood"
              ? "Then paste the transaction hash (Fuel also finds it on its own within minutes). USDG is credited 1:1."
              : "Then paste the transaction signature. USDC is credited 1:1; SOL at the current price minus 0.5%."}
          </p>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setMsg("Checking the chain…");
              try {
                if (account.deposit.chain === "robinhood") {
                  const d = (await call("/v1/topups/usdg", { method: "POST", body: JSON.stringify({ tx_hash: sig.trim() }) })) as { credited_usd: number; already_credited: boolean };
                  setMsg(d.already_credited ? "Already credited." : `Credited ${usd(d.credited_usd, 2)}.`);
                } else {
                  const d = (await call("/v1/topups", { method: "POST", body: JSON.stringify({ signature: sig.trim() }) })) as { credited_usd: number; credited_now: boolean };
                  setMsg(d.credited_now ? `Credited ${usd(d.credited_usd, 2)}.` : `Already credited (${usd(d.credited_usd, 2)}).`);
                }
                setSig("");
                onDone();
              } catch (err) {
                setMsg((err as Error).message);
              }
            }}
          >
            <input value={sig} onChange={(e) => setSig(e.target.value)} placeholder={account.deposit.chain === "robinhood" ? "Transaction hash (0x…)" : "Transaction signature"} className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-xs" />
            <button className="rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-strong">Confirm</button>
          </form>
          {msg && <p className="text-xs text-muted">{msg}</p>}
        </div>
      ) : (
        <p className="text-sm text-muted">{account.deposit.chain === "robinhood" ? "USDG top-ups on Robinhood Chain are opening soon." : "Deposits are not open yet."}</p>
      )}
    </Section>
  );
}

function Limits({ account, call, onDone }: { account: Account; call: Call; onDone: () => void }) {
  const [daily, setDaily] = useState(account.limits.daily_usd?.toString() ?? "");
  const [perJob, setPerJob] = useState(account.limits.per_job_usd?.toString() ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const parse = (s: string) => (s.trim() === "" ? null : Number(s));
  const left = account.limits.remaining_today_usd;
  return (
    <Section title="Spending limits">
      <form
        className="mb-4 space-y-2 border-b border-line pb-4 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!words.trim()) return;
          try {
            const r = (await call("/v1/account/budget", { method: "POST", body: JSON.stringify({ text: words }) })) as { understood: string; limits: { daily_usd: number | null; per_job_usd: number | null } };
            setDaily(r.limits.daily_usd?.toString() ?? "");
            setPerJob(r.limits.per_job_usd?.toString() ?? "");
            setWords("");
            setMsg(`Saved: ${r.understood}.`);
            onDone();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <label className="block">
          <span className="text-muted">Say it in words</span>
          <div className="mt-1 flex gap-2">
            <input
              value={words}
              onChange={(e) => setWords(e.target.value)}
              placeholder="At most $5 a day, no job over 10 cents"
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2"
            />
            <button className="rounded-lg px-4 btn-2">Set</button>
          </div>
        </label>
        {left !== null && <p className="text-xs text-muted">Left today: ${left.toFixed(2)} of ${account.limits.daily_usd?.toFixed(2)}</p>}
      </form>
      <form
        className="space-y-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call("/v1/account", { method: "PATCH", body: JSON.stringify({ daily_usd: parse(daily), per_job_usd: parse(perJob) }) });
            setMsg("Saved.");
            onDone();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        <label className="block">
          <span className="text-muted">Daily limit (USD, blank = none)</span>
          <input value={daily} onChange={(e) => setDaily(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2" />
        </label>
        <label className="block">
          <span className="text-muted">Per-job limit (USD, blank = none)</span>
          <input value={perJob} onChange={(e) => setPerJob(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2" />
        </label>
        <button className="rounded-lg px-4 py-2 btn-2">Save limits</button>
        {msg && <p className="text-xs text-muted">{msg}</p>}
      </form>
    </Section>
  );
}

function PrivateTopUp({ ring, call, onDone }: { ring: RingInfo; call: Call; onDone: () => void }) {
  const [sig, setSig] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Section title="Private top-up">
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Send a private transfer (Solana Privacy Rings) from your wallet&apos;s private balance. On-chain, people can see that you paid Fuel, but not the asset or the amount.
          {ring.max_per_topup_usd ? ` Beta: up to $${ring.max_per_topup_usd} per top-up.` : ""}
        </p>
        <p className="text-muted">Fuel&apos;s ring address:</p>
        <code className="block break-all rounded bg-bg p-2 font-mono text-xs border border-line">{ring.ring_address}</code>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg("Decrypting…");
            try {
              const d = (await call("/v1/topups/private/confirm", { method: "POST", body: JSON.stringify({ signature: sig.trim() }) })) as { credited_usd: number };
              setMsg(`Credited ${usd(d.credited_usd, 2)}.`);
              setSig("");
              onDone();
            } catch (err) {
              setMsg((err as Error).message);
            }
          }}
        >
          <input value={sig} onChange={(e) => setSig(e.target.value)} placeholder="Private transfer signature" className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-xs" />
          <button className="rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-strong">Confirm</button>
        </form>
        <p className="text-xs text-muted">Fuel also checks every 5 minutes, so confirming just makes it faster.</p>
        {msg && <p className="text-xs text-muted">{msg}</p>}
      </div>
    </Section>
  );
}

function AgentPanel({ agent, call, onDone }: { agent: AgentProfile | null; call: Call; onDone: () => void }) {
  const [form, setForm] = useState({
    name: agent?.name ?? "",
    display_name: agent?.display_name ?? "",
    description: agent?.description ?? "",
    x_handle: agent?.x_handle ?? "",
    website: agent?.website ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const field = (k: keyof typeof form, label: string, extra: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {}) => (
    <label className="block">
      <span className="text-muted">{label}</span>
      <input
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 disabled:opacity-60"
        {...extra}
      />
    </label>
  );
  return (
    <Section title={agent ? "Your public agent" : "Make your agent public"}>
      <form
        className="grid gap-3 text-sm sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const body: Record<string, string | null> = {
              display_name: form.display_name,
              description: form.description || null,
              x_handle: form.x_handle || null,
              website: form.website || null,
            };
            if (!agent) body.name = form.name;
            await call("/v1/agents", { method: "POST", body: JSON.stringify(body) });
            setMsg(agent ? "Saved." : "Your agent page is live.");
            onDone();
          } catch (err) {
            setMsg((err as Error).message);
          }
        }}
      >
        {!agent && (
          <p className="text-muted sm:col-span-2">
            Give this wallet a public page where anyone can fuel it. Public: balance, job count and community top-ups. Never job details.
          </p>
        )}
        {field("name", "Name (permanent, a-z 0-9 -)", { disabled: !!agent, required: true, placeholder: "my-agent", pattern: "[a-z0-9][a-z0-9-]{1,30}[a-z0-9]" })}
        {field("display_name", "Display name", { required: true, maxLength: 48 })}
        <label className="block sm:col-span-2">
          <span className="text-muted">Description</span>
          <textarea
            value={form.description}
            maxLength={280}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="mt-1 w-full rounded-lg border border-line-strong bg-transparent px-3 py-2"
            rows={2}
          />
        </label>
        {field("x_handle", "X handle", { placeholder: "@handle" })}
        {field("website", "Website", { placeholder: "https://" })}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button className="rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong">{agent ? "Save" : "Create agent page"}</button>
          {agent && (
            <Link href={`/agent/${agent.name}`} className="text-muted underline">
              View /agent/{agent.name}
            </Link>
          )}
          {msg && <span className="text-xs text-muted">{msg}</span>}
        </div>
      </form>
      {agent && <FeeSources call={call} onDone={onDone} />}
    </Section>
  );
}

type FeeSource = { wallet: string; label: string | null; linked_at: string };
type StdAccount = { address: string; chains: readonly string[] };
type StdWallet = { name: string; chains: readonly string[]; features: Record<string, unknown> };

/** Self-fuelling: link the wallet that receives this project's token fees. The fee wallet signs. */
function FeeSources({ call, onDone }: { call: Call; onDone: () => void }) {
  const [sources, setSources] = useState<FeeSource[] | null>(null);
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stale = false;
    (call("/v1/agents/fee-sources") as Promise<{ data: FeeSource[] }>)
      .then((r) => {
        if (!stale) setSources(r.data);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [call, tick]);

  async function link() {
    setMsg(null);
    try {
      const wallets = (getWallets().get() as unknown as StdWallet[]).filter(
        (w) => w.chains.some((c) => c.startsWith("solana:")) && "solana:signMessage" in w.features && "standard:connect" in w.features,
      );
      if (!wallets.length) throw new Error("No Solana wallet that can sign messages was found in this browser.");
      setMsg(`Connect the FEE wallet in ${wallets[0].name} (switch accounts there if needed)…`);
      const { accounts } = await (wallets[0].features["standard:connect"] as { connect: () => Promise<{ accounts: readonly StdAccount[] }> }).connect();
      const account = accounts[0];
      if (!account) throw new Error("No account selected.");
      const n = (await call("/v1/agents/fee-sources/nonce", { method: "POST", body: JSON.stringify({ source: account.address }) })) as { nonce: string; message: string };
      setMsg("Sign the message in your wallet…");
      const sign = wallets[0].features["solana:signMessage"] as {
        signMessage: (i: { account: StdAccount; message: Uint8Array }) => Promise<readonly { signature: Uint8Array }[]>;
      };
      const [out] = await sign.signMessage({ account, message: new TextEncoder().encode(n.message) });
      await call("/v1/agents/fee-sources", {
        method: "POST",
        body: JSON.stringify({ source: account.address, nonce: n.nonce, signature: bs58.encode(out.signature), label: label || undefined }),
      });
      setMsg(`Linked ${account.address.slice(0, 4)}…${account.address.slice(-4)}.`);
      setLabel("");
      setTick((t) => t + 1);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4 text-sm">
      <h3 className="font-medium">Self-fuelling</h3>
      <p className="text-muted">
        Link the wallet that receives your project&apos;s token fees. Anything it sends to Fuel&apos;s deposit address is credited to this agent automatically, with no
        confirm step. The fee wallet signs to agree, so nobody can link a wallet they don&apos;t control.
      </p>
      {sources && sources.length > 0 && (
        <ul className="max-h-80 overflow-y-auto pr-1 space-y-1">
          {sources.map((s) => (
            <li key={s.wallet} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-3 py-2">
              <span className="font-mono text-xs">{s.wallet}</span>
              <span className="text-muted">{s.label ?? ""}</span>
              <button
                className="text-xs text-bad underline"
                onClick={async () => {
                  await call(`/v1/agents/fee-sources/${s.wallet}`, { method: "DELETE" }).catch((e) => setMsg((e as Error).message));
                  setTick((t) => t + 1);
                }}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional), e.g. Meteora fees"
          maxLength={48}
          className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2"
        />
        <button onClick={() => void link()} className="rounded-lg px-4 py-2 btn-2">
          Link a fee wallet
        </button>
      </div>
      {msg && <p className="text-xs text-muted">{msg}</p>}
    </div>
  );
}

function FaucetPanel({ faucet, balance, call, onDone }: { faucet: Faucet; balance: number; call: Call; onDone: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const c = faucet.credit;
  return (
    <Section title="Free trial & pay-later credit">
      <div className="grid gap-4 text-sm md:grid-cols-2">
        <div className="space-y-2">
          <p className="font-medium">Free trial</p>
          {faucet.trial.claimed ? (
            <p className="text-muted">Claimed: your free credits are in your balance, yours to keep.</p>
          ) : (
            <>
              <p className="text-muted">
                Free credits to try Fuel
                {faucet.trial.tokens_estimate ? ` (about ${(faucet.trial.tokens_estimate / 1e6).toFixed(1)}M tokens on ${faucet.trial.tokens_model.split("/").pop()})` : ""}, once per
                wallet. Any wallet can claim; nothing to repay.
              </p>
              <button
                onClick={async () => {
                  setMsg(null);
                  try {
                    await call("/v1/faucet/claim", { method: "POST" });
                    setMsg("Free credits added.");
                    onDone();
                  } catch (e) {
                    setMsg((e as Error).message);
                  }
                }}
                className="rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong"
              >
                Claim free credits
              </button>
            </>
          )}
          {msg && <p className="text-xs text-muted">{msg}</p>}
        </div>
        <div className="space-y-2">
          <p className="font-medium">Pay later</p>
          <p className="text-muted">
            Run jobs now and pay later, up to {+(c.share_of_topups * 100).toFixed(2)}% of everything you&apos;ve deposited (${c.paid_in_total_usd.toFixed(2)} so far). Your
            next top-up repays it first. Unpaid after {faucet.rules.due_days} days, jobs pause until it&apos;s repaid.
          </p>
          <p>
            Limit <strong>${c.limit_usd.toFixed(2)}</strong> · in use <strong>${c.used_usd.toFixed(4)}</strong>
            {balance < 0 && <span className="text-accent"> · you owe ${(-balance).toFixed(4)}</span>}
          </p>
          {c.due_at && (
            <p className={c.overdue ? "text-bad" : "text-muted"}>
              {c.overdue ? "Overdue: top up to repay and unpause jobs." : `Due by ${new Date(c.due_at).toLocaleDateString()}.`}
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}
