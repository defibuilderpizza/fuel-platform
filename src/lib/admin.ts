import "server-only";
import { timingSafeEqual } from "node:crypto";
import { apiError } from "@/lib/http";

/** Admin routes take the token in `x-admin-token`. Returns an error Response, or null when allowed. */
export function requireAdmin(req: Request): Response | null {
  const token = process.env.FUEL_ADMIN_TOKEN ?? "";
  const given = req.headers.get("x-admin-token") ?? "";
  if (!token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
    return apiError(401, "authentication_error", "Admin token required.");
  }
  return null;
}
