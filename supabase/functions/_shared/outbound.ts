// Every WhatsApp message Monty sends outside the chat reply (school emails, reminders, Sunday check-in, family
// updates, alerts, welcome, newsletter) is written into the recipient's own conversation, with the exact text they
// saw (templates rendered with their fixed wording), so the chat AI knows what a parent is replying to.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type OutboundSource =
  | "school_email" | "morning_reminder" | "evening_reminder" | "sunday_checkin" | "family_update" | "alert" | "welcome" | "newsletter" | "account_check";

/** Parent-facing label used in chat history: "[Monty sent — school email, Tue 20 Oct 14:42]". */
export const SOURCE_LABEL: Record<string, string> = {
  school_email: "school email", morning_reminder: "morning reminder", evening_reminder: "evening reminder",
  sunday_checkin: "Sunday check-in", family_update: "family update", alert: "system alert", welcome: "welcome message", newsletter: "newsletter",
  account_check: "account check",
};

let client: SupabaseClient | null = null;
function svc(): SupabaseClient {
  if (!client) client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return client;
}

/** Pure: fill {{1}}, {{2}}… in a template body. */
export function fillTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => variables[k] ?? "");
}

/** Pure: the text a parent sees for a Twilio Content API record (body/title, footer, button labels). */
export function contentText(content: any, variables: Record<string, string>): string | null {
  const types = content?.types ?? {};
  for (const t of Object.values(types) as any[]) {
    const main = t?.body ?? t?.title;
    if (typeof main !== "string" || !main.trim()) continue;
    const parts = [main, t.subtitle, t.footer].filter((x) => typeof x === "string" && x.trim());
    let text = fillTemplate(parts.join("\n"), variables);
    const buttons = (t.actions ?? []).map((a: any) => a?.title).filter((x: unknown) => typeof x === "string" && x);
    if (buttons.length) text += `\n[${buttons.map((b: string) => fillTemplate(b, variables)).join("] [")}]`;
    const items = (t.items ?? []).map((x: any) => x?.item).filter((x: unknown) => typeof x === "string" && x);
    if (items.length) text += `\n[${items.map((b: string) => fillTemplate(b, variables)).join("] [")}]`;
    return text;
  }
  return null;
}

const templateCache = new Map<string, any>();
/** The rendered template text. Falls back to the variables alone (marked) if the template can't be read. */
export async function renderTemplate(contentSid: string, variables: Record<string, string>): Promise<{ text: string; rendered: boolean }> {
  const fallback = Object.keys(variables).sort().map((k) => variables[k]).join(" — ");
  try {
    let content = templateCache.get(contentSid);
    if (!content) {
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), tok = Deno.env.get("TWILIO_AUTH_TOKEN");
      if (!sid || !tok) return { text: fallback, rendered: false };
      const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}`, { headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`) } });
      if (!res.ok) { console.error(`[outbound] template ${contentSid} read failed: ${res.status}`); return { text: fallback, rendered: false }; }
      content = await res.json();
      templateCache.set(contentSid, content);
    }
    const text = contentText(content, variables);
    return text ? { text, rendered: true } : { text: fallback, rendered: false };
  } catch (e) {
    console.error("[outbound] template render failed:", (e as Error).message);
    return { text: fallback, rendered: false };
  }
}

export interface OutboundRecord {
  phone: string;
  source: OutboundSource;
  text?: string;                         // free-form text exactly as sent
  contentSid?: string;                   // template: rendered from the approved wording + variables
  variables?: Record<string, string>;
  schoolEmailId?: string | null;
  meta?: Record<string, unknown>;
  at?: Date;
}

/** Write one outbound message into this phone's conversation (created if missing). Never throws. */
export async function recordOutbound(r: OutboundRecord, db: SupabaseClient = svc()): Promise<string | null> {
  try {
    const phone = r.phone.replace(/^whatsapp:/, "");
    let content = r.text ?? "";
    let rendered: boolean | undefined;
    if (r.contentSid) {
      const t = await renderTemplate(r.contentSid, r.variables ?? {});
      content = t.text; rendered = t.rendered;
    }
    if (!content.trim()) return null;
    let { data: convo } = await db.from("conversations").select("id").eq("phone_number", phone).maybeSingle();
    if (!convo) {
      const { data: created, error } = await db.from("conversations").insert({ phone_number: phone, current_step: "active" }).select("id").single();
      if (error) { // created by a parallel insert
        ({ data: convo } = await db.from("conversations").select("id").eq("phone_number", phone).maybeSingle());
      } else convo = created;
    }
    if (!convo) return null;
    const { data, error } = await db.from("messages").insert({
      conversation_id: convo.id, direction: "outbound", content, message_type: r.contentSid ? "template" : "text",
      source: r.source, school_email_id: r.schoolEmailId ?? null,
      metadata: { ...(r.meta ?? {}), ...(r.contentSid ? { template_sid: r.contentSid, variables: r.variables ?? {}, rendered } : {}) },
      created_at: (r.at ?? new Date()).toISOString(),
    }).select("id").single();
    if (error) { console.error("[outbound] record failed:", error.message); return null; }
    return data.id;
  } catch (e) {
    console.error("[outbound] record failed:", (e as Error).message);
    return null;
  }
}
