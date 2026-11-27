import { apiError } from "@/lib/http";

/** Gone: credits are spent by jobs on their tier's models now (see GET /v1/credits/tiers). */
export async function POST() {
  return apiError(
    410,
    "invalid_request_error",
    "Credits are no longer turned into balance by hand. Jobs on a model of a credit's tier use your credits automatically (send the header 'x-fuel-credits: off' to pay from your balance instead). To get cash, sell credits on the market (POST /v1/credits/orders).",
    "credits_used_by_jobs",
  );
}
