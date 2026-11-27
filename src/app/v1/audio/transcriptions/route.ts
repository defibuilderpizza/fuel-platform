import { callerOrPay } from "@/lib/x402";
import { runTranscriptionJob } from "@/lib/media";

/** Speech to text (OpenAI shape, multipart: file, model). Charged per minute of audio. */
export async function POST(req: Request) {
  const caller = await callerOrPay(req);
  if (caller instanceof Response) return caller;
  return runTranscriptionJob(req, caller);
}
