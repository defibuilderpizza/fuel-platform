import { connection } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET() {
  await connection(); // always check live, never prerender at build
  let db: "ok" | "error" = "ok";
  try {
    // Cheap round-trip that needs no tables: list at most one auth user.
    const { error } = await supabaseAdmin().auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) db = "error";
  } catch {
    db = "error";
  }
  return Response.json({ ok: db === "ok", service: "fuel", db }, { status: db === "ok" ? 200 : 503 });
}
