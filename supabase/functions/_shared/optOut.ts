// Opt-out (STOP) handling shared by every sender. Keyed by phone so it survives account deletion.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let client: SupabaseClient | null = null;
const svc = () => client ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const norm = (p: string) => p.replace(/^whatsapp:/, "").trim();

export type OptIntent = "stop" | "delete" | "start" | null;

/** Whole-message / clear-intent matching only: "the bus stop moved" is NOT an opt-out. */
export function detectOptIntent(raw: string): OptIntent {
  const t = (raw || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 120) return null;
  const pre = "(?:(?:hi|hello|hey|monty|please|pls|ok|okay)\\s+)*(?:(?:how (?:do|can) i|can i|can you|could you|i want to|i'd like to|i would like to|i wanna|i need to|i want you to|please)\\s+)?";
  const post = "(?:\\s+(?:please|pls|thanks|thank you|now|monty))*";
  const del = new RegExp(`^${pre}(?:delete|erase|remove|wipe)\\s+(?:my|all my|our)\\s+(?:account|data|details|information|info|number)(?:\\s+and\\s+(?:data|account|details))?${post}$`);
  if (del.test(t)) return "delete";
  const del2 = new RegExp(`^${pre}(?:delete me|delete everything|delete it all|erase me|i want my (?:data|account|details) (?:deleted|removed|erased)|please delete my (?:data|account|details)|i want (?:my data|everything) deleted)${post}$`);
  if (del2.test(t)) return "delete";
  if (/^(?:start|start again|resume|unstop|restart|start messages|turn (?:reminders|messages) back on)(?:\s+please)?$/.test(t)) return "start";
  const stop = new RegExp(`^${pre}(?:stop|unsubscribe|opt out|optout|stop all|stop messages|stop messaging(?: me)?|stop texting(?: me)?|stop sending(?: me)?(?: messages| reminders)?|stop (?:all |the )?(?:messages|reminders|notifications)|stop (?:the |these )?messages from monty|remove me|take me off(?: the list)?|don't message me|dont message me|do not message me|don't text me|dont text me|no more messages|leave me alone)(?:\\s+(?:from monty|anymore|any more))?${post}$`);
  return stop.test(t) ? "stop" : null;
}

export async function isOptedOut(phone: string | null | undefined): Promise<boolean> {
  if (!phone) return false;
  const { data, error } = await svc().from("opted_out_numbers").select("phone_number").eq("phone_number", norm(phone)).maybeSingle();
  if (error) console.error("[optOut] lookup failed:", error.message);
  return !!data;
}

export async function filterOptedOut(phones: string[]): Promise<string[]> {
  if (!phones.length) return phones;
  const { data } = await svc().from("opted_out_numbers").select("phone_number").in("phone_number", phones.map(norm));
  const out = new Set((data ?? []).map((r: any) => r.phone_number));
  return phones.filter((p) => !out.has(norm(p)));
}

export async function optOut(phone: string, reason: "stop" | "delete", source = "whatsapp") {
  const { error } = await svc().from("opted_out_numbers").upsert({ phone_number: norm(phone), reason, source, opted_out_at: new Date().toISOString() }, { onConflict: "phone_number" });
  if (error) throw new Error(`opt-out failed: ${error.message}`);
}

export async function optIn(phone: string) {
  const { error } = await svc().from("opted_out_numbers").delete().eq("phone_number", norm(phone));
  if (error) throw new Error(`opt-in failed: ${error.message}`);
}

export const OPT_REPLIES = {
  stop: "Done, I've stopped all messages from Monty. Reply START any time to turn them back on.",
  delete: "Done, I've stopped all messages from Monty and passed your deletion request to the team. Your data will be deleted and we'll confirm when it's done. If you have any questions, email hello@heymonty.co.uk.",
  start: "Welcome back, your reminders are switched back on ✅",
  paused: "Your Monty messages are switched off. Reply START any time to turn them back on.",
};
