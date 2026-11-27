// Laptop-lane encryption, shared by the server and the browser worker.
// X25519 key agreement → SHA-256 → XChaCha20-Poly1305. Each job has its own server key,
// each tab its own key, so a task can only be read by the one laptop it was sent to,
// and a result can only have come from that laptop.
import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

const DOMAIN = new TextEncoder().encode("fuel/lane/v1");

export const LANE_MODEL = "fuel-lane/bge-small-en-v1.5";
export const LANE_HF_MODEL = "Xenova/bge-small-en-v1.5";
export const LANE_DIMS = 384;

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function laneKeypair() {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: b64(x25519.getPublicKey(secretKey)) };
}

export function sharedKey(secretKey: Uint8Array, peerPublicKey: string): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, unb64(peerPublicKey));
  const buf = new Uint8Array(DOMAIN.length + shared.length);
  buf.set(DOMAIN);
  buf.set(shared, DOMAIN.length);
  return sha256(buf);
}

export function seal(key: Uint8Array, value: unknown): string {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(value)));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return b64(out);
}

/** Throws if the ciphertext was not sealed with this key (wrong laptop, or tampered). */
export function open<T>(key: Uint8Array, sealed: string): T {
  const raw = unb64(sealed);
  const pt = xchacha20poly1305(key, raw.slice(0, 24)).decrypt(raw.slice(24));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
