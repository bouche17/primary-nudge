// Ops alerts for Matt: Claude failures and failed WhatsApp deliveries to REAL parents.
// - Claude: 3+ failures of the same type within 10 minutes → one alert, max once per hour per type.
// - WhatsApp: 3+ failed/undelivered deliveries within an hour → one alert, max once per hour.
// Sent to Matt's WhatsApp (no email setup exists): free-form inside the 24h window, approved template otherwise.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isTestPhone, blockIfTestPhone } from "./testGuard.ts";

let client: SupabaseClient | null = null;
const svc = () => client ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

export const ALERT_PHONE = () => Deno.env.get("MONTY_ALERT_PHONE") || Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";

export type ClaudeErrorType = "credit" | "auth" | "rate_limit" | "server" | "other";
export function classifyClaudeError(status: number | null, body: string | null): ClaudeErrorType {
  const b = (body || "").toLowerCase();
  if (/credit balance|billing|purchase credits/.test(b)) return "credit";
  if (status === 401 || status === 403 || /authentication|invalid x-api-key|permission/.test(b)) return "auth";
  if (status === 429 || /rate.?limit/.test(b)) return "rate_limit";
  if ((status ?? 0) >= 500 || /overloaded/.test(b)) return "server";
  return "other";
}
const CLAUDE_FIX: Record<ClaudeErrorType, string> = {
  credit: "Anthropic credit has run out - top up at console.anthropic.com (Plans & Billing)",
  auth: "Anthropic rejected the API key - check ANTHROPIC_API_KEY in the backend secrets",
  rate_limit: "Anthropic rate limit hit - usually clears on its own; if it keeps happening, raise the usage tier at console.anthropic.com",
  server: "Anthropic is having an outage or is overloaded - check status.anthropic.com; usually clears on its own",
  other: "Anthropic rejected the request - check the MONTY_CLAUDE_MODEL setting and any recent changes",
};
export function deliveryFix(code: string | null): string {
  if (code === "63016") return "Message sent outside the 24-hour window - it needs an approved template";
  if (code === "63003" || code === "63024") return "The number can't receive WhatsApp messages - check the parent's number";
  if (code === "63018" || code === "63038") return "Twilio/Meta rate or daily limit hit - check the Twilio console";
  return "Check the failed messages in the Twilio console (Monitor > Logs > Messaging)";
}

export type Sender = (text: string) => Promise<{ ok: boolean; channel: string }>;
export interface AlertOpts { now?: Date; send?: Sender; functionName?: string; isTest?: boolean }

const shortErr = (s: string | null) => {
  try { const j = JSON.parse(s || ""); return String(j?.error?.message || j?.ErrorMessage || j?.ErrorCode || s).slice(0, 160); } catch { return (s || "").slice(0, 160); }
};

async function realOnly<T extends { phone_number: string | null }>(rows: T[]): Promise<T[]> {
  const out: T[] = [];
  for (const r of rows) if (r.phone_number && !(await isTestPhone(r.phone_number))) out.push(r);
  return out;
}

async function throttled(type: string, isTest: boolean, now: Date): Promise<boolean> {
  const { data } = await svc().from("ops_alerts").select("id").eq("alert_type", type).eq("is_test", isTest)
    .gt("created_at", new Date(now.getTime() - 3600_000).toISOString()).limit(1);
  return (data ?? []).length > 0;
}

async function raise(type: string, rows: { phone_number: string | null }[], firstError: string, fix: string, what: string, o: AlertOpts, now: Date) {
  const isTest = o.isTest === true;
  if (await throttled(type, isTest, now)) return null;
  const parents = new Set(rows.map((r) => r.phone_number)).size;
  const message = `Monty alert: ${what}. ${rows.length} failures, ${parents} parent${parents === 1 ? "" : "s"} affected. First error: ${firstError}. Likely fix: ${fix}.`;
  const { data: row } = await svc().from("ops_alerts").insert({
    alert_type: type, affected_parents: parents, failure_count: rows.length, first_error: firstError, likely_fix: fix, message, is_test: isTest,
    created_at: now.toISOString(),
  }).select("id").single();
  const res = await (o.send ?? sendAlertWhatsApp)(message).catch(() => ({ ok: false, channel: "error" }));
  if (row) await svc().from("ops_alerts").update({ delivered: res.ok, channel: res.channel }).eq("id", row.id);
  return { message, ...res };
}

