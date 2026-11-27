import { ACTION_HEADERS } from "@/lib/actions";

/** Tells Blink clients that /agent/<name> pages map to Fuel's Solana Action. */
export function GET() {
  return Response.json(
    {
      rules: [
        { pathPattern: "/agent/*", apiPath: "/api/actions/fuel/*" },
        { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
      ],
    },
    { headers: ACTION_HEADERS },
  );
}

export function OPTIONS() {
  return new Response(null, { headers: ACTION_HEADERS });
}
