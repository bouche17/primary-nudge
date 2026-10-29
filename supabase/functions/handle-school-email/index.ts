import { montyClaudeModel } from "../_shared/claudeModel.ts";
import { recordAiCost } from "../_shared/aiCost.ts";
import { blockIfTestPhone, isTestPhone, validTestSecret, auditTestEntry } from "../_shared/testGuard.ts";
import { buildSchoolMessage, buildOldSchoolMessage, type SchoolEmailInfo } from "../_shared/schoolEmailMessage.ts";
import { isOptInEmail } from "../_shared/schoolEventRules.ts";
import { recordOutbound } from "../_shared/outbound.ts";
import { SCHOOL_NOTIFICATION_V2_SID, SCHOOL_NOTIFICATION_V3_SID, schoolEmailV3Vars, sendTemplate, templateVar, type TemplateSend } from "../_shared/twilioTemplates.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";
// These emails come from Dean Valley's Arbor account, so only Dean Valley families receive them.
const DEAN_VALLEY_SCHOOL_ID = Deno.env.get("SCHOOL_EMAIL_SCHOOL_ID") || "f656deff-dedf-4d00-a6aa-8a779f83a3b5";

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
  "yearGroups": ["Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6", or "all" for whole school],
  "eventTitle": "short name of the event a parent might want a reminder for, e.g. 'Y3/4 girls' football tournament' — null if there is no single dated event",
  "eventDate": "that event's date as YYYY-MM-DD — null if there is no single date",
  "optInGroup": "only for optional/selected activities (teams, squads, clubs, tournaments, trials): who takes part, written to follow 'If Ava's in …', e.g. 'the Y3/4 girls' football team' — null otherwise"
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

eventTitle / eventDate: the one dated event in the email (the day it happens, not a booking deadline). Use null for both when the email has no single event date. Never guess a date.

optInGroup: a short phrase naming the group of children taking part, never a gender assumption about a particular child. Null for anything every child in the year group does.

yearGroups: For distribution logic only — use these exact values: "Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6", or "all" for whole school.

