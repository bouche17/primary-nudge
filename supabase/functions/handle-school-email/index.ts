import { montyClaudeModel } from "../_shared/claudeModel.ts";
import { recordAiCost } from "../_shared/aiCost.ts";
import { blockIfTestPhone, validTestSecret, auditTestEntry } from "../_shared/testGuard.ts";
import { buildSchoolMessage, buildOldSchoolMessage } from "../_shared/schoolEmailMessage.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_SCHOOL_NOTIFICATION_SID = Deno.env.get("TWILIO_SCHOOL_NOTIFICATION_SID") || "HX63040a55daeb8ef0673b8a1a156ad9a9";

const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Fixed extraction instructions: identical for every email, sent as a cached system block.
const EXTRACTION_INSTRUCTIONS = `You are processing a school email from Dean Valley Community Primary School sent via Arbor.

Extract the key information from this email and return ONLY a JSON object with no preamble or markdown.

Return this exact JSON structure:
{
  "message": "the WhatsApp text parents will read — see the rules below",
  "tldr": "ONE punchy sentence capturing the single most important takeaway — genuinely short, like a headline, NOT a paragraph",
  "what": "short label for the type of event/announcement, e.g. 'Community Cup football tournament'",
  "who": "which year groups this affects, in plain readable form, e.g. 'Year 2, Year 3/4, Year 6' or 'All children' for whole-school",
  "when": "the relevant date/term/deadline in readable form, e.g. '2026/27 Terms 1 & 2' or 'by Friday 11th September'",
  "cost": "any cost mentioned, in readable form, e.g. '£25/team (~£2.50-£3.50/child)' — null if no cost is mentioned anywhere in the email",
  "action": "the specific thing a parent needs to do, or null if nothing actionable",
  "links": ["every URL mentioned in the email body, preserved exactly as written"],
  "yearGroups": ["Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6", or "all" for whole school]
}

Guidelines for each field:

message: Write it like a helpful friend passing on the school email. Plain English, 1 to 3 short sentences, at most about 320 characters (links not counted, and don't put links in it).
- Lead with what it is and what the parent needs to know, in everyday words. No labels, no "TL;DR", no headings, no "|" separators, no line breaks.
- Always include, when the email has them: the date or deadline, the cost, and the action. Put any must-do action and its deadline in the final sentence, e.g. "Please book a slot by Friday 23rd October."
- Mention year groups only when it's not for the whole school, and say it naturally ("for Years 3 and 4").
- Never invent anything. If the email has no date, cost or action, don't mention them.
- UK spelling and dates ("Wednesday 21st October"). No exclamation marks, except at most one friendly one. At most one emoji, at the very start, matching the topic (⚽ 📸 🎃 🍽️ 📚 🎒 🏫).
Examples of the style: "⚽ The Y3/4 mixed football tournament is at Macc FC on Wednesday 21st October after school. Children need their PE kit and a water bottle." / "📸 School photos are on Tuesday 3rd November. Order online by Friday 13th November if you'd like copies." / "🎃 Non-uniform day this Friday for £1, raising money for the PTA's Halloween disco."

tldr: Lead with the point. One short headline-style sentence a parent can scan in a second. Never a paragraph.

what: A short, readable label for what this email is about.

who: Plain readable form derived from the same year-group detection used for yearGroups below. Use "All children" when yearGroups is ["all"].

when: The relevant date, term, or deadline in readable form. If the email genuinely has no date/term/deadline, use null. If a field has no genuine value in the email, return JSON null for it — never the string "null", "N/A", "Not stated", "none", "unknown" or similar placeholder text.

cost: Only if a cost is explicitly mentioned anywhere in the email. Keep any per-unit detail (e.g. per team, per child). Never invent or estimate costs.

action: Distinguish two email types:
(a) Deadline-driven / mandatory-action emails (e.g. payment deadlines, forms everyone must complete, final consent dates). Make action clear and compulsory-sounding.
(b) Informational / awareness emails (e.g. club or tournament announcements, general updates, optional activities). Only set action if there is a specific, universal action every relevant parent must take. If the "action" is really an optional or self-selecting invitation (like volunteering for a role, signing up to a club only if interested), leave action as null — the invitation is already captured in tldr/what. Never null out action for mandatory deadlines.

links: Extract ONLY the URLs a parent actually needs to click to take an action or view specific content — e.g. a form to complete, a booking or payment portal, a specific document, or a specific event page. EXCLUDE: mailto: links, tel: links, the school's general homepage or website root (e.g. a bare https://www.deanvalley.cheshire.sch.uk with no specific path), social media links, and anything from email signatures or footers. If no qualifying links exist, return an empty array. Preserve each qualifying link exactly as written, never summarised, shortened, or omitted.

yearGroups: For distribution logic only — use these exact values: "Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6", or "all" for whole school.

Many school emails combine a universal requirement (applies to every child, no exceptions — phrases like "all children", "all pupils", "whether they...", or a deadline/action that doesn't exclude any year group) with year-specific extras (like optional clubs only open to certain years). When this happens, yearGroups should be set to ["all"] — since the universal requirement means every family needs to see the message, even if some content like a specific club doesn't apply to them. Only use specific year groups (not "all") when the ENTIRE email is restricted to those years with no whole-school component at all.`;

