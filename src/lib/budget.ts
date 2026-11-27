// Spending limits in plain words: "spend at most $5 a day, no job over 10 cents",
// "remove the daily limit", "pause spending". Deterministic (no model call), so the same
// words always set the same limits. Fuel's limits are per UTC day and per job.

export type BudgetChange = { daily_usd?: number | null; per_job_usd?: number | null };
export type BudgetParse = { ok: true; change: BudgetChange; summary: string } | { ok: false; error: string };

const DAILY = /\b(today|a day|per day|each day|every day|daily|\/ ?day|24 ?h(ours)?)\b/;
const PER_JOB = /\b(per|each|a|any|every|single|one) (job|call|request|task|run|completion)s?\b|\bno (job|call|request|task)s? (over|above|more than|costs? more than)\b|\bper-job\b|\bjob limit\b/;
const LONGER = /\b(a|per|each|every) (week|month|year)\b|\bweekly\b|\bmonthly\b|\bthis (week|month)\b/;
const REMOVE = /\b(no|remove|clear|drop|delete|lift|without( a)?|unlimited|turn off)\b.*\b(limit|cap|budget)s?\b|\bunlimited\b|\bno (daily |per-job )?(limit|cap)s?\b/;
const PAUSE = /\b(pause|stop|freeze|halt|block)\b.*\b(spend|spending|jobs?|everything)\b|\bspend nothing\b|\bdon'?t spend\b/;

/** Dollar amount in a clause: $5, 5 dollars, 5 usd, 0.10, 50 cents, 50c. */
function amount(s: string): number | null {
  const cents = s.match(/(\d+(?:\.\d+)?)\s*(cents?|c)\b/);
  if (cents) return Number(cents[1]) / 100;
  const m = s.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usd|usdc|usdg|dollars?|bucks)\b|\b(\d+(?:\.\d+)?)\b/);
  if (!m) return null;
  return Number(m[1] ?? m[2] ?? m[3]);
}

const usd = (n: number) => (n < 1 ? `$${n.toFixed(n < 0.01 ? 4 : 2)}` : `$${+n.toFixed(2)}`);

export function parseBudget(text: string): BudgetParse {
  const t = text.toLowerCase().replace(/[’']/g, "'").trim();
  if (!t) return { ok: false, error: "Say what you want, e.g. \"at most $5 a day, no job over 10 cents\"." };
  if (t.length > 300) return { ok: false, error: "Keep it under 300 characters." };

  const change: BudgetChange = {};
  // "remove all limits" / "no limits" with no scope clears both.
  if (REMOVE.test(t) && !DAILY.test(t) && !PER_JOB.test(t) && amount(t) === null) {
    change.daily_usd = null;
    change.per_job_usd = null;
  } else if (PAUSE.test(t) && amount(t) === null) {
    change.daily_usd = 0;
  } else {
    // One instruction per clause: "…a day, and no job over 10 cents".
    for (const clause of t.split(/[,;]|\band\b|\bbut\b|\bplus\b|\.\s/).map((c) => c.trim()).filter(Boolean)) {
      if (LONGER.test(clause) && !DAILY.test(clause)) {
        return { ok: false, error: "Fuel's limits are per day and per job. Try \"at most $5 a day\" instead of a weekly or monthly amount." };
      }
      const perJob = PER_JOB.test(clause);
      const daily = DAILY.test(clause);
      const value = amount(clause);
      const removing = REMOVE.test(clause) && value === null;
      if (!perJob && !daily) {
        if (value !== null) return { ok: false, error: `Is ${usd(value)} a daily limit or a per-job limit? Say "a day" or "per job".` };
        continue;
      }
      const v = removing ? null : value;
      if (v === undefined || (v === null && !removing)) return { ok: false, error: "Couldn't find an amount. Try \"$5 a day\" or \"no job over $0.10\"." };
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1_000_000)) return { ok: false, error: "Amounts must be between $0 and $1,000,000." };
      if (perJob) change.per_job_usd = v;
      else change.daily_usd = v;
    }
  }

  const parts: string[] = [];
  if ("daily_usd" in change) parts.push(change.daily_usd === null ? "no daily limit" : change.daily_usd === 0 ? "spending paused (daily limit $0)" : `at most ${usd(change.daily_usd!)} a day`);
  if ("per_job_usd" in change) parts.push(change.per_job_usd === null ? "no per-job limit" : `no job over ${usd(change.per_job_usd!)}`);
  if (!parts.length) return { ok: false, error: "Couldn't find a limit. Try \"at most $5 a day\", \"no job over 10 cents\" or \"remove all limits\"." };
  return { ok: true, change, summary: parts.join(", ") };
}
