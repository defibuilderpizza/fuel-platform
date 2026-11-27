"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import Progress from "@/app/studio/progress";
import { dismissJob, jobNoun, markSeen, useJobs, type Job } from "@/components/jobs";

// Under the header on every page: studio jobs that are running, and ones that finished but
// haven't been looked at. While on the studio tab that shows a job, it's marked seen.

export default function JobsBanner() {
  const jobs = useJobs();
  const path = usePathname();
  const params = useSearchParams();
  const onTab = path === "/studio" ? (params.get("tab") ?? "text") : null;
  const visible = jobs.filter((j) => j.status === "running" || !j.seen);

  // Looking at the job's own studio tab counts as seeing it.
  useEffect(() => {
    for (const j of jobs) if (j.status !== "running" && !j.seen && j.tab === onTab) markSeen(j.id);
  }, [jobs, onTab]);

  // Tell the tab title too, so a finished job is noticed from another browser tab.
  const ready = visible.filter((j) => j.status === "done").length;
  const running = visible.filter((j) => j.status === "running").length;
  useEffect(() => {
    const base = document.title.replace(/^(✓|⏳) /, "");
    document.title = ready ? `✓ ${base}` : running ? `⏳ ${base}` : base;
  }, [ready, running, path]);

  if (!visible.length) return null;
  return (
    <div className="sticky top-14 z-10 border-b border-line bg-white/80 backdrop-blur-md">
      <div className="mx-auto w-full max-w-6xl space-y-2 px-4 py-2">
        {visible.slice(-3).map((j) => (
          <Row key={j.id} j={j} here={j.tab === onTab} />
        ))}
      </div>
    </div>
  );
}

function Row({ j, here }: { j: Job; here: boolean }) {
  const noun = jobNoun(j.kind);
  const view = `/studio?tab=${j.tab}`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="min-w-0 flex-1">
        {j.status === "running" ? (
          <Progress startedAt={j.startedAt} typicalSeconds={j.typicalSeconds} done={false} label={`${j.stage} · ${j.model.split("/").pop()}`} />
        ) : j.status === "done" ? (
          <span>
            <strong>Your {noun} is ready.</strong> <span className="text-muted">{j.model.split("/").pop()}</span>
          </span>
        ) : (
          <span className="text-bad">
            Your {noun} didn&apos;t finish: {j.error}
          </span>
        )}
      </span>
      {!here && (
        <Link href={view} className="rounded-lg px-3 py-1 text-xs font-medium btn-2">
          {j.status === "running" ? "Open" : "View"}
        </Link>
      )}
      {j.status !== "running" && (
        <button onClick={() => dismissJob(j.id)} aria-label="Dismiss" className="text-xs text-muted hover:text-ink">
          Dismiss
        </button>
      )}
    </div>
  );
}