async function extractEmailInfo(subject: string, body: string): Promise<{
  message: string | null;
  tldr: string;
  what: string;
  who: string;
  when: string;
  cost: string | null;
  action: string | null;
  links: string[];
  yearGroups: string[];
}> {
  // Per-email part (uncached): the subject, body and today's date.
  const userText = `Email subject: ${subject}

Email body:
${body}

Today's date is ${new Date().toISOString().split("T")[0]}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: montyClaudeModel(),
      max_tokens: 1000,
      system: [{ type: "text", text: EXTRACTION_INSTRUCTIONS, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    }),
  });

  const data = await response.json();
  await recordAiCost({ functionName: "handle-school-email", purpose: "school-email extraction", model: montyClaudeModel(), usage: data.usage });
  const text = data.content[0].text.trim();
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  const parsed = JSON.parse(clean);
  // Normalise: never return empty-string fields — convert to null so callers can omit them cleanly
  for (const key of ["cost", "action", "when", "message"] as const) {
    if (parsed[key] !== null && (typeof parsed[key] !== "string" || parsed[key].trim() === "")) {
      parsed[key] = null;
    }
  }
  return parsed;
}

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (await blockIfTestPhone(to, "handle-school-email")) return true;
  const sanitisedText = text
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1024);

  const contentVariables = JSON.stringify({ "1": sanitisedText });

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", TWILIO_SCHOOL_NOTIFICATION_SID);
  params.append("ContentVariables", contentVariables);
  params.append(
    "StatusCallback",
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=handle-school-email`
  );

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const responseBody = await res.text();
  console.log("Twilio status:", res.status, responseBody);
  if (!res.ok) {
    try {
      await supabase.from("message_send_failures").insert({
        function_name: "handle-school-email",
        phone_number: to,
        period: null,
        status_code: res.status,
        error_body: responseBody,
        context: `Template SID: ${TWILIO_SCHOOL_NOTIFICATION_SID}`,
      });
    } catch (logError) {
      console.error("Failed to log message send failure:", logError);
    }
  }
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const reqBody = await req.json();
    const { from, subject, rawEmail, test, only_phone } = reqBody;
    if (reqBody.dry_run === true) {
      // Dry run: secret-gated, uses only the sample children passed in, never reads families or sends.
      const ok = await validTestSecret(req.headers.get("x-monty-test-secret"));
      await auditTestEntry({ entry_point: "handle-school-email:dry_run", scenario: String(subject ?? "").slice(0, 120), allowed: ok, reason: ok ? "dry_run" : "bad_secret" });
      if (!ok) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const ex = await extractEmailInfo(subject, rawEmail);
      const sample: { first_name: string; year_group: string }[] = Array.isArray(reqBody.sample_children) ? reqBody.sample_children : [];
      const names = sample.filter((c) => (ex.yearGroups || []).some((y) => y.toLowerCase() === (c.year_group || "").toLowerCase())).map((c) => c.first_name);
      return new Response(JSON.stringify({ dry_run: true, extracted: ex, old: buildOldSchoolMessage(ex), new: buildSchoolMessage(ex, names) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const testMode = test === true;
    const catchUpPhone = typeof only_phone === "string" ? only_phone.trim() : null;

    if (testMode) {
      console.log(`[handle-school-email] TEST MODE active — only ${TEST_PHONE_NUMBER} will receive messages`);
    }
    if (catchUpPhone) {
      console.log(`[handle-school-email] CATCH-UP MODE active — only ${catchUpPhone} will receive messages`);
    }

    console.log(`Received email from ${from}, subject: ${subject}`);

    // Extract info using Claude
    const extracted = await extractEmailInfo(subject, rawEmail);
    console.log("Extracted:", JSON.stringify(extracted));

    // Find relevant parents based on year groups
    let query = supabase
      .from("children")
      .select("parent_id, year_group, first_name");

    const { data: children } = await query;

    if (!children || children.length === 0) {
      return new Response(JSON.stringify({ message: "No children found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Filter children by year group
    const isWholeSchool = extracted.yearGroups.includes("all");
    const relevantChildren = isWholeSchool
      ? children
      : children.filter((c: any) =>
          extracted.yearGroups.some(
            (yg) => yg.toLowerCase() === (c.year_group || "").toLowerCase()
          )
        );

    // Get unique parent IDs of relevant children
    const parentIds = [...new Set(relevantChildren.map((c: any) => c.parent_id))];

    // Fetch all phone-bearing profiles and accepted links for family resolution
    const { data: allProfiles } = await supabase
      .from("profiles")
      .select("user_id, phone_number")
      .not("phone_number", "is", null);

    const { data: linkedAccounts } = await supabase
      .from("linked_accounts")
      .select("primary_user_id, linked_user_id")
      .eq("status", "accepted");

    // ── Union-find family grouping (same approach as send-reminders) ──────────
    const familyOf = new Map<string, string>();
    const find = (u: string): string => {
      const p = familyOf.get(u);
      if (!p || p === u) return u;
      const root = find(p);
      familyOf.set(u, root);
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) familyOf.set(rb, ra);
    };
    for (const c of children) if (!familyOf.has(c.parent_id)) familyOf.set(c.parent_id, c.parent_id);
    for (const p of allProfiles || []) if (!familyOf.has(p.user_id)) familyOf.set(p.user_id, p.user_id);
    for (const link of linkedAccounts || []) {
      if (!familyOf.has(link.primary_user_id)) familyOf.set(link.primary_user_id, link.primary_user_id);
      if (!familyOf.has(link.linked_user_id)) familyOf.set(link.linked_user_id, link.linked_user_id);
      union(link.primary_user_id, link.linked_user_id);
    }

    const phonesByFamily = new Map<string, Set<string>>();
    for (const p of allProfiles || []) {
      if (!p.phone_number) continue;
      const fam = find(p.user_id);
      if (!phonesByFamily.has(fam)) phonesByFamily.set(fam, new Set());
      phonesByFamily.get(fam)!.add(p.phone_number as string);
    }

    // One message per family: targeted emails start with that family's matching children ("For Caspian: …").
    const kidsByFamily = new Map<string, string[]>();
    for (const c of relevantChildren as any[]) {
      const fam = find(c.parent_id);
      if (!kidsByFamily.has(fam)) kidsByFamily.set(fam, []);
      kidsByFamily.get(fam)!.push(c.first_name);
    }
    const sends: { phone: string; message: string }[] = [];
    const seenPhones = new Set<string>();
    for (const [fam, kids] of kidsByFamily) {
      const message = buildSchoolMessage(extracted, kids.sort((a, b) => a.localeCompare(b)));
      for (const phone of phonesByFamily.get(fam) || []) {
        if (seenPhones.has(phone)) continue;
        if (testMode && phone !== TEST_PHONE_NUMBER) continue;
        if (catchUpPhone && phone !== catchUpPhone) continue;
        seenPhones.add(phone);
        sends.push({ phone, message });
      }
    }

    if (sends.length === 0) {
      return new Response(JSON.stringify({ message: "No parent phone numbers found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sentCount = 0;
    for (const { phone, message } of sends) {
      if (await sendWhatsApp(phone, message)) sentCount++;
    }

    console.log(`Sent to ${sentCount} parents for year groups: ${extracted.yearGroups.join(", ")}`);

    return new Response(JSON.stringify({ success: true, sent: sentCount, extracted, test_mode: testMode }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("handle-school-email error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
