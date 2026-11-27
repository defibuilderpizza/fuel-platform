"use client";

import { useSyncExternalStore } from "react";

// Studio jobs live here, not in the page that started them: moving around the site (client-side
// navigation) keeps them running, and the header banner shows their progress and when they're
// done. Jobs are kept in sessionStorage too: polled jobs (video, 3D) resume after a full reload;
// one-shot jobs (text, pictures, voice) can't, and say so.

export type JobKind = "text" | "picture" | "video" | "3d" | "speech" | "transcription";
export type Job = {
  id: string;
  kind: JobKind;
  model: string;
  /** What's happening, e.g. "Making your clip…". */
  stage: string;
  startedAt: number;
  typicalSeconds: number;
  status: "running" | "done" | "failed";
  /** Studio tab that shows the result. */
  tab: string;
  /** For polled jobs: the status URL to keep checking. */
  poll?: string;
  result?: Record<string, unknown>;
  fuel?: Record<string, unknown> | null;
  error?: string;
  finishedAt?: number;
  seen?: boolean;
};

const STORE = "fuel.studio.jobs";
const listeners = new Set<() => void>();
let jobs: Job[] = [];
let loaded = false;

function persist() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(jobs.slice(-10)));
  } catch {}
}
function emit() {
  jobs = [...jobs];
  persist();
  listeners.forEach((l) => l());
}
function update(id: string, patch: Partial<Job>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  emit();
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const NOUN: Record<JobKind, string> = { text: "answer", picture: "picture", video: "clip", "3d": "3D model", speech: "speech", transcription: "transcript" };
export const jobNoun = (k: JobKind) => NOUN[k];

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    jobs = JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as Job[];
  } catch {
    jobs = [];
  }
  // After a full reload: keep polling video/3D; one-shot jobs lost their answer.
  for (const j of jobs) {
    if (j.status !== "running") continue;
    if (j.poll) void pollUntilDone(j.id, j.poll);
    else Object.assign(j, { status: "failed", error: "The page reloaded before this finished. If it ran, it's in your receipts on the dashboard.", finishedAt: Date.now() });
  }
}

function subscribe(l: () => void) {
  load();
  listeners.add(l);
  return () => listeners.delete(l);
}
const EMPTY: Job[] = [];
export function useJobs(): Job[] {
  return useSyncExternalStore(subscribe, () => (load(), jobs), () => EMPTY);
}
/** The latest job for a studio tab. */
export function useTabJob(tab: string): Job | null {
  const all = useJobs();
  for (let i = all.length - 1; i >= 0; i--) if (all[i].tab === tab) return all[i];
  return null;
}

type Meta = { kind: JobKind; tab: string; model: string; stage: string; typicalSeconds: number };

/** Runs a one-shot request in the background and records its result. */
export function startJob(meta: Meta, run: () => Promise<{ result: Record<string, unknown>; fuel?: Record<string, unknown> | null }>) {
  load();
  const id = crypto.randomUUID();
  jobs.push({ id, ...meta, startedAt: Date.now(), status: "running" });
  emit();
  void run().then(
    (r) => update(id, { status: "done", result: r.result, fuel: r.fuel ?? null, finishedAt: Date.now() }),
    (e: unknown) => update(id, { status: "failed", error: (e as Error).message, finishedAt: Date.now() }),
  );
  return id;
}

type Polled = { status: string; stage?: string; queue_position?: number; url?: string; fuel?: Record<string, unknown>; error?: { message?: string } };

async function pollUntilDone(id: string, poll: string) {
  for (;;) {
    await sleep(4000);
    const j = jobs.find((x) => x.id === id);
    if (!j || j.status !== "running") return;
    let v: Polled;
    try {
      v = (await (await fetch(poll)).json()) as Polled;
    } catch {
      continue; // offline for a moment: keep trying
    }
    if (v.status === "completed") return update(id, { status: "done", result: { ...j.result, url: v.url }, fuel: v.fuel ?? null, finishedAt: Date.now() });
    if (v.status === "failed") return update(id, { status: "failed", error: v.error?.message ?? "It couldn't be made. You weren't charged.", finishedAt: Date.now() });
    const stage = v.stage === "queued" ? `Waiting in the provider's queue${typeof v.queue_position === "number" ? ` (position ${v.queue_position + 1})` : ""}…` : `Making your ${NOUN[j.kind]}…`;
    if (stage !== j.stage) update(id, { stage });
  }
}

/** Starts a job that the server runs asynchronously (video, 3D), then polls it until it's done. */
export function startPolledJob(meta: Meta, start: () => Promise<{ poll: string; result?: Record<string, unknown> }>) {
  load();
  const id = crypto.randomUUID();
  jobs.push({ id, ...meta, startedAt: Date.now(), status: "running" });
  emit();
  start().then(
    (s) => {
      update(id, { poll: s.poll, result: s.result });
      void pollUntilDone(id, s.poll);
    },
    (e: unknown) => update(id, { status: "failed", error: (e as Error).message, finishedAt: Date.now() }),
  );
  return id;
}

export function markSeen(id: string) {
  const j = jobs.find((x) => x.id === id);
  if (j && !j.seen) update(id, { seen: true });
}
export function dismissJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  emit();
}
