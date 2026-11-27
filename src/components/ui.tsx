// Shared building blocks so every page uses the same card, stat and label styles.

export function Card({ title, aside, children, className = "" }: { title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-card p-5 ${className}`}>
      {(title || aside) && (
        <div className="mb-4 flex items-baseline justify-between gap-3">
          {title && <h2 className="font-semibold tracking-tight">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "accent" | "bad" | "ok" }) {
  const color = tone === "accent" ? "text-accent" : tone === "bad" ? "text-bad" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums tracking-tight ${color}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">{children}</p>;
}

export function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "ok" | "accent" | "private" | "bad" }) {
  const cls = {
    muted: "bg-card-2 text-muted",
    ok: "bg-ok/10 text-ok",
    accent: "bg-accent/10 text-accent",
    private: "bg-private/10 text-private",
    bad: "bg-bad/10 text-bad",
  }[tone];
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

/** A list with check marks instead of plain dots. */
export function Checks({ items, className = "" }: { items: React.ReactNode[]; className?: string }) {
  return (
    <ul className={`space-y-2 text-sm ${className}`}>
      {items.map((p, i) => (
        <li key={i} className="flex gap-2.5">
          <svg viewBox="0 0 16 16" className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden>
            <circle cx="8" cy="8" r="8" fill="#474747" />
            <path d="M4.6 8.2 7 10.5l4.4-4.8" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** Section heading: eyebrow, title, optional lead, optional link on the right. */
export function SectionHead({ eyebrow, title, lead, aside }: { eyebrow: string; title: React.ReactNode; lead?: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-[2.1rem]">{title}</h2>
        {lead && <p className="mt-2 text-sm text-muted sm:text-base">{lead}</p>}
      </div>
      {aside}
    </div>
  );
}
