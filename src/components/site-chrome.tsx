import { Suspense } from "react";
import Link from "next/link";
import { ActiveNavLinks, NavLinks } from "@/components/nav-links";

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex items-center justify-center rounded-lg bg-gradient-to-b from-[#6c6c6c] to-accent shadow-sm" style={{ width: size, height: size }}>
        <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} fill="white" aria-hidden>
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </span>
      <span className="text-lg font-bold tracking-tight">Fuel</span>
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-white/55 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" aria-label="Fuel home">
          <Logo />
        </Link>
        <Suspense fallback={<NavLinks path={null} />}>
          <ActiveNavLinks />
        </Suspense>
      </div>
    </header>
  );
}

const FOOTER: [string, [string, string][]][] = [
  ["Product", [["Studio", "/studio"], ["Models", "/models"], ["Market", "/market"], ["Free trial", "/trial"], ["Teams", "/teams"]]],
  ["Developers", [["Docs", "/docs"], ["Integrations", "/docs/integrations"], ["Source code", "https://github.com/defibuilderpizza/fuel-platform"], ["SDK & plugins", "https://github.com/defibuilderpizza/fuel-integrations"], ["Status", "/status"], ["llms.txt", "/llms.txt"]]],
  ["Earn", [["Sell compute", "/sell"], ["Laptop lane", "/lane"], ["Credits", "/credits"]]],
  ["Company", [["Mission", "/mission"], ["Terms", "/terms"], ["Privacy", "/privacy"]]],
];

export function SiteFooter() {
  return (
    <footer className="mt-auto bg-[#262626] text-white/75">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:py-12 md:grid-cols-[1.3fr_2fr]">
        <div className="space-y-3">
          <Link href="/" className="inline-flex text-white" aria-label="Fuel home">
            <Logo size={26} />
          </Link>
          <p className="max-w-xs text-sm text-white/65">The compute market for AI agents. Pay per job from your own wallet, or per request with x402.</p>
          <a href="https://x.com/Fuelaicloud" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-white/75 hover:text-white">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
              <path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 3.9H5.4L17.7 20Z" />
            </svg>
            @Fuelaicloud
          </a>
          <a href="https://github.com/defibuilderpizza/fuel-platform" target="_blank" rel="noreferrer" className="ml-5 inline-flex items-center gap-2 text-sm text-white/75 hover:text-white">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
              <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.42c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
            </svg>
            GitHub
          </a>
        </div>
        <nav className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4" aria-label="Footer">
          {FOOTER.map(([title, links]) => (
            <div key={title}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/50">{title}</p>
              <ul className="mt-3 space-y-2 text-sm">
                {links.map(([label, href]) => (
                  <li key={href}>
                    {href.startsWith("http") ? (
                      <a href={href} target="_blank" rel="noreferrer" className="hover:text-white">
                        {label} ↗
                      </a>
                    ) : (
                      <Link href={href} className="hover:text-white">
                        {label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-white/50">
          <span>© 2026 Fuel</span>
          <span>fuelai.cloud</span>
        </div>
      </div>
    </footer>
  );
}
