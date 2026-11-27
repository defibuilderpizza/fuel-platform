"use client";

import { useSyncExternalStore } from "react";

// The signed-in Fuel API key for this tab (sessionStorage), shared by every page that needs one.

const STORE = "fuel.dashboard.key";
const listeners = new Set<() => void>();
let memoryKey: string | null = null;

function load() {
  try {
    return sessionStorage.getItem(STORE) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}
export function saveKey(k: string | null) {
  memoryKey = k;
  try {
    if (k) sessionStorage.setItem(STORE, k);
    else sessionStorage.removeItem(STORE);
  } catch {}
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useFuelKey() {
  return useSyncExternalStore(subscribe, load, () => null);
}

type Injected = {
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signMessage: (m: Uint8Array, d?: string) => Promise<{ signature: Uint8Array }>;
};

/** Sign in with an injected Solana wallet (Phantom, Solflare, Backpack) and store the API key. */
export async function connectWallet(label: string) {
  const w = window as unknown as { phantom?: { solana?: Injected }; solana?: Injected };
  const provider = w.phantom?.solana ?? w.solana;
  if (!provider) throw new Error("No Solana wallet found in this browser. Paste an API key instead.");
  const wallet = (await provider.connect()).publicKey.toString();
  const n = await fetch("/v1/auth/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }).then((r) => r.json());
  if (!n.message) throw new Error(n?.error?.message ?? "Could not start sign-in.");
  const { signature } = await provider.signMessage(new TextEncoder().encode(n.message), "utf8");
  const res = await fetch("/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, nonce: n.nonce, signature: btoa(String.fromCharCode(...signature)), label }),
  }).then((r) => r.json());
  if (!res.api_key) throw new Error(res?.error?.message ?? "Sign-in failed.");
  saveKey(res.api_key);
}

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** Sign in with an EVM wallet (Robinhood Wallet, MetaMask, Rabby…) for USDG on Robinhood Chain. */
export async function connectEvmWallet(label: string) {
  const eth = (window as unknown as { ethereum?: Eth }).ethereum;
  if (!eth) throw new Error("No EVM wallet found in this browser. Install Robinhood Wallet or MetaMask, or paste an API key.");
  const [wallet] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!wallet) throw new Error("The wallet didn't share an address.");
  const n = await fetch("/v1/auth/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }).then((r) => r.json());
  if (!n.message) throw new Error(n?.error?.message ?? "Could not start sign-in.");
  const hex = "0x" + Array.from(new TextEncoder().encode(n.message), (b) => b.toString(16).padStart(2, "0")).join("");
  const signature = (await eth.request({ method: "personal_sign", params: [hex, wallet] })) as string;
  const res = await fetch("/v1/auth/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, nonce: n.nonce, signature, label }) }).then((r) => r.json());
  if (!res.api_key) throw new Error(res?.error?.message ?? "Sign-in failed.");
  saveKey(res.api_key);
  return res.api_key as string;
}

export async function fuelCall<T = unknown>(key: string | null, path: string, body?: unknown, method?: "GET" | "POST" | "PATCH" | "DELETE"): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? `Request failed (${res.status})`);
  return j as T;
}

type StdAccount = { address: string };
type StdWallet = {
  name: string;
  accounts: readonly StdAccount[];
  features: Record<string, unknown>;
};

/**
 * Signs and sends a ready-made transaction (base64, from Fuel) with a Wallet Standard wallet
 * (Phantom, Solflare, Backpack…). Returns the base58 signature. `owner` must be the wallet's account.
 */
export async function signAndSendWithWallet(base64Tx: string, owner: string, network: "mainnet" | "devnet") {
  const { getWallets } = await import("@wallet-standard/app");
  const bs58 = (await import("bs58")).default;
  const wallets = getWallets().get() as unknown as StdWallet[];
  const wallet = wallets.find((w) => "solana:signAndSendTransaction" in w.features);
  if (!wallet) throw new Error("No Solana wallet that can send transactions was found in this browser.");
  let account = wallet.accounts.find((a) => a.address === owner);
  if (!account) {
    const connect = wallet.features["standard:connect"] as { connect: () => Promise<{ accounts: readonly StdAccount[] }> } | undefined;
    const r = await connect?.connect();
    account = r?.accounts.find((a) => a.address === owner);
  }
  if (!account) throw new Error(`Switch your wallet to ${owner.slice(0, 4)}…${owner.slice(-4)} (the wallet you signed in with) and try again.`);
  const feature = wallet.features["solana:signAndSendTransaction"] as {
    signAndSendTransaction: (...i: { account: StdAccount; transaction: Uint8Array; chain: string }[]) => Promise<{ signature: Uint8Array }[]>;
  };
  const tx = Uint8Array.from(atob(base64Tx), (c) => c.charCodeAt(0));
  const [out] = await feature.signAndSendTransaction({ account, transaction: tx, chain: network === "mainnet" ? "solana:mainnet" : "solana:devnet" });
  return bs58.encode(out.signature);
}
