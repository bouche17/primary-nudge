// Runs every minute (pg_cron). Bundles queued dashboard changes per family into
// ONE monty_family_update WhatsApp per other adult.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TEMPLATE_SID = Deno.env.get("TWILIO_FAMILY_UPDATE_TEMPLATE_SID") || "HX2b134e5257d687bab6f38904e73043b9";
const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";
const QUIET_MINUTES = 5;
const CAP_MINUTES = 30;
const MAX_LEN = 300;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface Row {
  id: string;
  family_key: string;
  actor_user_id: string;
  actor_first_name: string | null;
  item_key: string | null;
  summary: string;
  created_at: string;
  updated_at: string;
}

function sanitise(input: string): string {
  return input
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, " | ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCombined(rows: Row[]): string {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const items = sorted.map((r) => sanitise(r.summary)).filter(Boolean);
  const actors = new Set(sorted.map((r) => r.actor_user_id));
  const name = actors.size === 1 ? sanitise(sorted[sorted.length - 1].actor_first_name || "") : "";
  const suffix = name ? ` (changed by ${name})` : "";

  const full = items.join(" | ") + suffix;
  if (full.length <= MAX_LEN) return full;

  // Fit as many whole items as possible, then "and N more changes".
  for (let n = items.length - 1; n >= 0; n--) {
    const rest = items.length - n;
    const tail = `and ${rest} more change${rest === 1 ? "" : "s"}`;
    const head = items.slice(0, n).join(" | ");
    const text = (head ? `${head} | ${tail}` : tail) + suffix;
    if (text.length <= MAX_LEN) return text;
  }
  return `${items.length} changes${suffix}`.slice(0, MAX_LEN);
}

async function resolveFamily(userId: string): Promise<Set<string>> {
  const { data: links } = await supabase
    .from("linked_accounts").select("primary_user_id, linked_user_id").eq("status", "accepted");
  const family = new Set<string>([userId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of links || []) {
      const a = family.has(l.primary_user_id), b = family.has(l.linked_user_id);
      if (a && !b) { family.add(l.linked_user_id); grew = true; }
      if (b && !a) { family.add(l.primary_user_id); grew = true; }
    }
  }
  return family;
}

async function sendTemplate(to: string, text: string) {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", TEMPLATE_SID);
  params.append("ContentVariables", JSON.stringify({ "1": text }));
  params.append("StatusCallback", `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=flush-family-updates`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[flush-family-updates] Twilio ${res.status}: ${body}`);
    try {
      await supabase.from("message_send_failures").insert({
        function_name: "flush-family-updates",
        phone_number: to,
        period: null,
        status_code: res.status,
        error_body: body,
        context: `Template SID: ${TEMPLATE_SID}`,
      });
    } catch (e) {
      console.error("Failed to log message send failure:", e);
    }
  }
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* cron may send no body */ }
    const testMode = body.test === true || new URL(req.url).searchParams.get("test") === "true";

    let rows: Row[] = [];
    if (testMode) {
      // Read-only: find ready families without claiming anything.
      const { data, error } = await supabase
        .from("pending_family_updates")
        .select("id, family_key, actor_user_id, actor_first_name, item_key, summary, created_at, updated_at")
        .is("sent_at", null);
      if (error) throw error;
      const now = Date.now();
      const byFam = new Map<string, Row[]>();
      for (const r of (data || []) as Row[]) {
        if (!byFam.has(r.family_key)) byFam.set(r.family_key, []);
        byFam.get(r.family_key)!.push(r);
      }
      for (const fam of byFam.values()) {
        const newest = Math.max(...fam.map((r) => Date.parse(r.updated_at)));
        const oldest = Math.min(...fam.map((r) => Date.parse(r.created_at)));
        if (now - newest >= QUIET_MINUTES * 60_000 || now - oldest >= CAP_MINUTES * 60_000) rows.push(...fam);
      }
    } else {
      const { data, error } = await supabase.rpc("claim_family_updates", {
        _quiet_minutes: QUIET_MINUTES, _cap_minutes: CAP_MINUTES,
      });
      if (error) throw error;
      rows = (data || []) as Row[];
    }

    if (rows.length === 0) return json({ families: 0, sent: 0, test_mode: testMode });

    const families = new Map<string, Row[]>();
    for (const r of rows) {
      if (!families.has(r.family_key)) families.set(r.family_key, []);
      families.get(r.family_key)!.push(r);
    }

    const results: unknown[] = [];
    let totalSent = 0;

    for (const [familyKey, famRows] of families) {
      const combined = sanitise(buildCombined(famRows)).slice(0, MAX_LEN);
      const actors = new Set(famRows.map((r) => r.actor_user_id));
      const family = await resolveFamily(familyKey);
      for (const a of actors) family.add(a);

      const { data: profiles } = await supabase
        .from("profiles").select("user_id, phone_number")
        .in("user_id", Array.from(family)).not("phone_number", "is", null);

      let recipients = Array.from(new Set(
        (profiles || []).filter((p) => !actors.has(p.user_id)).map((p) => p.phone_number as string),
      ));
      if (testMode) recipients = recipients.filter((p) => p === TEST_PHONE_NUMBER);

      const payloads = recipients.map((to) => ({
        To: `whatsapp:${to}`,
        From: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
        ContentSid: TEMPLATE_SID,
        ContentVariables: JSON.stringify({ "1": combined }),
      }));

      let sent = 0;
      if (combined) {
        for (const to of recipients) if (await sendTemplate(to, combined)) sent++;
      }
      totalSent += sent;

      if (!testMode) {
        const { error: markErr } = await supabase
          .from("pending_family_updates")
          .update({ sent_at: new Date().toISOString() })
          .in("id", famRows.map((r) => r.id));
        if (markErr) console.error(`[flush-family-updates] failed to mark sent for ${familyKey}:`, markErr);
      }

      results.push({ family_key: familyKey, items: famRows.length, recipients: recipients.length, sent, ...(testMode ? { payloads } : {}) });
    }

    return json({ families: families.size, sent: totalSent, test_mode: testMode, results });
  } catch (e) {
    console.error("[flush-family-updates] error:", e);
    return json({ error: "Internal server error" }, 500);
  }
});
