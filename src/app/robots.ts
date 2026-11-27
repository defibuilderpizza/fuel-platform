import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://fuelai.cloud";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/dashboard", "/api/", "/v1/"] },
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
