import "server-only";
import { creditPayFor, reserveJob } from "@/lib/credit-tiers";
import { randomUUID } from "node:crypto";
import { apiError } from "@/lib/http";
import { microToUsd } from "@/lib/money";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Caller } from "@/lib/auth";
import { LANE_DIMS, LANE_MODEL, cosine, laneKeypair, open, seal, sharedKey } from "@/lib/lane-crypto";
import canaryFile from "@/lib/lane-canaries.json";

// The laptop lane (spec Phase 4). An embeddings job is sent, encrypted, to two laptops.
// If their vectors agree the agent gets the result and both laptops are paid in balance
// credit. If they disagree, a third laptop breaks the tie. Canaries catch made-up answers.

export const LANE = {
  pricePerMTokUsd: Number(process.env.FUEL_LANE_PRICE_PER_MTOK ?? 0.02), // agent price, USD per 1M tokens
  minChargeMicro: 20, // $0.00002 per request
  workerShare: 0.7, // of the charge, split between the agreeing laptops
  onlineWindowMs: 20_000,
  jobTimeoutMs: 45_000,
  agreeCosine: 0.999,
  canaryCosine: 0.98, // browser (WASM) vs Node (CPU) builds of the model differ slightly (~0.997); junk scores far lower
  canaryRate: 0.25,
  maxInputs: 32,
  maxChars: 4_000,
};

const canaries = (canaryFile as { canaries: { text: string; vector: number[] }[] }).canaries;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const tokensOf = (inputs: string[]) => inputs.reduce((s, t) => s + Math.ceil(t.length / 4) + 2, 0);

type Worker = { session_id: string; wallet: string; pubkey: string };

export async function onlineWorkers(excludeWallet?: string): Promise<Worker[]> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - LANE.onlineWindowMs).toISOString();
  const [{ data: workers }, { data: banned }] = await Promise.all([
    db.from("lane_workers").select("session_id, wallet, pubkey").gte("last_seen", since),
    db.from("lane_worker_stats").select("wallet").eq("banned", true),
  ]);
  const bannedSet = new Set((banned ?? []).map((b) => b.wallet));
  // One session per wallet, random order: two tabs of the same person never check each other.
  const byWallet = new Map<string, Worker>();
  for (const w of (workers ?? []).sort(() => Math.random() - 0.5)) {
    if (w.wallet === excludeWallet || bannedSet.has(w.wallet) || byWallet.has(w.wallet)) continue;
    byWallet.set(w.wallet, w);
  }
  return [...byWallet.values()];
}

type Good = { session: string; wallet: string; vectors: number[][] };
type Answer = Good | { session: string; wallet: string; invalid: true; reason: string };

function validVectors(v: unknown, n: number): v is number[][] {
  return Array.isArray(v) && v.length === n && v.every((x) => Array.isArray(x) && x.length === LANE_DIMS && x.every((y) => typeof y === "number" && Number.isFinite(y)));
}

function agree(a: number[][], b: number[][], skip: number) {
  return a.every((v, i) => i === skip || cosine(v, b[i]) >= LANE.agreeCosine);
}

/** Embeddings on the laptop lane, OpenAI-shaped. */
export async function runLaneJob(caller: Caller, body: Record<string, unknown>): Promise<Response> {
  const raw = body.input;
  const inputs = typeof raw === "string" ? [raw] : Array.isArray(raw) && raw.every((x) => typeof x === "string") ? (raw as string[]) : null;
  if (!inputs || inputs.length === 0) return apiError(400, "invalid_request_error", "'input' must be a string or an array of strings for the laptop lane.");
  const r = await laneVectors(caller, inputs);
  if (r instanceof Response) return r;
  return Response.json(
    {
      object: "list",
      model: LANE_MODEL,
      data: r.vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: { prompt_tokens: r.receipt.input_tokens, total_tokens: r.receipt.input_tokens },
      fuel: r.receipt,
    },
    { headers: { "x-fuel-job-id": r.receipt.job_id } },
  );
}

export type LaneReceipt = {
  job_id: string;
  provider: "laptop-lane";
  price_usd: number;
  input_tokens: number;
  output_tokens: 0;
  latency_ms: number;
  attempts: number;
  verified_by: number;
};

