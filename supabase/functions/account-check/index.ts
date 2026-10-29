// Admin-only "we need to check something on your account" sends (monty_general_account_v1).
// Actions: status (template approval), send (one child's parent phones, optional school check), delivery (Twilio status).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { GENERAL_ACCOUNT_SID, SCHOOL_NOTIFICATION_V3_SID, schoolCheckPending, sendAccountCheck, templateApproval } from "../_shared/twilioTemplates.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function requireAdmin(req: Request): Promise<boolean> {
  const runnerToken = req.headers.get("x-runner-token");
  if (runnerToken && runnerToken.length >= 32) {
    const { data } = await admin.from("test_runner_tokens").delete().eq("token_hash", await sha256Hex(runnerToken)).gt("expires_at", new Date().toISOString()).select("token_hash");
    return !!data && data.length === 1;
  }
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return false;
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
  return !!role;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!(await requireAdmin(req))) return json({ error: "forbidden" }, 403);
    const body = await req.json().catch(() => ({}));
    const auth = { Authorization: "Basic " + btoa(`${Deno.env.get("TWILIO_ACCOUNT_SID")}:${Deno.env.get("TWILIO_AUTH_TOKEN")}`) };

    if (body.action === "status") {
      const [general, v3] = await Promise.all([templateApproval(GENERAL_ACCOUNT_SID), templateApproval(SCHOOL_NOTIFICATION_V3_SID)]);
      return json({ general_account_v1: general, school_notification_v3: v3 });
    }

    if (body.action === "create_contents") {
      // One-off: create the in-session button/list records and the three button templates, submit the templates (Utility).
      const create = async (def: Record<string, unknown>) => {
        const r = await fetch("https://content.twilio.com/v1/Content", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ language: "en", ...def }) });
        const j = await r.json().catch(() => ({}));
        return r.ok ? { sid: j.sid as string } : { error: `${r.status}: ${JSON.stringify(j).slice(0, 300)}` };
      };
      const submit = async (sid: string, name: string) => {
        const r = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ name, category: "UTILITY" }) });
        const j = await r.json().catch(() => ({}));
        return r.ok ? String(j.status ?? "submitted") : `error ${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
      };
      const only: string[] | null = Array.isArray(body.only) ? body.only : null;
      const session: Record<string, unknown> = {};
      for (const [k, d] of Object.entries(SESSION_DEFS)) if (!only || only.includes(k)) session[k] = await create(d);
      const sundayRes = await fetch(`https://content.twilio.com/v1/Content/${SUNDAY_CHECKIN_SID}`, { headers: auth });
      const sunday = await sundayRes.json().catch(() => ({}));
      const sundayBody = Object.values(sunday?.types ?? {}).map((t: any) => t?.body).find((b) => typeof b === "string");
      const templates: Record<string, unknown> = {};
      const defs: [string, string, Record<string, unknown>][] = [
        ["school_event_v4", "monty_school_event_v4", { variables: { "1": "Dean Valley Community Primary School", "2": "⚽ The Y3/4 football tournament is at Macc FC on Wednesday 21st October after school." },
          types: { "twilio/quick-reply": { body: TEMPLATE_BODIES.school_event_v4, actions: TEMPLATE_BUTTONS.school_event_v4 } } }],
        ["account_v2", "monty_general_account_v2", { variables: { "1": "is Hallie's school right? We have St Joseph's Catholic Primary, Sale" },
          types: { "twilio/quick-reply": { body: TEMPLATE_BODIES.account_v2, actions: TEMPLATE_BUTTONS.account_v2 } } }],
      ];
      if (sundayBody) defs.push(["sunday_v2", "monty_sunday_checkin_v2", { variables: sunday.variables ?? {}, types: { "twilio/quick-reply": { body: sundayBody, actions: TEMPLATE_BUTTONS.sunday_v2 } } }]);
      else templates.sunday_v2 = { error: `couldn't read the current Sunday template (${sundayRes.status})` };
      for (const [k, name, def] of defs) {
        if (only && !only.includes(k)) continue;
        const c = await create({ friendly_name: name, ...def });
        templates[k] = "sid" in c ? { sid: c.sid, approval: await submit(c.sid as string, name) } : c;
      }
      return json({ session, templates, sunday_body: sundayBody ?? null });
    }

    if (body.action === "delivery") {
      const sids: string[] = (Array.isArray(body.sids) ? body.sids : []).filter((s: unknown) => typeof s === "string" && /^(SM|MM)[0-9a-f]{32}$/i.test(s));
      const out = [];
      for (const sid of sids) {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${Deno.env.get("TWILIO_ACCOUNT_SID")}/Messages/${sid}.json`, { headers: auth });
        const m = await r.json().catch(() => ({}));
        out.push({ sid, status: m.status ?? `error ${r.status}`, error_code: m.error_code ?? null });
      }
      return json({ delivery: out });
    }

    if (body.action === "send") {
      const childId = String(body.child_id ?? "");
      const detail = String(body.detail ?? "").trim();
      if (!UUID.test(childId) || detail.length < 5 || detail.length > 500) return json({ error: "child_id and detail required" }, 400);
      const { data: child } = await admin.from("children").select("id, first_name, parent_id, school_id").eq("id", childId).maybeSingle();
      if (!child) return json({ error: "child not found" }, 404);
      const { data: prof } = await admin.from("profiles").select("phone_number").eq("user_id", child.parent_id).maybeSingle();
      const phone = prof?.phone_number as string | undefined;
      if (!phone) return json({ error: "parent has no phone" }, 404);
      const r = await sendAccountCheck(phone, detail, { child_id: childId, purpose: body.school_check ? "school_check" : "general" });
      let pending = false;
      if (r.ok && body.school_check === true && child.school_id) {
        const { data: school } = await admin.from("schools").select("id, name, address, town, postcode, urn").eq("id", child.school_id).maybeSingle();
        const { data: convo } = await admin.from("conversations").select("id, context").eq("phone_number", phone).maybeSingle();
        if (school && convo) {
          const { error } = await admin.from("conversations").update({ context: { ...(convo.context || {}), pending_action: schoolCheckPending(child.id, school as any, `is ${child.first_name}'s school right? We have ${school.name}`) } }).eq("id", convo.id);
          pending = !error;
        }
      }
      return json({ ok: r.ok, status: r.status, blocked: r.blocked ?? false, twilio_sid: r.sid, recorded: !!r.recorded, pending_set: pending, error: r.ok ? undefined : r.body.slice(0, 500) });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("account-check error:", e);
    return json({ error: String(e) }, 500);
  }
});
