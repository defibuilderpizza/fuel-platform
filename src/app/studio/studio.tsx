"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import TextTab from "./text-tab";
import MediaTab, { type MediaModel } from "./media-tab";
import VoiceTab from "./voice-tab";

type Chat = { id: string; inPerM: number; outPerM: number };
const TABS = [
  ["text", "Text"],
  ["picture", "Picture"],
  ["video", "Video"],
  ["voice", "Voice"],
  ["3d", "3D"],
] as const;
type Tab = (typeof TABS)[number][0];
const SOON = new Set<Tab>([]);


export default function Studio({ chat, images, videos, meshes, speech, transcription }: { chat: Chat[]; images: MediaModel[]; videos: MediaModel[]; meshes: MediaModel[]; speech: MediaModel[]; transcription: MediaModel[] }) {
  const urlTab = useSearchParams().get("tab");
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (TABS.some(([t]) => t === urlTab) ? (urlTab as Tab) : "text");
  const pick = (t: Tab) => {
    setPicked(t);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    u.searchParams.delete("model");
    u.searchParams.delete("prompt");
    window.history.replaceState(null, "", u);
  };
  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Studio" className="flex flex-wrap gap-1 rounded-xl border border-line bg-card p-1">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => pick(t)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm ${tab === t ? "bg-accent text-white" : "text-muted hover:text-ink"}`}
          >
            {label}
            {SOON.has(t) && <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${tab === t ? "bg-white/20" : "bg-black/5"}`}>soon</span>}
          </button>
        ))}
      </div>
      {tab === "text" && <TextTab models={chat} />}
      {tab === "picture" && <MediaTab key="image" kind="image" models={images} />}
      {tab === "video" && <MediaTab key="video" kind="video" models={videos} />}
      {tab === "voice" && <VoiceTab speech={speech} transcription={transcription} />}
      {tab === "3d" && <MediaTab key="mesh" kind="mesh" models={meshes} />}
    </div>
  );
}
