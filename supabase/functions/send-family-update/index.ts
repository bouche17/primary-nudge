// Sends the monty_family_update template to every OTHER adult in a family
// when someone changes the family's plans from the dashboard.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TEMPLATE_SID = Deno.env.get("TWILIO_FAMILY_UPDATE_TEMPLATE_SID") || "HX2b134e5257d687bab6f38904e73043b9";
const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function sanitiseSummary(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, " | ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .trim();
}

// All user ids in the same family as `userId` (accepted linked accounts, transitive).
async function resolveFamily(userId: string): Promise<Set<string>> {
  const { data: links } = await supabase
    .from("linked_accounts")
    .select("primary_user_id, linked_user_id")
    .eq("status", "accepted");
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

async function sendTemplate(to: string, summary: string) {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", TEMPLATE_SID);
  params.append("ContentVariables", JSON.stringify({ "1": summary }));
  params.append("StatusCallback", `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=send-family-update`);

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
    console.error(`[send-family-update] Twilio ${res.status}: ${body}`);
    try {
      await supabase.from("message_send_failures").insert({
        function_name: "send-family-update",
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
  return { ok: res.ok, status: res.status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // Authenticate caller
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return json({ error: "Unauthorized" }, 401);
    const callerId = authData.user.id;

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

    const familyId = typeof body.family_id === "string" ? body.family_id : "";
    const excludeId = typeof body.exclude_profile_id === "string" ? body.exclude_profile_id : null;
    const testMode = body.test === true || new URL(req.url).searchParams.get("test") === "true";
    if (!familyId) return json({ error: "family_id is required" }, 400);

    const summary = sanitiseSummary(body.summary);
    if (!summary) return json({ sent: 0, skipped: true, reason: "empty_summary", test_mode: testMode });

    // family_id = any user id in the family; caller must belong to it
    const family = await resolveFamily(callerId);
    if (!family.has(familyId)) return json({ error: "Forbidden" }, 403);

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, user_id, phone_number")
      .in("user_id", Array.from(family))
      .not("phone_number", "is", null);

    let recipients = (profiles || [])
      .filter((p) => p.id !== excludeId && p.user_id !== excludeId && p.user_id !== callerId)
      .map((p) => p.phone_number as string);
    recipients = Array.from(new Set(recipients));

    if (!testMode) {
      // Queue for bundling — flush-family-updates sends one combined message later.
      if (recipients.length === 0) {
        return json({ queued: false, skipped: true, reason: "no_other_adults" });
      }
      const itemKey = typeof body.item_key === "string" && body.item_key.trim() ? body.item_key.trim().slice(0, 200) : null;
      const meta = (authData.user.user_metadata || {}) as Record<string, unknown>;
      const rawName = String(meta.full_name || meta.name || body.actor_first_name || "").trim().split(/\s+/)[0] || "";
      const actorFirstName = sanitiseSummary(rawName).slice(0, 50) || null;
      const familyKey = Array.from(family).sort()[0];
      const row = { family_key: familyKey, actor_user_id: callerId, actor_first_name: actorFirstName, item_key: itemKey, summary };

      if (itemKey) {
        const update = () =>
          supabase.from("pending_family_updates")
            .update({ actor_user_id: callerId, actor_first_name: actorFirstName, summary, processing_at: null })
            .eq("family_key", familyKey).eq("item_key", itemKey).is("sent_at", null).is("processing_at", null)
            .select("id");
        const { data: updated, error: upErr } = await update();
        if (upErr) throw upErr;
        if (!updated || updated.length === 0) {
          const { error: insErr } = await supabase.from("pending_family_updates").insert(row);
          if (insErr?.code === "23505") {
            const { error: retryErr } = await update();
            if (retryErr) throw retryErr;
          } else if (insErr) throw insErr;
        }
      } else {
        const { error: insErr } = await supabase.from("pending_family_updates").insert(row);
        if (insErr) throw insErr;
      }
      return json({ queued: true, family_key: familyKey, item_key: itemKey });
    }

    console.log(`[send-family-update] TEST MODE active — only ${TEST_PHONE_NUMBER} will receive messages`);
    recipients = recipients.filter((p) => p === TEST_PHONE_NUMBER);

    const payloads = recipients.map((to) => ({
      To: `whatsapp:${to}`,
      From: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      ContentSid: TEMPLATE_SID,
      ContentVariables: JSON.stringify({ "1": summary }),
    }));

    if (recipients.length === 0) {
      return json({ sent: 0, skipped: true, reason: "no_other_adults", test_mode: true, payloads });
    }

    let sent = 0;
    for (const to of recipients) {
      const r = await sendTemplate(to, summary);
      if (r.ok) sent++;
    }
    return json({ sent, attempted: recipients.length, test_mode: true, payloads });
  } catch (e) {
    console.error("[send-family-update] error:", e);
    return json({ error: "Internal server error" }, 500);
  }
});
