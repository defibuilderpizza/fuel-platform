import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://fuelai.cloud";

// Public pages only (dashboard, admin and per-agent pages stay out).
const PAGES: [string, number][] = [
  ["", 1],
  ["/studio", 0.9],
  ["/models", 0.9],
  ["/docs", 0.9],
  ["/docs/integrations", 0.8],
  ["/trial", 0.8],
  ["/market", 0.7],
  ["/sell", 0.7],
  ["/teams", 0.7],
  ["/credits", 0.6],
  ["/lane", 0.6],
  ["/mission", 0.5],
  ["/status", 0.4],
  ["/terms", 0.2],
  ["/privacy", 0.2],
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(([path, priority]) => ({ url: `${SITE}${path}`, changeFrequency: "weekly", priority }));
}