Many school emails combine a universal requirement (applies to every child, no exceptions — phrases like "all children", "all pupils", "whether they...", or a deadline/action that doesn't exclude any year group) with year-specific extras (like optional clubs only open to certain years). When this happens, yearGroups should be set to ["all"] — since the universal requirement means every family needs to see the message, even if some content like a specific club doesn't apply to them. Only use specific year groups (not "all") when the ENTIRE email is restricted to those years with no whole-school component at all.`;

type Extracted = SchoolEmailInfo & { yearGroups: string[] };
async function extractEmailInfo(subject: string, body: string): Promise<Extracted> {
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
  if (typeof parsed.eventDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.eventDate)) parsed.eventDate = null;
  if (!Array.isArray(parsed.yearGroups)) parsed.yearGroups = ["all"];
  for (const key of ["cost", "action", "when", "message", "eventTitle", "optInGroup"] as const) {
    if (parsed[key] !== null && (typeof parsed[key] !== "string" || parsed[key].trim() === "")) {
      parsed[key] = null;
    }
  }
  return parsed;
}

const sanitise = templateVar;

async function logSendFailure(to: string, sid: string, r: TemplateSend) {
  try {
    await supabase.from("message_send_failures").insert({
      function_name: "handle-school-email", phone_number: to, period: null, status_code: r.status, error_body: r.body.slice(0, 2000), context: `Template SID: ${sid}`,
    });
  } catch (logError) {
    console.error("Failed to log message send failure:", logError);
  }
}

/** Sends with monty_school_notification_v3 ({{1}} school name, {{2}} message); v2 only if v3 errors (logged). */
async function sendWhatsApp(to: string, text: string, schoolName: string, logId: string | null): Promise<boolean> {
  if (await blockIfTestPhone(to, "handle-school-email")) return false;
  const v3 = schoolEmailV3Vars(schoolName, text);
  const r3 = await sendTemplate(to, SCHOOL_NOTIFICATION_V3_SID, v3, "handle-school-email");
  console.log("Twilio status (v3):", r3.status, r3.body.slice(0, 300));
  if (r3.ok) {
    await recordOutbound({ phone: to, source: "school_email", contentSid: SCHOOL_NOTIFICATION_V3_SID, variables: v3, schoolEmailId: logId, meta: { twilio_sid: r3.sid } });
    return true;
  }
  await logSendFailure(to, SCHOOL_NOTIFICATION_V3_SID, r3);
  console.error(`[handle-school-email] v3 failed (${r3.status}), falling back to v2`);
  const v2 = { "1": sanitise(text) };
  const r2 = await sendTemplate(to, SCHOOL_NOTIFICATION_V2_SID, v2, "handle-school-email");
  console.log("Twilio status (v2 fallback):", r2.status, r2.body.slice(0, 300));
  if (!r2.ok) { await logSendFailure(to, SCHOOL_NOTIFICATION_V2_SID, r2); return false; }
  await recordOutbound({ phone: to, source: "school_email", contentSid: SCHOOL_NOTIFICATION_V2_SID, variables: v2, schoolEmailId: logId, meta: { twilio_sid: r2.sid, v3_fallback: true } });
  return true;
}

const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** Targets the school's families, logs the email in school_email_log, sends one message per family phone and records it
 *  in each recipient's conversation. stubPhones: test send — only those (test) numbers, never Twilio. */
async function processEmail(o: { subject: string; extracted: Extracted; schoolId: string; testMode?: boolean; catchUpPhone?: string | null; stubPhones?: Set<string> }) {
  const { extracted } = o;
  const yearGroups = Array.isArray(extracted.yearGroups) && extracted.yearGroups.length ? extracted.yearGroups : ["all"];
  const optIn = isOptInEmail(o.subject, extracted.what, extracted.eventTitle);
  const { data: children } = await supabase.from("children").select("parent_id, year_group, first_name").eq("school_id", o.schoolId);
  const { data: school } = await supabase.from("schools").select("name").eq("id", o.schoolId).maybeSingle();
  const schoolName = String(school?.name || "school");

  const isWholeSchool = yearGroups.some((y) => /^all$/i.test(y));
  const relevantChildren = (children ?? []).filter((c: any) => isWholeSchool || yearGroups.some((yg) => yg.toLowerCase() === (c.year_group || "").toLowerCase()));

  const { data: allProfiles } = await supabase.from("profiles").select("user_id, phone_number").not("phone_number", "is", null);
  const { data: linkedAccounts } = await supabase.from("linked_accounts").select("primary_user_id, linked_user_id").eq("status", "accepted");

  // ── Union-find family grouping (same approach as send-reminders) ──
  const familyOf = new Map<string, string>();
  const find = (u: string): string => {
    const p = familyOf.get(u);
    if (!p || p === u) return u;
    const root = find(p);
    familyOf.set(u, root);
    return root;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) familyOf.set(rb, ra); };
  for (const c of children ?? []) if (!familyOf.has(c.parent_id)) familyOf.set(c.parent_id, c.parent_id);
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

  // One message per family: "For Caspian: …" for targeted emails, "If Caspian's in …:" for opt-in ones.
  const kidsByFamily = new Map<string, string[]>();
  for (const c of relevantChildren as any[]) {
    const fam = find(c.parent_id);
    if (!kidsByFamily.has(fam)) kidsByFamily.set(fam, []);
    kidsByFamily.get(fam)!.push(c.first_name);
  }
  const sends: { phone: string; message: string; family: string }[] = [];
  const seenPhones = new Set<string>();
  for (const [fam, kids] of kidsByFamily) {
    const message = buildSchoolMessage(extracted, [...new Set(kids)].sort((a, b) => a.localeCompare(b)), optIn);
    for (const phone of phonesByFamily.get(fam) || []) {
      if (seenPhones.has(phone)) continue;
      if (o.stubPhones && !o.stubPhones.has(phone)) continue;
      if (!o.stubPhones && (await isTestPhone(phone))) continue; // test families never get real school emails
      if (o.testMode && phone !== TEST_PHONE_NUMBER) continue;
      if (o.catchUpPhone && phone !== o.catchUpPhone) continue;
      seenPhones.add(phone);
      sends.push({ phone, message, family: fam });
    }
  }

  const { data: log, error: logErr } = await supabase.from("school_email_log").insert({
    school_id: o.schoolId, subject: o.subject.slice(0, 500), extracted, message: buildSchoolMessage(extracted, [], false),
    year_groups: yearGroups, opt_in: optIn, event_title: extracted.eventTitle ?? null, event_date: extracted.eventDate ?? null,
    is_test: !!o.stubPhones || !!o.testMode || !!o.catchUpPhone,
  }).select("id").single();
  if (logErr) console.error("school_email_log insert failed:", logErr.message);
  const logId = log?.id ?? null;

  const sentFamilies = new Set<string>();
  let sentCount = 0;
  for (const { phone, message, family } of sends) {
    let ok: boolean;
    if (o.stubPhones) {
      ok = !!(await recordOutbound({ phone, source: "school_email", contentSid: SCHOOL_NOTIFICATION_V3_SID, variables: schoolEmailV3Vars(schoolName, message), schoolEmailId: logId, meta: { stub: true } }));
    } else ok = await sendWhatsApp(phone, message, schoolName, logId);
    if (ok) { sentCount++; sentFamilies.add(family); }
  }
  if (logId) await supabase.from("school_email_log").update({ families_count: sentFamilies.size, phones_count: sentCount }).eq("id", logId);
  console.log(`Sent to ${sentCount} parents for year groups: ${yearGroups.join(", ")} (opt-in: ${optIn})`);
  return { success: true, sent: sentCount, families: sentFamilies.size, log_id: logId, opt_in: optIn, school_name: schoolName, messages: o.stubPhones ? sends.map((x) => ({ phone: x.phone, message: x.message, variables: schoolEmailV3Vars(schoolName, x.message) })) : undefined };
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
      return new Response(JSON.stringify({ dry_run: true, extracted: ex, old: buildOldSchoolMessage(ex), new: buildSchoolMessage(ex, names, isOptInEmail(subject, ex.what, ex.eventTitle)) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // Test send: secret-gated, AI-free (extraction passed in), test numbers only, never Twilio.
    if (reqBody.test_send === true) {
      const ok = await validTestSecret(req.headers.get("x-monty-test-secret"));
      const phones: string[] = Array.isArray(reqBody.only_phones) ? reqBody.only_phones.map(String) : [];
      const allTest = phones.length > 0 && (await Promise.all(phones.map((p) => isTestPhone(p)))).every(Boolean);
      await auditTestEntry({ entry_point: "handle-school-email:test_send", phone_number: phones.join(",") || null, scenario: String(subject ?? "").slice(0, 120), allowed: ok && allTest, reason: !ok ? "bad_secret" : allTest ? "stub_send" : "not_test_numbers" });
      if (!ok || !allTest || typeof reqBody.school_id !== "string" || !reqBody.extracted) return jsonRes({ error: "forbidden" }, 403);
      return jsonRes(await processEmail({ subject: String(subject ?? ""), extracted: reqBody.extracted, schoolId: reqBody.school_id, stubPhones: new Set(phones) }));
    }
    const testMode = test === true;
    const catchUpPhone = typeof only_phone === "string" ? only_phone.trim() : null;
    if (testMode) console.log(`[handle-school-email] TEST MODE active — only ${TEST_PHONE_NUMBER} will receive messages`);
    if (catchUpPhone) console.log(`[handle-school-email] CATCH-UP MODE active — only ${catchUpPhone} will receive messages`);
    console.log(`Received email from ${from}, subject: ${subject}`);

    const extracted = await extractEmailInfo(subject, rawEmail);
    console.log("Extracted:", JSON.stringify(extracted));
    const out = await processEmail({ subject: String(subject ?? ""), extracted, schoolId: DEAN_VALLEY_SCHOOL_ID, testMode, catchUpPhone });
    return jsonRes({ ...out, extracted, test_mode: testMode });

  } catch (error) {
    console.error("handle-school-email error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
