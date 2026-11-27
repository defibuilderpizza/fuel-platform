"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { laneKeypair, open, seal, sharedKey } from "@/lib/lane-crypto";

// The laptop-lane worker. Runs in a normal browser tab: no install. It loads a small
// embedding model, then asks Fuel for work, does it, and hands back the result, sealed to
// the job. Pay arrives as Fuel balance for each result another laptop agreed with.

type Stats = { verified: number; rejected: number; timeouts: number; earned_usd: number; banned: boolean };
type Task = { id: string; job_id: string; server_pubkey: string; ciphertext: string };
type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

// Same key store as the dashboard (this tab's sessionStorage), so signing in once covers both.
const STORE = "fuel.dashboard.key";
const listeners = new Set<() => void>();
let memoryKey: string | null = null;
const load = () => {
  try {
    return sessionStorage.getItem(STORE) ?? memoryKey;
  } catch {
    return memoryKey;
  }
};
const save = (k: string | null) => {
  memoryKey = k;
  try {
    if (k) sessionStorage.setItem(STORE, k);
    else sessionStorage.removeItem(STORE);
  } catch {}
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

type Injected = {
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signMessage: (m: Uint8Array, d?: string) => Promise<{ signature: Uint8Array }>;
};

export default function LaneWorker() {
  const key = useSyncExternalStore(subscribe, load, () => null);
  const [paste, setPaste] = useState("");
  const [status, setStatus] = useState("Stopped");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);
  const extractor = useRef<Extractor | null>(null);

  const call = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(j?.error?.message ?? `Request failed (${res.status})`), { code: j?.error?.code, status: res.status });
      return j;
    },
    [key],
  );

  const refreshStats = useCallback(() => {
    if (key) call("/v1/lane/stats").then(setStats).catch(() => {});
  }, [key, call]);

  useEffect(() => {
    if (!key) return;
    const first = setTimeout(refreshStats, 0);
    const t = setInterval(refreshStats, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [key, refreshStats]);

  async function connectWallet() {
    setError(null);
    try {
      const w = window as unknown as { phantom?: { solana?: Injected }; solana?: Injected };
      const provider = w.phantom?.solana ?? w.solana;
      if (!provider) throw new Error("No Solana wallet found in this browser. Paste an API key instead.");
      const wallet = (await provider.connect()).publicKey.toString();
      const n = await fetch("/v1/auth/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }).then((r) => r.json());
      const { signature } = await provider.signMessage(new TextEncoder().encode(n.message), "utf8");
      const res = await fetch("/v1/auth/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, nonce: n.nonce, signature: btoa(String.fromCharCode(...signature)), label: "laptop lane" }),
      }).then((r) => r.json());
      if (!res.api_key) throw new Error(res?.error?.message ?? "Sign-in failed.");
      save(res.api_key);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function start() {
    setError(null);
    stop.current = false;
    setRunning(true);
    try {
      if (!extractor.current) {
        setStatus("Downloading the model (34 MB, once)…");
        const t = await import("@huggingface/transformers");
        t.env.allowLocalModels = false;
        extractor.current = (await t.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8", device: "wasm" })) as unknown as Extractor;
      }
      const me = laneKeypair();
      const { session_id } = await call("/v1/lane/checkin", { pubkey: me.publicKey });
      setStatus("Online. Waiting for work…");
      while (!stop.current) {
        let task: Task | null = null;
        try {
          task = (await call("/v1/lane/next", { session_id })).task;
        } catch (e) {
          if ((e as { code?: string }).code === "unknown_session") throw e;
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        if (!task || stop.current) continue;
        setStatus("Working on a task…");
        const k = sharedKey(me.secretKey, task.server_pubkey);
        const { inputs } = open<{ inputs: string[] }>(k, task.ciphertext);
        const vectors = (await extractor.current!(inputs, { pooling: "cls", normalize: true })).tolist();
        await call("/v1/lane/result", { session_id, task_id: task.id, result: seal(k, { vectors }) }).catch(() => {});
        setDone((d) => d + 1);
        setStatus("Online. Waiting for work…");
        setTimeout(refreshStats, 3000);
      }
      setStatus("Stopped");
    } catch (e) {
      setError((e as Error).message);
      setStatus("Stopped");
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 sm:space-y-8 px-4 py-10">
      <section className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">Earn Fuel balance</p>
        <h1 className="text-3xl font-bold tracking-tight">Laptop lane</h1>
        <p className="text-muted">
          Run small AI jobs (text embeddings) in this tab and earn Fuel balance for every result another laptop agrees with. No install. Keep the tab open; close it
          to stop.
        </p>
      </section>

      {!key ? (
        <section className="space-y-3">
          <button onClick={connectWallet} className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong sm:py-3 sm:text-base">
            Connect wallet to start
          </button>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (paste.trim()) save(paste.trim());
            }}
          >
            <input
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="or paste a Fuel API key (fuel_sk_…)"
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-2 font-mono text-sm"
            />
            <button className="rounded-lg px-4 text-sm btn-2">Use key</button>
          </form>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-line p-4">
            <div>
              <p className="text-xs text-muted">Status</p>
              <p className="font-medium" data-testid="lane-status">
                {status}
              </p>
            </div>
            {running ? (
              <button onClick={() => (stop.current = true)} className="rounded-lg px-4 py-2 text-sm btn-2">
                Stop
              </button>
            ) : (
              <button onClick={() => void start()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-strong">
                Start
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Done this session" value={String(done)} />
            <Stat label="Verified (all time)" value={String(stats?.verified ?? 0)} />
            <Stat label="Earned (credit)" value={`$${(stats?.earned_usd ?? 0).toFixed(6)}`} />
            <Stat label="Rejected / timed out" value={`${stats?.rejected ?? 0} / ${stats?.timeouts ?? 0}`} />
          </div>
          {stats?.banned && <p className="text-sm text-bad">This wallet is banned from the lane after failing checks.</p>}
        </section>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}

      <section className="space-y-2 text-sm text-muted">
        <h2 className="font-medium text-ink">How it works</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Every task goes to two laptops. Pay only goes out when both results match; a third laptop breaks ties.</li>
          <li>Some tasks hide a test input with a known answer. Wrong answers count against you; three failed tests and the wallet is banned from the lane.</li>
          <li>Pay goes to your Fuel balance: spend it on compute or withdraw it in USDC (minimum $5). Your share is 70% of what the job costs, split between the laptops that agreed.</li>
          <li>Tasks are encrypted to this tab only. You will see the text you embed; agents are told this before they use the lane.</li>
        </ul>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
