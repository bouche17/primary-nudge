// Approved WhatsApp templates and the one send path for "we need something from you" account messages.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { blockIfTestPhone } from "./testGuard.ts";
import { recordOutbound } from "./outbound.ts";

/** monty_school_notification_v3: "Hi! 👋 News from {{1}}:\n\n{{2}}\n\nReply "save it" …" */
export const SCHOOL_NOTIFICATION_V3_SID = Deno.env.get("TWILIO_SCHOOL_NOTIFICATION_V3_SID") || "HXeb0f72555240d41d29ffb46285f5402b";
/** v2 (one variable), used only if a v3 send errors. */
export const SCHOOL_NOTIFICATION_V2_SID = Deno.env.get("TWILIO_SCHOOL_NOTIFICATION_SID") || "HX63040a55daeb8ef0673b8a1a156ad9a9";
/** monty_general_account_v1: "Hi, it's Monty 👋 We need to check something on your account: {{1}}. Just reply …" */
export const GENERAL_ACCOUNT_SID = Deno.env.get("TWILIO_GENERAL_ACCOUNT_SID") || "HX6209e9b74c432d4597f6a07e004318f4";

/** Button templates (created via account-check `create_contents`, submitted as Utility). Used only once approved. */
export const SCHOOL_EVENT_V4_SID = Deno.env.get("TWILIO_SCHOOL_EVENT_V4_SID") || "HX90eec9feb0392f39d5be5aaa8cfdc7d9";
export const SUNDAY_CHECKIN_SID = Deno.env.get("TWILIO_SUNDAY_TEMPLATE_SID") || "HXf63d73d24635780bb42d76ba726d83b4";
export const SUNDAY_CHECKIN_V2_SID = Deno.env.get("TWILIO_SUNDAY_CHECKIN_V2_SID") || "HX7c54030c714a4dbeb02ce3a5a71758c8";
export const GENERAL_ACCOUNT_V2_SID = Deno.env.get("TWILIO_GENERAL_ACCOUNT_V2_SID") || "HX695b3543f9e70eb8c52631605639ed8e";

/** Template variables can't hold newlines/control characters; Twilio caps them at 1024. */
export const templateVar = (text: string) => String(text ?? "")
  .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1024);

/** Pure: v3 variables — {"1": school name, "2": built message}. */
export function schoolEmailV3Vars(schoolName: string, message: string): Record<string, string> {
  return { "1": templateVar(schoolName) || "school", "2": templateVar(message) };
}

/** Pure: the account-check variable — no trailing full stop (the template adds one). */
export const accountCheckVar = (detail: string) => templateVar(detail).replace(/[.\s]+$/, "");

const twAuth = () => "Basic " + btoa(`${Deno.env.get("TWILIO_ACCOUNT_SID")}:${Deno.env.get("TWILIO_AUTH_TOKEN")}`);

export interface TemplateSend { ok: boolean; status: number; sid: string | null; body: string }
/** One template send to a WhatsApp number (no test/opt-out check — callers do that). */
export async function sendTemplate(to: string, contentSid: string, vars: Record<string, string>, callbackSource: string): Promise<TemplateSend> {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${Deno.env.get("TWILIO_WHATSAPP_NUMBER")}`);
  params.append("ContentSid", contentSid);
  params.append("ContentVariables", JSON.stringify(vars));
  params.append("StatusCallback", `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=${encodeURIComponent(callbackSource)}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${Deno.env.get("TWILIO_ACCOUNT_SID")}/Messages.json`, {
    method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(),
  });
  const body = await res.text();
  let sid: string | null = null;
  try { sid = JSON.parse(body)?.sid ?? null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, sid, body };
}

/** WhatsApp approval status of a Content template ("approved", "pending", "rejected", …). */
export async function templateApproval(contentSid: string): Promise<{ status: string; raw: unknown }> {
  const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, { headers: { Authorization: twAuth() } });
  const raw = await res.json().catch(() => null);
  if (!res.ok) return { status: `error ${res.status}`, raw };
  return { status: String((raw as any)?.whatsapp?.status ?? "unknown"), raw };
}

const approvalCache = new Map<string, { ok: boolean; at: number }>();
/** The new template once WhatsApp has approved it, otherwise the current one. One status read per 10 min per function instance. */
export async function approvedSid(preferred: string, current: string): Promise<string> {
  if (!preferred) return current;
  const hit = approvalCache.get(preferred);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok ? preferred : current;
  let ok = false;
  try { ok = (await templateApproval(preferred)).status === "approved"; } catch { ok = false; }
  approvalCache.set(preferred, { ok, at: Date.now() });
  return ok ? preferred : current;
}

let db: SupabaseClient | null = null;
const svc = () => (db ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!));

/** "We need to check something on your account: …" — sent with monty_general_account_v1 and recorded in chat (source account_check). */
export async function sendAccountCheck(phone: string, detail: string, meta: Record<string, unknown> = {}): Promise<TemplateSend & { blocked?: boolean; recorded: string | null }> {
  if (await blockIfTestPhone(phone, "account-check")) return { ok: false, status: 0, sid: null, body: "blocked", blocked: true, recorded: null };
  const vars = { "1": accountCheckVar(detail) };
  const sid = await approvedSid(GENERAL_ACCOUNT_V2_SID, GENERAL_ACCOUNT_SID);
  const r = await sendTemplate(phone, sid, vars, "account-check");
  if (!r.ok) {
    await svc().from("message_send_failures").insert({ function_name: "account-check", phone_number: phone, status_code: r.status, error_body: r.body.slice(0, 2000), context: `Template SID: ${sid}` });
    return { ...r, recorded: null };
  }
  const recorded = await recordOutbound({ phone, source: "account_check", contentSid: sid, variables: vars, meta: { ...meta, twilio_sid: r.sid } });
  return { ...r, recorded };
}

export interface SchoolRow { id: string; name: string; address: string | null; town: string | null; postcode: string; urn: string }
/** Pure: the pending "is <child>'s school right?" question, answered by whatsapp-webhook's school flow (stage "check"). */
export function schoolCheckPending(childId: string, school: SchoolRow, question: string, now = new Date()) {
  return { kind: "school", items: [], proposed: null, question, created_at: now.toISOString(), source_text: question,
    school: { stage: "check", child_ids: [childId], chosen: school } };
}
