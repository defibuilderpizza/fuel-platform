import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Eyebrow } from "@/components/ui";
import { catalogue } from "@/lib/providers";
import { markupBps } from "@/lib/money";
import { mediaCatalogue } from "@/lib/media";
import Studio from "./studio";

export const metadata: Metadata = {
  title: "Studio",
  description: "Text, pictures, video, voice and 3D in one place: pick a model, run it, and see the result with exactly what it cost.",
};

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-8 sm:space-y-8 sm:py-14">
      <section className="max-w-2xl space-y-2 sm:space-y-3">
        <Eyebrow>Studio</Eyebrow>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Make something</h1>
        <p className="text-[15px] text-muted sm:text-lg">Text, pictures, video, voice and 3D from one wallet. Every result comes with its receipt: who ran it and exactly what it cost.</p>
      </section>
      <Suspense fallback={<div className="h-96 rounded-3xl border border-line bg-card" />}>
        <Loaded />
      </Suspense>
    </main>
  );
}

async function Loaded() {
  await connection();
  const m = 1 + markupBps() / 10_000;
  const chat = [...(await catalogue()).entries()]
    .filter(([, c]) => c.kind === "chat")
    .map(([id, c]) => ({ id, inPerM: c.inPerM * m, outPerM: c.outPerM * m }))
    .sort((a, b) => a.inPerM * 3 + a.outPerM - (b.inPerM * 3 + b.outPerM));
  const media = await mediaCatalogue();
  return <Studio chat={chat} images={media.filter((x) => x.kind === "image")} videos={media.filter((x) => x.kind === "video")} meshes={media.filter((x) => x.kind === "mesh")} speech={media.filter((x) => x.kind === "speech")} transcription={media.filter((x) => x.kind === "transcription")} />;
}
