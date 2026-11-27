"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/studio", label: "Studio", also: ["/playground"] },
  { href: "/models", label: "Models" },
  { href: "/market", label: "Market" },
  { href: "/sell", label: "Sell compute", also: ["/lane"] },
  { href: "/teams", label: "Teams" },
  { href: "/docs", label: "Docs" },
  { href: "/trial", label: "Free trial" },
];

const isActive = (path: string | null, href: string, also: string[] = []) =>
  !!path && [href, ...also].some((h) => path === h || path.startsWith(h + "/"));

export function NavLinks({ path }: { path: string | null }) {
  const [open, setOpen] = useState(false);
  const dashActive = isActive(path, "/dashboard");
  return (
    <div className="flex items-center gap-1">
      <nav aria-label="Main" className="hidden items-center gap-0.5 text-sm md:flex">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(path, n.href, n.also) ? "page" : undefined}
            className={`rounded-lg px-3 py-1.5 ${isActive(path, n.href, n.also) ? "bg-white/70 text-ink" : "text-muted hover:text-ink"}`}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <Link
        href="/dashboard"
        aria-current={dashActive ? "page" : undefined}
        className={`ml-1 rounded-lg px-3 py-1.5 text-sm font-medium text-white ${dashActive ? "bg-accent-strong" : "bg-accent hover:bg-accent-strong"}`}
      >
        Dashboard
      </Link>
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="ml-1 rounded-lg p-2 text-muted hover:text-ink md:hidden"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open && (
        <nav aria-label="Mobile" className="absolute inset-x-0 top-14 border-b border-line bg-[#e9e9e9]/95 px-4 py-3 shadow-lg backdrop-blur md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              className={`block rounded-lg px-3 py-2.5 ${isActive(path, n.href, n.also) ? "bg-white/70 font-medium text-ink" : "text-muted"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Highlights the current page. Reads the URL, so it sits inside <Suspense> in the header. */
export function ActiveNavLinks() {
  return <NavLinks path={usePathname()} />;
}