/**
 * Cross-checked vectors for `inputs` from the laptop lane: charges the caller, pays the agreeing
 * laptops, and returns the vectors with a receipt (or an error Response; failures cost nothing).
 */
export async function laneVectors(caller: Caller, inputs: string[]): Promise<{ vectors: number[][]; receipt: LaneReceipt } | Response> {
  if (inputs.length > LANE.maxInputs) return apiError(400, "invalid_request_error", `The laptop lane takes up to ${LANE.maxInputs} inputs per request.`);
  if (inputs.some((t) => t.length > LANE.maxChars)) return apiError(400, "invalid_request_error", `Each input can be up to ${LANE.maxChars} characters on the laptop lane.`);

  const db = supabaseAdmin();
  const workers = await onlineWorkers(caller.wallet);
  if (workers.length < 2) {
    return apiError(503, "provider_error", "Not enough laptops online for the laptop lane right now (it needs two to cross-check). You were not charged.", "lane_unavailable");
  }

  const tokens = tokensOf(inputs);
  const charge = Math.max(LANE.minChargeMicro, Math.ceil(tokens * LANE.pricePerMTokUsd));
  const jobId = randomUUID();
  // Lane credits pay for it when the caller holds enough of them.
  const pay = await creditPayFor(null, caller.wallet, LANE_MODEL, "embedding");
  const { result: reserved } = await reserveJob({ jobId, wallet: caller.wallet, model: LANE_MODEL, kind: "embedding", hold: charge, streamed: false, pay });
  if (reserved !== "ok") {
    if (reserved === "insufficient_balance") return apiError(402, "insufficient_balance", `This job costs $${microToUsd(charge).toFixed(6)}. Top up your balance.`);
    if (reserved === "credit_overdue") return apiError(402, "insufficient_balance", "Your credit is overdue. Top up to repay it, then jobs run again.", "credit_overdue");
    return apiError(402, "spending_limit", "This job would exceed your spending limit.", String(reserved));
  }

  // Sometimes hide a canary among the inputs. Laptops can't tell which one it is.
  const canary = Math.random() < LANE.canaryRate ? canaries[Math.floor(Math.random() * canaries.length)] : null;
  const canaryAt = canary ? Math.floor(Math.random() * (inputs.length + 1)) : -1;
  const taskInputs = canary ? [...inputs.slice(0, canaryAt), canary.text, ...inputs.slice(canaryAt)] : inputs;

  const server = laneKeypair();
  const assigned = new Map<string, Worker>();
  const assign = async (w: Worker) => {
    assigned.set(w.session_id, w);
    await db.from("lane_tasks").insert({
      job_id: jobId,
      session_id: w.session_id,
      server_pubkey: server.publicKey,
      ciphertext: seal(sharedKey(server.secretKey, w.pubkey), { inputs: taskInputs }),
    });
  };
  const startedAt = Date.now();
  const attempts: { provider: string; ok: boolean; status: number | null; ms: number }[] = [];
  const answers = new Map<string, Answer>();
  let spare = workers.slice(2);

  try {
    await Promise.all(workers.slice(0, 2).map(assign));
    let winners: Good[] | null = null;
    while (Date.now() - startedAt < LANE.jobTimeoutMs) {
      await sleep(400);
      const { data: rows } = await db.from("lane_tasks").select("session_id, result").eq("job_id", jobId).not("result", "is", null);
      for (const r of rows ?? []) {
        if (answers.has(r.session_id)) continue;
        const w = assigned.get(r.session_id)!;
        let ans: Answer;
        try {
          const got = open<{ vectors: unknown }>(sharedKey(server.secretKey, w.pubkey), r.result as string);
          if (!validVectors(got.vectors, taskInputs.length)) ans = { session: w.session_id, wallet: w.wallet, invalid: true, reason: "shape" };
          else if (canary && cosine(got.vectors[canaryAt], canary.vector) < LANE.canaryCosine) ans = { session: w.session_id, wallet: w.wallet, invalid: true, reason: "canary" };
          else ans = { session: w.session_id, wallet: w.wallet, vectors: got.vectors };
        } catch {
          ans = { session: w.session_id, wallet: w.wallet, invalid: true, reason: "decrypt" };
        }
        answers.set(r.session_id, ans);
        attempts.push({ provider: "laptop", ok: !("invalid" in ans), status: null, ms: Date.now() - startedAt });
        if ("invalid" in ans) await db.rpc("fuel_lane_strike", { p_wallet: ans.wallet, p_kind: ans.reason === "canary" ? "canary" : "rejected" });
      }

      const good = [...answers.values()].filter((a): a is Good => !("invalid" in a));
      for (let i = 0; i < good.length && !winners; i++)
        for (let j = i + 1; j < good.length && !winners; j++) if (agree(good[i].vectors, good[j].vectors, canaryAt)) winners = [good[i], good[j]];
      if (winners) break;

      // Every assigned laptop answered but no two agree (or some answered badly): bring in another.
      if (answers.size === assigned.size) {
        const next = spare.shift();
        if (!next) break;
        await assign(next);
      }
      // Laptops that went quiet: after 20s, bring in a spare if there is one.
      if (Date.now() - startedAt > 20_000 && assigned.size - answers.size > 0 && spare.length && assigned.size < 4) {
        await assign(spare.shift()!);
        spare = spare.filter((s) => !assigned.has(s.session_id));
      }
    }

    // Laptops that never answered get a timeout mark.
    for (const w of assigned.values()) if (!answers.has(w.session_id)) await db.rpc("fuel_lane_strike", { p_wallet: w.wallet, p_kind: "timeout" });

    if (!winners) {
      await db.rpc("fuel_settle", { p_job: jobId, p_status: "failed", p_provider: "laptop-lane", p_attempts: attempts, p_input_tokens: tokens, p_output_tokens: 0, p_provider_cost: 0, p_price: 0, p_latency_ms: Date.now() - startedAt });
      return apiError(503, "provider_error", "The laptop lane couldn't produce a cross-checked result in time. You were not charged.", "lane_unverified");
    }

    // Laptops that disagreed with the agreeing pair get a strike.
    const winnerVecs = winners[0].vectors;
    for (const a of answers.values()) {
      if ("invalid" in a || winners.some((w) => w.session === a.session)) continue;
      if (!agree(a.vectors, winnerVecs, canaryAt)) await db.rpc("fuel_lane_strike", { p_wallet: a.wallet, p_kind: "rejected" });
    }

    const pool = Math.floor(charge * LANE.workerShare);
    const each = Math.floor(pool / winners.length);
    const { data: charged } = await db.rpc("fuel_settle", {
      p_job: jobId,
      p_status: "succeeded",
      p_provider: "laptop-lane",
      p_attempts: attempts,
      p_input_tokens: tokens,
      p_output_tokens: 0,
      p_provider_cost: each * winners.length,
      p_price: charge,
      p_latency_ms: Date.now() - startedAt,
    });
    for (const w of winners) await db.rpc("fuel_lane_pay", { p_wallet: w.wallet, p_micro: each, p_ref: `${jobId}:${w.wallet}` });

    const vectors = canary ? winnerVecs.filter((_, i) => i !== canaryAt) : winnerVecs;
    return {
      vectors,
      receipt: {
        job_id: jobId,
        provider: "laptop-lane",
        price_usd: microToUsd(Number(charged ?? charge)),
        input_tokens: tokens,
        output_tokens: 0,
        latency_ms: Date.now() - startedAt,
        attempts: answers.size,
        verified_by: winners.length,
      },
    };
  } finally {
    await db.from("lane_tasks").delete().eq("job_id", jobId);
  }
}

/** A tab comes online with a fresh X25519 key. */
export async function checkin(wallet: string, pubkey: string) {
  const db = supabaseAdmin();
  const { data: stats } = await db.from("lane_worker_stats").select("banned").eq("wallet", wallet).maybeSingle();
  if (stats?.banned) return null;
  const session = randomUUID();
  await db.from("lane_workers").insert({ session_id: session, wallet, pubkey });
  // Housekeeping: sessions gone for a day.
  void db.from("lane_workers").delete().lt("last_seen", new Date(Date.now() - 86_400_000).toISOString()).then(() => {});
  return session;
}

/** Long-poll: waits up to ~20s for a task for this tab. */
export async function nextTask(session: string) {
  const db = supabaseAdmin();
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const { data } = await db.rpc("fuel_lane_claim", { p_session: session });
    const task = (data as { id: string; job_id: string; server_pubkey: string; ciphertext: string }[] | null)?.[0];
    if (task) return task;
    await sleep(1000);
  }
  return null;
}
