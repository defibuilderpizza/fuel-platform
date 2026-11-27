"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { connectEvmWallet, connectWallet, fuelCall, saveKey } from "@/components/fuel-key";

// The free trial in the studio: anyone can start it without a wallet. Credits are shown as
// tokens (or pictures) for the chosen model, never as money. When they run out, the studio
// asks the visitor to sign in or create a wallet and top up.

type Acct = { wallet: string; available_usd: number };
const BALANCE_EVENT = "fuel:balance";
export const refreshBalance = () => window.dispatchEvent(new Event(BALANCE_EVENT));

export function useAccount(key: string | null) {
  const [acct, setAcct] = useState<Acct | null>(null);
  const load = useCallback(() => {
    if (!key) return;
    fuelCall<Acct>(key, "/v1/account")
      .then(setAcct)
      .catch(() => setAcct(null));
  }, [key]);
  useEffect(() => {
    load();
    window.addEventListener(BALANCE_EVENT, load);
    return () => window.removeEventListener(BALANCE_EVENT, load);
  }, [load]);
  return key ? acct : null;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.max(0, Math.floor(n))));

/** "≈ 1.2M tokens" for a chat model (3:1 in:out), or "≈ 280 pictures" for a per-output price. */
export function allowance(usd: number, price: { inPerM: number; outPerM: number } | { perOutput: number; unit: string }) {
  if ("perOutput" in price) {
    const n = price.perOutput > 0 ? Math.floor(usd / price.perOutput) : 0;
    return `≈ ${fmt(n)} ${price.unit}${n === 1 ? "" : "s"}`;
  }
  const perToken = (price.inPerM * 3 + price.outPerM) / 4 / 1e6;
  return `≈ ${fmt(perToken > 0 ? usd / perToken : 0)} tokens`;
}

/** Signed out: start the free trial (no wallet) or connect a wallet. */
export function StartTrial({ onError }: { onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 rounded-xl border border-line p-4 text-sm">
      <p className="font-medium">Try it free, no wallet needed</p>
      <p className="text-muted">Start with free credits for text, pictures, video, 3D and voice. When they run out, sign in or create a wallet to keep going.</p>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await fuelCall<{ api_key: string }>(null, "/v1/trial/start", {});
              saveKey(r.api_key);
            } catch (e) {
              onError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50 sm:px-4 sm:py-2 sm:text-base"
        >
          {busy ? "Starting…" : "Try free"}
        </button>
        <button onClick={() => connectWallet("studio").catch((e) => onError((e as Error).message))} className="rounded-lg px-3.5 py-1.5 text-sm font-medium btn-2 sm:px-4 sm:py-2 sm:text-base">
          Solana wallet
        </button>
        <button onClick={() => connectEvmWallet("studio").catch((e) => onError((e as Error).message))} className="rounded-lg px-3.5 py-1.5 text-sm font-medium btn-2 sm:px-4 sm:py-2 sm:text-base">
          EVM wallet (USDG)
        </button>
      </div>
    </div>
  );
}

type Faucet = { enabled: boolean; trial: { claimed: boolean; tokens_estimate: number | null; tokens_model: string } };

/** Out of free credits (or any balance): claim the wallet's free credits, top up, or (guests) sign in. */
export function OutOfCredits({ guest, apiKey, onError, onClaimed }: { guest: boolean; apiKey: string; onError: (m: string) => void; onClaimed: () => void }) {
  const [faucet, setFaucet] = useState<Faucet | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (guest) return;
    fuelCall<Faucet>(apiKey, "/v1/faucet")
      .then(setFaucet)
      .catch(() => setFaucet(null));
  }, [guest, apiKey]);
  const canClaim = !guest && !!faucet?.enabled && !faucet.trial.claimed;
  const tokens = faucet?.trial.tokens_estimate ? ` (≈ ${fmt(faucet.trial.tokens_estimate)} tokens on ${faucet.trial.tokens_model.split("/").pop()})` : "";
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4 text-sm">
      <p className="font-medium">{guest ? "Your free credits are used up" : canClaim ? "Your wallet has no balance yet" : "You're out of balance"}</p>
      <p className="text-muted">
        {guest
          ? "Sign in or create a wallet to keep going: top up with USDC, SOL or USDG and pay only for what you use."
          : canClaim
            ? `Claim this wallet's free credits${tokens} and try it now, or top up with USDC, SOL or USDG.`
            : "Top up with USDC, SOL or USDG from the dashboard to keep going."}
      </p>
      <div className="flex flex-wrap gap-2">
        {canClaim && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await fuelCall(apiKey, "/v1/faucet/claim", {});
                refreshBalance();
                onClaimed();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50 sm:px-4 sm:py-2 sm:text-base"
          >
            {busy ? "Claiming…" : "Claim free credits"}
          </button>
        )}
        {guest && (
          <button
            onClick={() => {
              saveKey(null);
              connectWallet("studio").catch((e) => onError((e as Error).message));
            }}
            className="rounded-lg bg-accent px-4 py-2 font-medium text-white hover:bg-accent-strong"
          >
            Sign in with a wallet
          </button>
        )}
        {guest && (
          <a href="https://phantom.com/download" target="_blank" rel="noreferrer" className="rounded-lg px-3.5 py-1.5 text-sm font-medium btn-2 sm:px-4 sm:py-2 sm:text-base">
            Create a wallet
          </a>
        )}
        <Link href={guest ? "/trial" : "/dashboard"} className="rounded-lg px-3.5 py-1.5 text-sm font-medium btn-2 sm:px-4 sm:py-2 sm:text-base">
          {guest ? "How it works" : "Top up"}
        </Link>
      </div>
    </div>
  );
}

/** What's left (free trial or wallet balance), in tokens or outputs for the chosen model. */
export function TrialLeft({ acct, label }: { acct: Acct | null; label: string | null }) {
  if (!acct || !label || acct.available_usd <= 0) return null;
  return (
    <p className="rounded-lg border border-line bg-white/50 px-3 py-2 text-xs text-muted">
      {acct.wallet.startsWith("guest:") ? "Free trial" : "Your balance"}: <strong className="text-ink">{label}</strong> left on this model.
    </p>
  );
}
