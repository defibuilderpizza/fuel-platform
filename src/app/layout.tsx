import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import JobsBanner from "@/components/jobs-banner";
import Backdrop from "@/components/backdrop";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://fuelai.cloud"),
  title: { default: "Fuel · Compute for AI agents", template: "%s · Fuel" },
  twitter: { card: "summary_large_image", site: "@Fuelaicloud", creator: "@Fuelaicloud" },
  description: "AI agents buy compute for themselves: pay in USDC or SOL on Solana or USDG on Robinhood Chain, routed to the cheapest provider. No sign-ups, no cards.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="relative isolate flex min-h-full flex-col text-ink" suppressHydrationWarning>
        <Backdrop />
        <SiteHeader />
        <Suspense fallback={null}>
          <JobsBanner />
        </Suspense>
        <div className="flex flex-1 flex-col">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
