import { QUALITY_TONE, type Quality, type Speed, type Tag } from "@/lib/labels";

/** Small badges: recommended (best quality in its category), cheapest, fastest, then quality and speed. */
export default function ModelBadges({ quality, speed, recommended, tags = [], trial }: { quality?: Quality | null; speed?: Speed | null; recommended?: boolean; tags?: Tag[]; trial?: boolean | null }) {
  if (!quality && !speed && !recommended && !tags.length && trial == null) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {recommended && (
        <span title="Fuel's pick: the best quality in this category" className="rounded-full border border-amber-500/60 bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
          ★ Recommended
        </span>
      )}
      {tags.includes("cheapest") && (
        <span title="Lowest price in this category" className="rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
          $ Cheapest
        </span>
      )}
      {tags.includes("fastest") && (
        <span title="Quickest in this category" className="rounded-full border border-sky-600/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
          ⚡ Fastest
        </span>
      )}
      {trial === true && <span title="Included in the free trial" className="rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">Free trial</span>}
      {trial === false && <span title="Not covered by the free trial: sign in with a wallet to use it" className="rounded-full border border-line-strong bg-black/5 px-2 py-0.5 text-[10px] font-semibold text-muted">🔒 Not in free trial</span>}
      {quality && <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${QUALITY_TONE[quality]}`}>{quality} quality</span>}
      {speed && <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-muted">{speed}</span>}
    </span>
  );
}
