// Read-only "what's on" for the signed-in parent's own family (partners included).
// The caller's JWT is validated and the family is always derived from that user, never from input.
// mode "dashboard": the dashboard's upcoming list when app_settings.dashboard_source = 'new' (else { source: 'legacy' }):
// today (UK) + 13 days, reminder wording, opt-in school events kept and flagged.
// Test entry (x-monty-test-secret, test users only, audited): may pin `now` and `source`.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { computeWhatsOn, getWhatsOn, loadFamilyData, ukDate } from "../_shared/whatsOn.ts";
import { whatsOnDays } from "../_shared/reminderFormat.ts";
import { auditTestEntry, isTestPhone, validTestSecret } from "../_shared/testGuard.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);

async function readSetting(key: string): Promise<"legacy" | "new"> {
  const { data, error } = await admin.from("app_settings").select("value").eq("key", key).maybeSingle();
  if (error) console.error(`${key} read failed — using legacy:`, error.message);
  return data?.value === "new" ? "new" : "legacy";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error } = token ? await admin.auth.getUser(token) : { data: { user: null }, error: true };
  if (error || !u.user) return json({ error: "Sign in required" }, 401);
  const body = await req.json().catch(() => ({}));

  // Test overrides: only with the test secret AND a test user (allowlisted phone + test email).
  let now = new Date(), forced: "legacy" | "new" | null = null;
  const secret = req.headers.get("x-monty-test-secret");
  if (secret !== null) {
    const { data: prof } = await admin.from("profiles").select("phone_number").eq("user_id", u.user.id).maybeSingle();
    const ok = (await validTestSecret(secret)) && !!u.user.email?.endsWith("@monty-test.invalid") && (await isTestPhone(prof?.phone_number));
    await auditTestEntry({ entry_point: "whats-on", phone_number: prof?.phone_number ?? null, scenario: body.scenario ?? null, allowed: ok, reason: ok ? undefined : "not a test user or bad secret" });
    if (!ok) return json({ error: "Forbidden" }, 403);
    if (typeof body.now === "string" && !isNaN(Date.parse(body.now))) now = new Date(body.now);
    if (body.source === "new" || body.source === "legacy") forced = body.source;
  }

  if (body.mode === "dashboard") {
    const source = forced ?? (await readSetting("dashboard_source"));
    if (source !== "new") return json({ source: "legacy" });
    const from = ukDate(now), to = addDays(from, 13);
    const data = await loadFamilyData(admin as any, u.user.id, from, to);
    const items = computeWhatsOn(data, from, to);
    return json({ source: "new", today: from, from, to, days: whatsOnDays(items, data.children.map((c) => c.first_name)) });
  }

  const from = typeof body.from === "string" && DATE.test(body.from) ? body.from : ukDate(now);
  const to = typeof body.to === "string" && DATE.test(body.to) ? body.to : addDays(from, 13);
  const span = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
  if (span < 0 || span > 62) return json({ error: "Range must be 0-62 days" }, 400);
  const r = await getWhatsOn(admin as any, u.user.id, from, to);
  return json({ from, to, items: r.items });
});