/** Call after logging a Claude failure. */
export async function evaluateClaudeAlerts(o: AlertOpts = {}) {
  const now = o.now ?? new Date();
  const { data } = await svc().from("message_send_failures").select("phone_number, status_code, error_body, created_at")
    .eq("function_name", o.functionName ?? "whatsapp-webhook").like("context", "Claude API%")
    .gt("created_at", new Date(now.getTime() - 600_000).toISOString()).order("created_at");
  const rows = await realOnly(data ?? []);
  const sent = [];
  for (const t of ["credit", "auth", "rate_limit", "server", "other"] as ClaudeErrorType[]) {
    const of = rows.filter((r) => classifyClaudeError(r.status_code, r.error_body) === t);
    if (of.length < 3) continue;
    const r = await raise(`claude_${t}`, of, `${of[0].status_code} ${shortErr(of[0].error_body)}`, CLAUDE_FIX[t],
      "Monty can't reach its AI, so parents' messages aren't being handled", o, now);
    if (r) sent.push(r);
  }
  return sent;
}

/** Call after logging a failed/undelivered WhatsApp delivery. */
export async function evaluateDeliveryAlerts(o: AlertOpts = {}) {
  const now = o.now ?? new Date();
  let q = svc().from("message_send_failures").select("phone_number, error_body, created_at")
    .like("context", "Async delivery failure%").gt("created_at", new Date(now.getTime() - 3600_000).toISOString()).order("created_at");
  q = o.functionName ? q.eq("function_name", o.functionName) : q.neq("function_name", "alert-sim-test"); // simulated rows never trigger real alerts
  const { data } = await q;
  const rows = await realOnly(data ?? []);
  if (rows.length < 3) return [];
  let code: string | null = null;
  try { code = JSON.parse(rows[0].error_body || "{}").ErrorCode ?? null; } catch { /* */ }
  const r = await raise("whatsapp_delivery", rows, shortErr(rows[0].error_body), deliveryFix(code),
    "WhatsApp messages to parents are failing to deliver", o, now);
  return r ? [r] : [];
}

/** Free-form WhatsApp inside Matt's 24h window, otherwise the approved single-variable template. */
export async function sendAlertWhatsApp(text: string): Promise<{ ok: boolean; channel: string }> {
  const to = ALERT_PHONE();
  if (await blockIfTestPhone(to, "ops-alert")) return { ok: false, channel: "blocked_test_number" };
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!, tok = Deno.env.get("TWILIO_AUTH_TOKEN")!, from = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
  const { data: convo } = await svc().from("conversations").select("id").eq("phone_number", to).maybeSingle();
  let inWindow = false;
  if (convo) {
    const { data: last } = await svc().from("messages").select("created_at").eq("conversation_id", convo.id).eq("direction", "inbound")
      .order("created_at", { ascending: false }).limit(1);
    inWindow = !!last?.[0] && Date.now() - new Date(last[0].created_at).getTime() < 23.5 * 3600_000;
  }
  const params = new URLSearchParams({ To: `whatsapp:${to}`, From: `whatsapp:${from}` });
  if (inWindow) params.set("Body", text);
  else {
    params.set("ContentSid", Deno.env.get("TWILIO_SCHOOL_NOTIFICATION_SID") || "HX63040a55daeb8ef0673b8a1a156ad9a9");
    params.set("ContentVariables", JSON.stringify({ "1": text.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").replace(/\s+/g, " ").slice(0, 1000) }));
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST", headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(),
  });
  const body = await res.text();
  if (!res.ok) console.error("[alerts] WhatsApp alert failed:", res.status, body);
  return { ok: res.ok, channel: inWindow ? "whatsapp_freeform" : "whatsapp_template" };
}
