import { connection } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, readJson } from "@/lib/http";
import { contractsFor, forwardTerms, offerContract } from "@/lib/forwards";

/** Your capacity contracts, and the terms you can offer. */
export async function GET(req: Request) {
  await connection();
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return Response.json({ terms: await forwardTerms(), data: await contractsFor(caller.wallet) });
}

/**
 * Offer a capacity contract: for one of your chat models, serve up to volume_mtok million
 * tokens at no more than the ceiling price for term_days (30/60/90). The bond comes from your
 * balance; Fuel pays premium_pct of the contract's value at the end if you deliver.
 * Body: { model, ceiling_in, ceiling_out?, volume_mtok, term_days, premium_pct }.
 */
export async function POST(req: Request) {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const b = await readJson<Record<string, unknown>>(req);
  if (!b) return apiError(400, "invalid_request_error", "JSON body required.");
  const r = await offerContract(caller.wallet, b);
  if (!r.ok) return apiError(r.code === "server_error" ? 500 : r.code === "insufficient_balance" ? 402 : 400, "invalid_request_error", r.message, r.code);
  return Response.json(r, { status: 201 });
}
