import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Don't forward browser console output into the dev log: writing that log on every page
  // load was setting off a reload loop in `next dev`.
  logging: { browserToTerminal: false },
  // The Privacy Rings SDK loads a WASM hasher at runtime; keep it out of the bundle.
  serverExternalPackages: ["@heliuslabs/spr", "@lightprotocol/hasher.rs"],
  partialPrefetching: true,
  // The playground became the Studio's Text tab (query strings like ?model= carry over).
  async redirects() {
    return [{ source: "/playground", destination: "/studio", permanent: true }];
  },
  turbopack: {
    // Pin the project root: there's a stray package-lock.json in the home folder above.
    root: path.resolve(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
