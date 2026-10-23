// New sign-up alerts to Matt. Woken by a database trigger each time a signup_events row is written (a parent profile
// created or a child added — test families are never recorded). It answers at once, waits ~90s in the background so
// the rest of the sign-up (the children) can arrive, then sends ONE alert per run for every settled sign-up.
// Channel: Matt's WhatsApp inside his 24h window (sendAlertWhatsApp); otherwise kept as "email_pending" and shown on
// /admin/signups until email to hello@heymonty.co.uk is set up.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { sendAlertWhatsApp } from "../_shared/alerts.ts";
import { isTestPhone } from "../_shared/testGuard.ts";
import { buildSignupAlert, type SignupChild } from "../_shared/signupAlert.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const WAIT_MS = 90_000;   // background wait before looking
const SETTLE_MS = 60_000; // a family is ready when its newest pending event is at least this old

async function processSettled() {
  const now = Date.now();
  const { data: pending, error } = await admin.from("signup_events").select("id, created_at, kind, user_id, child_id")
    .is("processed_at", null).gt("created_at", new Date(now - 7 * 86400_000).toISOString()).order("created_at").limit(200);
  if (error) { console.error("[signup-alerts] read failed:", error.message); return { error: error.message }; }
  const byUser = new Map<string, NonNullable<typeof pending>>();
  for (const e of pending ?? []) byUser.set(e.user_id, [...(byUser.get(e.user_id) ?? []), e]);

  const texts: string[] = []; const claimed: string[] = []; const skipped: string[] = [];
  for (const [userId, evs] of byUser) {
    const newest = Math.max(...evs.map((e) => new Date(e.created_at).getTime()));
    if (now - newest < SETTLE_MS) continue; // still signing up; a later wake-up handles it
    const childIds = evs.filter((e) => e.kind === "child_added" && e.child_id).map((e) => e.child_id!);
    const newParent = evs.some((e) => e.kind === "profile_created");
    const [{ data: prof }, { data: u }] = await Promise.all([
      admin.from("profiles").select("phone_number").eq("user_id", userId).maybeSingle(),
      admin.auth.admin.getUserById(userId),
    ]);
    const email = u?.user?.email ?? "";
    if ((prof?.phone_number && await isTestPhone(prof.phone_number)) || email.endsWith("@monty-test.invalid")) { skipped.push(...evs.map((e) => e.id)); continue; }
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, string | undefined>;
    const first = (meta.given_name || meta.full_name || meta.name || "").trim().split(/\s+/)[0] || null;
    const children: SignupChild[] = [];
    if (childIds.length) {
      const { data: kids } = await admin.from("children").select("id, first_name, year_group, school_id, schools(id, name, address, town, postcode)").in("id", childIds);
      const schoolIds = [...new Set((kids ?? []).map((k: any) => k.school_id).filter(Boolean))];
      const { data: feeds } = schoolIds.length ? await admin.from("school_calendar_feeds").select("school_id").in("school_id", schoolIds) : { data: [] as any[] };
      const known = new Set((feeds ?? []).map((f: any) => f.school_id));
      for (const k of (kids ?? []) as any[]) {
        children.push({ firstName: k.first_name, yearGroup: k.year_group, school: k.schools ? { ...k.schools, known: known.has(k.school_id) } : null });
      }
      if (!children.length && !newParent) { skipped.push(...evs.map((e) => e.id)); continue; } // child removed again before the alert
    }
    texts.push(buildSignupAlert({ parentFirstName: first, newParent, children, signedUpAt: new Date(evs[0].created_at) }));
    claimed.push(...evs.map((e) => e.id));
  }

  if (skipped.length) await admin.from("signup_events").update({ processed_at: new Date().toISOString(), channel: "skipped" }).in("id", skipped).is("processed_at", null);
  if (!claimed.length) return { sent: 0, skipped: skipped.length };
  // Claim before sending so an overlapping wake-up can't send the same sign-up twice.
  const { data: mine } = await admin.from("signup_events").update({ processed_at: new Date().toISOString(), channel: "sending" })
    .in("id", claimed).is("processed_at", null).select("id");
  if ((mine ?? []).length !== claimed.length) {
    // Another run got some of them first: release ours so the next wake-up retries cleanly.
    await admin.from("signup_events").update({ processed_at: null, channel: null }).in("id", (mine ?? []).map((m) => m.id)).eq("channel", "sending");
    return { sent: 0, note: "claimed by another run" };
  }
  const message = texts.length === 1 ? texts[0] : `Monty alert: ${texts.length} new sign-ups.\n` + texts.map((t) => "• " + t.replace(/^Monty alert:\s*/, "")).join("\n");
  const res = await sendAlertWhatsApp(message).catch(() => ({ ok: false, channel: "error" }));
  await admin.from("signup_events").update({ channel: res.channel, delivered: res.ok, alert_text: message }).in("id", claimed);
  console.log("[signup-alerts]", texts.length, "sign-up(s) →", res.channel);
  return { sent: texts.length, channel: res.channel, delivered: res.ok };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const body = await req.json().catch(() => ({}));
  const job = (async () => { await new Promise((r) => setTimeout(r, WAIT_MS)); return await processSettled(); })();
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(job.catch((e) => console.error("[signup-alerts]", e))); return json({ queued: true, event_id: body?.event_id ?? null }, 202); }
  return json(await job);
});
