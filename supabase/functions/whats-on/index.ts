// Read-only "what's on" for the signed-in parent's own family (built for the dashboard; not wired in yet).
// The caller's JWT is validated and the family is always derived from that user, never from input.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getWhatsOn, ukDate } from "../_shared/whatsOn.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error } = token ? await admin.auth.getUser(token) : { data: { user: null }, error: true };
  if (error || !u.user) return json({ error: "Sign in required" }, 401);
  const body = await req.json().catch(() => ({}));
  const from = typeof body.from === "string" && DATE.test(body.from) ? body.from : ukDate(new Date());
  const to = typeof body.to === "string" && DATE.test(body.to) ? body.to : new Date(new Date(from + "T12:00:00Z").getTime() + 13 * 86_400_000).toISOString().slice(0, 10);
  const span = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
  if (span < 0 || span > 62) return json({ error: "Range must be 0-62 days" }, 400);
  const r = await getWhatsOn(admin as any, u.user.id, from, to);
  return json({ from, to, items: r.items });
});
