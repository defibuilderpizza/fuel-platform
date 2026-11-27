import type { Metadata } from "next";
import { Eyebrow } from "@/components/ui";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Fuel collects, what it never stores, who processes it, and your rights.",
};

const UPDATED = "26 November 2026";
const CONTACT = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();

const SECTIONS: { h: string; p: React.ReactNode[] }[] = [
  {
    h: "The short version",
    p: [
      "Fuel never stores your prompts or the model's responses. Your account is a wallet address, not a name or email. What Fuel keeps is what it needs to run your balance: receipts, deposits and settings.",
    ],
  },
  {
    h: "What Fuel keeps",
    p: [
      "Your wallet address, and hashes of your API keys (never the keys themselves).",
      "A receipt for each job: model, provider, price, token counts, time and latency. No content.",
      "Deposits and ledger entries for your balance, including the paying wallet and transaction signature. Private top-ups keep the amount credited and the sender.",
      "If you try Fuel without a wallet: a hash of your network address and a random device cookie, kept so each computer and network gets one free trial (the trial lasts 30 days). Never the IP address itself.",
      "Settings you choose: spending limits, team membership, agent name and profile (agent pages are public), and any provider keys you add for bring-your-own-key, encrypted at rest.",
      "If you sell compute: your endpoint URL, encrypted API key, model test results and earnings. If you run the laptop lane: your worker's results and reliability stats.",
    ],
  },
  {
    h: "What Fuel uses but doesn't keep",
    p: [
      "Prompts and responses pass through memory only, to reach the model and come back to you.",
      "Your request's country and region (from your IP address, via Vercel) are checked on each request to apply the region rules for Claude and GPT. They aren't stored.",
    ],
  },
  {
    h: "Who processes your data",
    p: [
      "Model providers process the content of your requests to run them: Anthropic for Claude, OpenAI for GPT (when offered), Together AI and independent GPU sellers for open models and some video, fal for pictures, video, voice and 3D (with a few models run by their makers, such as Ideogram, Recraft, Black Forest Labs, MiniMax and ElevenLabs, which the studio marks), and laptop-lane workers for lane jobs (encrypted to the two laptops that run each task). Each handles it under its own terms.",
      "Pictures and clips: Fuel passes the provider's temporary link straight to you and keeps no copy. Requests to fal go with request storage switched off and their files (pictures, clips, audio, 3D models and audio you upload to transcribe) set to be deleted an hour later, so save what you want to keep. Models run by their makers keep data under their own policies.",
      "Infrastructure: Vercel hosts the app, Supabase hosts the database, and Helius provides Solana RPC access.",
    ],
  },
  {
    h: "Blockchain data",
    p: [
      "Deposits are Solana or Robinhood Chain transactions. They are public and permanent, and Fuel can't change or delete them. Private top-ups hide the amount on-chain, but the transfer itself is still recorded.",
    ],
  },
  {
    h: "Screening",
    p: [
      "Wallets are checked against sanctions lists, and requests are checked against provider region rules. A match can block sign-in, deposits or certain models.",
    ],
  },
  {
    h: "How long it's kept",
    p: [
      "Sign-in messages are deleted after a day. Receipts, deposits and ledger entries are kept while your account exists and as long as accounting and legal duties require. Revoked keys and removed provider keys stop working immediately.",
    ],
  },
  {
    h: "Your rights",
    p: [
      <>
        Under UK data protection law you can ask for a copy of the data Fuel holds about your wallet, or ask for it to be corrected or deleted (except what must be kept by law, and on-chain data Fuel can&apos;t change)
        {CONTACT ? (
          <>
            {" "}by emailing <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>
          </>
        ) : null}
        . Your receipts are also available any time from the API (GET /v1/jobs) and the dashboard.
      </>,
    ],
  },
];

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-7 sm:space-y-10 px-4 py-8 sm:py-14">
      <section className="space-y-3">
        <Eyebrow>Privacy</Eyebrow>
        <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Privacy</h1>
        <p className="text-muted">Last updated {UPDATED}.</p>
      </section>
      {SECTIONS.map((s) => (
        <section key={s.h} className="space-y-3">
          <h2 className="text-lg font-semibold sm:text-xl">{s.h}</h2>
          {s.p.map((p, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-muted sm:text-base">
              {p}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
