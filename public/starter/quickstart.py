"""Fuel starter kit (Python 3.9+): give an agent its own wallet, sign in, check its balance and run a job.

    pip install pynacl base58 openai requests
    python quickstart.py

Env (all optional):
    FUEL_BASE_URL   default https://fuelai.cloud
    FUEL_KEYPAIR    path to a Solana keypair JSON (64-number array). Default: ./fuel-agent-keypair.json,
                    created on first run. Fund this wallet's Fuel balance by sending USDC or SOL from it.
    FUEL_MODEL      default openai/gpt-oss-120b

The API key is cached in ./.fuel-api-key. Signing in never sends a transaction or costs anything.
"""
import json
import os
import sys

import base58
import requests
from nacl.signing import SigningKey
from openai import OpenAI

BASE = os.environ.get("FUEL_BASE_URL", "https://fuelai.cloud").rstrip("/")
KEYPAIR = os.environ.get("FUEL_KEYPAIR", "./fuel-agent-keypair.json")
MODEL = os.environ.get("FUEL_MODEL", "openai/gpt-oss-120b")
KEY_FILE = "./.fuel-api-key"


def call(path, key=None, method="GET", body=None):
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    res = requests.request(method, BASE + path, headers=headers, data=None if body is None else json.dumps(body), timeout=60)
    try:
        data = res.json()
    except ValueError:
        data = {}
    return res.ok, data


def load_or_create_keypair():
    """The agent's wallet, as a Solana keypair file: 32-byte secret + 32-byte public key."""
    if os.path.exists(KEYPAIR):
        raw = bytes(json.load(open(KEYPAIR)))
        sk = SigningKey(raw[:32])
    else:
        sk = SigningKey.generate()
        fd = os.open(KEYPAIR, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(list(bytes(sk)) + list(bytes(sk.verify_key)), f)
        print(f"Created a new wallet for this agent: {KEYPAIR} (keep it safe; it holds the agent's identity)")
    return sk, base58.b58encode(bytes(sk.verify_key)).decode()


def sign_in(sk, wallet):
    """Sign a one-time message, get an API key."""
    if os.path.exists(KEY_FILE):
        key = open(KEY_FILE).read().strip()
        if call("/v1/account", key)[0]:
            return key
    ok, n = call("/v1/auth/nonce", method="POST", body={"wallet": wallet})
    if not ok:
        sys.exit(n.get("error", {}).get("message", "Could not start sign-in"))
    signature = base58.b58encode(sk.sign(n["message"].encode()).signature).decode()
    ok, k = call("/v1/auth/keys", method="POST", body={"wallet": wallet, "nonce": n["nonce"], "signature": signature, "label": "starter-kit"})
    if not ok:
        sys.exit(k.get("error", {}).get("message", "Sign-in failed"))
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(k["api_key"])
    return k["api_key"]


sk, wallet = load_or_create_keypair()
print(f"Agent wallet: {wallet}")
key = sign_in(sk, wallet)
print("Signed in to Fuel.")

# Balance: claim the free trial credits if empty (any wallet, once)
_, acct = call("/v1/account", key)
if not acct.get("available_usd", 0) > 0:
    ok, t = call("/v1/faucet/claim", key, method="POST")
    if ok:
        print("Claimed the free trial credits.")
        _, acct = call("/v1/account", key)
    else:
        print(f"\nNo balance yet ({t.get('error', {}).get('message', 'trial not available')}).")
        print(f"Top up: send USDC or SOL FROM {wallet} TO {acct['deposit']['address']}.")
        print("Fuel spots it within minutes (or POST /v1/topups with the signature). Then run this again.")
        sys.exit(0)
print(f"Balance: ${acct['available_usd']:.6f} available")

# Run a job with the standard OpenAI SDK, pointed at Fuel
client = OpenAI(base_url=f"{BASE}/v1", api_key=key)
r = client.chat.completions.create(
    model=MODEL,
    max_tokens=200,
    messages=[{"role": "user", "content": "In one sentence: what is a compute market for AI agents?"}],
)
print(f"\n{MODEL}: {r.choices[0].message.content}")
print("Receipt:", getattr(r, "model_extra", {}).get("fuel"))
