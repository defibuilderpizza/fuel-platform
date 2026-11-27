"use client";

import { useState } from "react";
import bs58 from "bs58";
import { getWallets } from "@wallet-standard/app";

// "Fuel this agent" for the agent page. Talks to any Wallet Standard wallet (Phantom, Solflare,
// Backpack…), asks Fuel's Solana Action for the transaction, has the wallet sign and send it,
// then calls the Action's confirm step so the agent is credited.

type Account = { address: string; chains: readonly string[] };
type StdWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly Account[];
  features: Record<string, unknown>;
};
type Connect = { connect: () => Promise<{ accounts: readonly Account[] }> };
type SignAndSend = {
  signAndSendTransaction: (input: { account: Account; transaction: Uint8Array; chain: string }) => Promise<readonly { signature: Uint8Array }[]>;
};

const CHAIN = "solana:mainnet";
const PRESETS = [1, 5, 20];

function solanaWallets(): StdWallet[] {
  return (getWallets().get() as unknown as StdWallet[]).filter(
    (w) => w.chains.some((c) => c.startsWith("solana:")) && "solana:signAndSendTransaction" in w.features && "standard:connect" in w.features,
  );
}

export default function FuelAgentButton({ agent, displayName }: { agent: string; displayName: string }) {
  const [amount, setAmount] = useState("5");
  const [asset, setAsset] = useState<"USDC" | "SOL">("USDC");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [wallets, setWallets] = useState<StdWallet[] | null>(null);

  async function fuel(wallet: StdWallet) {
    setBusy(true);
    setMsg({ text: `Connecting to ${wallet.name}…` });
    try {
      const { accounts } = await (wallet.features["standard:connect"] as Connect).connect();
      const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
      if (!account) throw new Error("No account selected in the wallet.");

      setMsg({ text: "Preparing the transaction…" });
      const res = await fetch(`/api/actions/fuel/${agent}?asset=${asset}&amount=${encodeURIComponent(amount)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.address }),
      });
      const action = await res.json();
      if (!res.ok || !action.transaction) throw new Error(action.message ?? "Could not prepare the transaction.");

      setMsg({ text: "Approve it in your wallet…" });
      const tx = Uint8Array.from(atob(action.transaction), (c) => c.charCodeAt(0));
      const [out] = await (wallet.features["solana:signAndSendTransaction"] as SignAndSend).signAndSendTransaction({ account, transaction: tx, chain: CHAIN });
      const signature = bs58.encode(out.signature);

      setMsg({ text: "Sent. Waiting for the network to finalize (~15s)…" });
      const done = await fetch(`/api/actions/fuel/${agent}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.address, signature }),
      }).then((r) => r.json());
      setMsg({ text: `${done.title ?? "Done"}. ${done.description ?? ""}`, ok: true });
      setTimeout(() => window.location.reload(), 2500);
    } catch (e) {
      setMsg({ text: (e as Error).message || "Something went wrong.", ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Fuel {displayName}</h2>
        <span className="text-xs text-muted">pays for its compute</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => {
              setAsset("USDC");
              setAmount(String(p));
            }}
            className={`rounded-lg border px-3 py-1.5 text-sm ${asset === "USDC" && amount === String(p) ? "border-accent bg-accent text-white" : "btn-2"}`}
          >
            ${p}
          </button>
        ))}
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-line-strong px-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label="Amount"
            className="w-16 min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
          />
          <select value={asset} onChange={(e) => setAsset(e.target.value as "USDC" | "SOL")} aria-label="Asset" className="bg-transparent text-sm">
            <option>USDC</option>
            <option>SOL</option>
          </select>
        </div>
      </div>
      {wallets === null ? (
        <button
          disabled={busy}
          onClick={() => {
            const found = solanaWallets();
            if (found.length === 1) void fuel(found[0]);
            else setWallets(found);
          }}
          className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent-strong disabled:opacity-50"
        >
          {busy ? "Working…" : `Fuel with ${amount || "…"} ${asset}`}
        </button>
      ) : wallets.length === 0 ? (
        <p className="text-sm text-muted">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, or use the Blink link below from your wallet.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted">Choose a wallet</p>
          {wallets.map((w) => (
            <button
              key={w.name}
              disabled={busy}
              onClick={() => void fuel(w)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm btn-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.icon} alt="" className="h-5 w-5" />
              {w.name}
            </button>
          ))}
        </div>
      )}
      {msg && <p className={`text-sm ${msg.ok === false ? "text-bad" : msg.ok ? "text-ok" : "text-muted"}`}>{msg.text}</p>}
      <p className="text-xs text-muted">Sent from your wallet straight to Fuel, tagged for this agent. Public on-chain, like any transfer.</p>
    </div>
  );
}
