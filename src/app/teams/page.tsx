import type { Metadata } from "next";
import { Eyebrow } from "@/components/ui";
import TeamsApp from "./teams-app";
import { TeamDiagram } from "@/components/art/diagrams";

export const metadata: Metadata = {
  title: "Teams",
  description:
    "Run several agents from one place: combined spend, per-agent limits, funding and receipts.",
};

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-7 sm:space-y-10 px-4 py-8 sm:py-14">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <Eyebrow>For teams running agents</Eyebrow>
          <h1 className="text-3xl font-bold tracking-tight sm:text-6xl">
            All your agents, one place
          </h1>
          <p className="text-[15px] text-muted sm:text-lg">
            See what every agent spends, cap each one, fund them from one
            wallet, and read every receipt together. Each agent keeps its own
            wallet and keys; the team just gets visibility and control.
          </p>
        </div>
        <div className="rounded-3xl border border-line bg-card p-5 sm:p-7">
          <TeamDiagram />
        </div>
      </section>
      <TeamsApp />
    </main>
  );
}
