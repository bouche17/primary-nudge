// Loads the post-town list (postcode district → post town, from _shared/postcodeTowns.json) and fills schools.town.
// Admin only (or the backend service key). Safe to re-run; new schools get their town from a database trigger.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import towns from "../_shared/postcodeTowns.json" with { type: "json" };

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function allowed(req: Request): Promise<boolean> {
  // Backend-issued single-use token (same table as the test runner's).
  const runner = req.headers.get("x-runner-token");
  if (runner && runner.length >= 32) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runner)));
    const hash = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data } = await admin.from("test_runner_tokens").delete().eq("token_hash", hash).gt("expires_at", new Date().toISOString()).select("token_hash");
    return (data ?? []).length === 1;
  }
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === SERVICE_KEY) return true;
  const { data } = await admin.auth.getUser(token);
  if (!data.user) return false;
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
  return !!role;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await allowed(req))) return json({ error: "Admin only" }, 403);
  const rows = Object.entries(towns as Record<string, string>).map(([district, town]) => ({ district, town }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await admin.from("postcode_district_towns").upsert(rows.slice(i, i + 1000), { onConflict: "district" });
    if (error) return json({ error: error.message }, 500);
  }
  const { data: updated, error } = await admin.rpc("backfill_school_towns");
  if (error) return json({ error: error.message }, 500);
  const { count: missing } = await admin.from("schools").select("id", { count: "exact", head: true }).is("town", null);
  return json({ districts: rows.length, schools_updated: updated, schools_without_town: missing });
});
