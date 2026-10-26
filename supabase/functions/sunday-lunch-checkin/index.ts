// sunday-lunch-checkin/index.ts
// Runs every Sunday evening (5pm UTC / 6pm BST)
// Sends the upcoming week's ahead summary + packed lunch check-in via the
// approved monty_sunday_evening Content Template (3 variables: names, week
// dates, weekly summary — lunch question/examples are fixed template text).
// Triggered by pg_cron: 0 17 * * 0
//
// Holiday rule: a family is skipped entirely (no message, no lunch_checkin_log
// row, so nothing blocks a later week) when EVERY day Monday–Friday of the
// target week is a school holiday (school_holidays, school-specific or
// nationwide) for EVERY school the family's children attend. Partial-holiday
// weeks still send, with the holiday days left out. Families at a school
// without that holiday are unaffected.
//
// Split into buildSundayMessages (read-only) and deliverSundayMessages
// (real / stub) so the build can be checked without sending. Test entry needs
// MONTY_TEST_SECRET (constant-time) and is audited in test_entry_audit.

import { auditTestEntry, blockIfTestPhone, isTestPhone, validTestSecret } from "../_shared/testGuard.ts";
import { recordOutbound } from "../_shared/outbound.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_SUNDAY_TEMPLATE_SID =
  Deno.env.get("TWILIO_SUNDAY_TEMPLATE_SID") || "HXf63d73d24635780bb42d76ba726d83b4";

const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-monty-test-secret",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Twilio Content Variables reject literal newlines (error 21656), so any line
// breaks coming from parent notes or reminder titles are collapsed to spaces.
// Also strips control chars / curly quotes / em-dashes that break JSON.
function sanitiseForTwilio(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\\/g, "")
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .trim()
    .slice(0, 1024);
}

// ── Holiday check (same as send-reminders: school-specific or nationwide) ────

function makeHolidayChecker() {
  const cache = new Map<string, boolean>(); // per run, so changed fixtures/data are never stale
  return async function isSchoolHoliday(schoolId: string | null, dateStr: string): Promise<boolean> {
    const key = `${schoolId ?? "null"}_${dateStr}`;
    if (cache.has(key)) return cache.get(key)!;
    const filter = schoolId ? `school_id.eq.${schoolId},school_id.is.null` : `school_id.is.null`;
    const { data, error } = await supabase
      .from("school_holidays")
      .select("id")
      .or(filter)
      .lte("start_date", dateStr)
      .gte("end_date", dateStr)
      .limit(1);
    if (error) console.error("school_holidays lookup failed:", error);
    const result = (data?.length ?? 0) > 0;
    cache.set(key, result);
    return result;
  };
}

function checkinVariables(names: string, weekDates: string, summary: string): Record<string, string> {
  return { "1": sanitiseForTwilio(names), "2": sanitiseForTwilio(weekDates), "3": sanitiseForTwilio(summary) };
}

async function sendWhatsApp(to: string, names: string, weekDates: string, summary: string, weekStart: string): Promise<{ ok: boolean; status_code: number; body: string }> {
  if (await blockIfTestPhone(to, "sunday-lunch-checkin")) return { ok: true, status_code: 0, body: "blocked: test number" };
  if (!TWILIO_SUNDAY_TEMPLATE_SID) {
    console.error("No TWILIO_SUNDAY_TEMPLATE_SID configured — refusing to send freeform.");
    return { ok: false, status_code: 0, body: "No TWILIO_SUNDAY_TEMPLATE_SID configured" };
  }

  const contentVariables = JSON.stringify(checkinVariables(names, weekDates, summary));

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", TWILIO_SUNDAY_TEMPLATE_SID);
  params.append("ContentVariables", contentVariables);
  params.append(
    "StatusCallback",
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=sunday-lunch-checkin`
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
  console.log("Twilio response status:", res.status, "body:", responseBody);
  if (!res.ok) {
    console.error("Twilio error:", responseBody);
    try {
      await supabase.from("message_send_failures").insert({
        function_name: "sunday-lunch-checkin",
        phone_number: to,
        period: null,
        status_code: res.status,
        error_body: responseBody,
        context: `Template SID: ${TWILIO_SUNDAY_TEMPLATE_SID}; summary: ${summary.slice(0, 80)}`,
      });
    } catch (logError) {
      console.error("Failed to log message send failure:", logError);
    }
  } else {
    await recordOutbound({ phone: to, source: "sunday_checkin", contentSid: TWILIO_SUNDAY_TEMPLATE_SID, variables: checkinVariables(names, weekDates, summary), meta: { week_start: weekStart } });
  }
  return { ok: res.ok, status_code: res.status, body: responseBody };
}

// ── Dates (UTC-noon reference so BST/GMT never shifts a day) ─────────────────

// Monday of the upcoming week (the Monday immediately after `now`'s UK date).
function getNextMonday(now: Date): Date {
  const ukDate = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const d = new Date(`${ukDate}T12:00:00Z`);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? 1 : 8 - day));
  return d;
}

function formatWeekDates(monday: Date): string {
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  const f = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(monday)}–${f(friday)}`;
}

function getDateForDay(monday: Date, dayOffset: number): string {
  const d = new Date(monday);
  d.setUTCDate(monday.getUTCDate() + dayOffset);
  return d.toISOString().split("T")[0];
}

// ── Build (read-only) ─────────────────────────────────────────────────────────

interface PlannedFamily {
  familyId: string;
  anchorUserId: string;
  phones: string[];
  names: string;
  summary: string;
}

interface BuildResult {
  weekStart: string;
  weekDates: string;
  planned: PlannedFamily[];
  skippedHoliday: { familyId: string; schoolIds: (string | null)[] }[];
  alreadySent: number;
}

async function buildSundayMessages(opts: {
  now: Date;
  includeTestFamilies: boolean;
  onlyPhones?: Set<string>;
  testMode?: boolean;
  ignoreSentLog?: boolean;
}): Promise<BuildResult> {
  const isSchoolHoliday = makeHolidayChecker();
  const targetMonday = getNextMonday(opts.now);
  const weekStart = getDateForDay(targetMonday, 0);
  const weekDates = formatWeekDates(targetMonday);
  const out: BuildResult = { weekStart, weekDates, planned: [], skippedHoliday: [], alreadySent: 0 };

  const { data: allChildren } = await supabase
    .from("children")
    .select("id, first_name, year_group, school_id, parent_id");
  if (!allChildren || allChildren.length === 0) return out;

  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, phone_number")
    .not("phone_number", "is", null);
  if (!profiles || profiles.length === 0) return out;

  const phoneByUser = new Map(profiles.map((p: any) => [p.user_id, p.phone_number as string]));

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
  for (const c of allChildren) if (!familyOf.has(c.parent_id)) familyOf.set(c.parent_id, c.parent_id);
  for (const p of profiles) if (!familyOf.has(p.user_id)) familyOf.set(p.user_id, p.user_id);
  for (const link of linkedAccounts || []) {
    if (!familyOf.has(link.primary_user_id)) familyOf.set(link.primary_user_id, link.primary_user_id);
    if (!familyOf.has(link.linked_user_id)) familyOf.set(link.linked_user_id, link.linked_user_id);
    union(link.primary_user_id, link.linked_user_id);
  }

  const childrenByFamily = new Map<string, typeof allChildren>();
  for (const child of allChildren) {
    const fam = find(child.parent_id);
    if (!childrenByFamily.has(fam)) childrenByFamily.set(fam, []);
    childrenByFamily.get(fam)!.push(child);
  }

  const phonesByFamily = new Map<string, Set<string>>();
  const membersByFamily = new Map<string, string[]>();
  for (const userId of new Set<string>([...familyOf.keys()])) {
    const fam = find(userId);
    if (!membersByFamily.has(fam)) membersByFamily.set(fam, []);
    membersByFamily.get(fam)!.push(userId);
    const phone = phoneByUser.get(userId);
    if (!phone) continue;
    if (!phonesByFamily.has(fam)) phonesByFamily.set(fam, new Set());
    phonesByFamily.get(fam)!.add(phone);
  }

  for (const [familyId, children] of childrenByFamily) {
    const familyPhones = Array.from(phonesByFamily.get(familyId) || []);
    if (familyPhones.length === 0) continue;
    const anyTest = (await Promise.all(familyPhones.map((p) => isTestPhone(p)))).some(Boolean);
    if (!opts.includeTestFamilies && anyTest) continue; // test families never in real runs
    if (opts.onlyPhones && !familyPhones.some((p) => opts.onlyPhones!.has(p))) continue;
    if (opts.testMode && !familyPhones.includes(TEST_PHONE_NUMBER)) continue;

    // ── Whole-week holiday: every Mon–Fri is a holiday for every school → skip ──
    const familySchoolIds = Array.from(new Set(children.map((c: any) => (c.school_id ?? null) as string | null)));
    let wholeWeekHoliday = true;
    for (const sid of familySchoolIds) {
      for (let i = 0; i < 5 && wholeWeekHoliday; i++) {
        if (!(await isSchoolHoliday(sid, getDateForDay(targetMonday, i)))) wholeWeekHoliday = false;
      }
      if (!wholeWeekHoliday) break;
    }
    if (wholeWeekHoliday) {
      out.skippedHoliday.push({ familyId, schoolIds: familySchoolIds });
      continue; // no message, no lunch_checkin_log row
    }

    const familyMembers = membersByFamily.get(familyId) || [familyId];

    if (!opts.ignoreSentLog) {
      const { data: existing } = await supabase
        .from("lunch_checkin_log")
        .select("id")
        .in("parent_id", familyMembers)
        .eq("week_start", weekStart)
        .limit(1);
      if (existing && existing.length > 0) {
        out.alreadySent++;
        continue;
      }
    }

    const childIds = children.map((c: any) => c.id);
    const weeklyItems: string[] = [];
    const childSchoolById = new Map<string, string | null>(
      children.map((c: any) => [c.id, c.school_id ?? null])
    );

    const { data: childReminders } = await supabase
      .from("child_reminders")
      .select("child_id, title, emoji, day_of_week, recurrence_interval, anchor_date, children(first_name)")
      .in("child_id", childIds)
      .eq("active", true);

    const remindersByDay: Record<string, string[]> = {};
    for (const rem of childReminders || []) {
      const dayIndex = DAYS.indexOf(rem.day_of_week);
      if (dayIndex === -1) continue;
      const dayDate = getDateForDay(targetMonday, dayIndex);

      // Fortnightly (or other interval) recurrence: only preview when the
      // date aligns with anchor_date's cycle parity (same as send-reminders).
      const interval = rem.recurrence_interval ?? 1;
      if (interval > 1 && rem.anchor_date) {
        const anchorMs = new Date(rem.anchor_date + "T12:00:00Z").getTime();
        const targetMs = new Date(dayDate + "T12:00:00Z").getTime();
        const weeksDiff = Math.round((targetMs - anchorMs) / (7 * 24 * 60 * 60 * 1000));
        const parity = (((weeksDiff % interval) + interval) % interval);
        if (parity !== 0) continue;
      }

      // Holiday suppression — same check as send-reminders.
      if (await isSchoolHoliday(childSchoolById.get(rem.child_id) ?? null, dayDate)) continue;

      const childName = (rem as any).children?.first_name || "Unknown";
      const line = `${rem.emoji} ${childName}'s ${rem.title}`;
      if (!remindersByDay[rem.day_of_week]) remindersByDay[rem.day_of_week] = [];
      remindersByDay[rem.day_of_week].push(line);
    }

    const { data: notes } = await supabase
      .from("parent_notes")
      .select("summary, extracted_dates, child_name")
      .in("phone_number", familyPhones);

    for (let i = 0; i < 5; i++) {
      const dayName = DAYS[i];
      const dayDate = getDateForDay(targetMonday, i);
      const dayLines: string[] = [];

      // If the whole day is a holiday for the family's school(s), omit the
      // day from the preview entirely.
      if (familySchoolIds.length > 0) {
        let allHoliday = true;
        for (const sid of familySchoolIds) {
          if (!(await isSchoolHoliday(sid, dayDate))) {
            allHoliday = false;
            break;
          }
        }
        if (allHoliday) continue;
      }

      if (remindersByDay[dayName]) {
        dayLines.push(...remindersByDay[dayName]);
      }

      const seen = new Set<string>();
      for (const note of notes || []) {
        if (!note.extracted_dates) continue;
        const dates = note.extracted_dates as Array<{ date: string }>;
        if (!dates.some((d) => d.date === dayDate)) continue;
        const prefix = note.child_name ? `${note.child_name}: ` : "";
        const line = `📝 ${prefix}${note.summary}`;
        if (seen.has(line)) continue;
        seen.add(line);
        dayLines.push(line);
      }

      if (dayLines.length > 0) {
        weeklyItems.push(`*${dayName}:* ${dayLines.join(", ")}`);
      }
    }

    const childNames = Array.from(new Set(children.map((c: any) => c.first_name)));
    const names =
      childNames.length === 1
        ? childNames[0]
        : childNames.length === 2
          ? `${childNames[0]} and ${childNames[1]}`
          : childNames.join(", ");

    let summary =
      weeklyItems.length > 0 ? weeklyItems.join(" | ") : "Nothing specific flagged — looks like a quiet week!";

    // Append what's already saved in weekly_lunch_plans for this week, so
    // parents know they only need to reply if plans have changed.
    if (childIds.length > 0) {
      const { data: existingPlans } = await supabase
        .from("weekly_lunch_plans")
        .select("child_id, packed_lunch_days")
        .in("child_id", childIds)
        .eq("week_start", weekStart);

      const planByChild = new Map<string, string[]>();
      for (const plan of existingPlans || []) {
        planByChild.set((plan as any).child_id, (plan as any).packed_lunch_days || []);
      }

      if (planByChild.size > 0) {
        const SHORT_DAYS: Record<string, string> = {
          Monday: "Mon",
          Tuesday: "Tue",
          Wednesday: "Wed",
          Thursday: "Thu",
          Friday: "Fri",
        };
        const planParts: string[] = [];
        const stillNeed: string[] = [];
        for (const child of children) {
          const days = planByChild.get(child.id);
          if (!days) {
            stillNeed.push(child.first_name);
            continue;
          }
          // Drop packed-lunch days that fall on a school holiday (incl. INSET).
          const schoolDays: string[] = [];
          for (const d of days) {
            const idx = DAYS.indexOf(d);
            if (idx === -1) continue;
            if (await isSchoolHoliday(child.school_id ?? null, getDateForDay(targetMonday, idx))) continue;
            schoolDays.push(d);
          }
          const shortDays = DAYS.map((d) => SHORT_DAYS[d]).filter((short) =>
            schoolDays.some((d: string) => SHORT_DAYS[d] === short)
          );
          planParts.push(
            shortDays.length > 0
              ? `${child.first_name} - packed lunch ${shortDays.join(", ")}`
              : `${child.first_name} - school dinners all week`
          );
        }
        if (planParts.length > 0) {
          let savedLine = `✅ Already saved: ${planParts.join("; ")}.`;
          savedLine += stillNeed.length > 0
            ? ` Still need: ${stillNeed.join(", ")}.`
            : " Only reply if anything's changed.";
          summary += ` | ${savedLine}`;
        }
      }
    }

    out.planned.push({ familyId, anchorUserId: familyId, phones: familyPhones, names, summary });
  }

  if (out.skippedHoliday.length > 0) {
    console.log(`[sunday-lunch-checkin] week ${weekStart}: skipped ${out.skippedHoliday.length} families — whole week is a school holiday`);
  }
  return out;
}

// ── Deliver ───────────────────────────────────────────────────────────────────
// "real" sends via Twilio. "stub" never calls Twilio: only allowlisted test
// phones count as delivered, and the log row is written for test families only.

async function deliverSundayMessages(planned: PlannedFamily[], weekStart: string, weekDates: string, mode: "real" | "stub") {
  let sentCount = 0;
  const delivered: { phone: string; names: string; summary: string }[] = [];
  const failures: { phone_number: string; status_code: number; body: string }[] = [];
  for (const fam of planned) {
    let anySent = false;
    for (const phone_number of fam.phones) {
      if (mode === "stub") {
        if (!(await isTestPhone(phone_number))) continue;
        await recordOutbound({ phone: phone_number, source: "sunday_checkin", contentSid: TWILIO_SUNDAY_TEMPLATE_SID, variables: checkinVariables(fam.names, weekDates, fam.summary), meta: { week_start: weekStart, stub: true } });
        anySent = true;
        sentCount++;
        delivered.push({ phone: phone_number, names: fam.names, summary: fam.summary });
        continue;
      }
      const result = await sendWhatsApp(phone_number, fam.names, weekDates, fam.summary, weekStart);
      if (result.ok) {
        anySent = true;
        sentCount++;
        console.log(`Sent Sunday summary to ${phone_number} for week ${weekStart}`);
      } else {
        failures.push({ phone_number, status_code: result.status_code, body: result.body });
      }
    }
    if (anySent) {
      await supabase.from("lunch_checkin_log").insert({ parent_id: fam.anchorUserId, week_start: weekStart });
    }
  }
  return { sentCount, delivered, failures };
}

// ── Test entry point ──────────────────────────────────────────────────────────
// scope "test": only allowlisted phones; optional stub_send (never Twilio).
// scope "real_readonly": builds real families' messages; no writes, no sends, phones masked.
async function handleTestEntry(req: Request, secret: string | null): Promise<Response> {
  const jsonRes = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const scenario = typeof body.scenario === "string" ? body.scenario.slice(0, 200) : null;
  const phones: string[] = Array.isArray(body.only_phones) ? body.only_phones.map(String) : [];

  if (!(await validTestSecret(secret))) {
    await auditTestEntry({ entry_point: "sunday-lunch-checkin", phone_number: phones.join(",") || null, scenario, allowed: false, reason: "bad_secret" });
    return jsonRes({ error: "Unauthorized" }, 401);
  }
  const now = body.now ? new Date(body.now) : new Date();
  if (isNaN(now.getTime())) return jsonRes({ error: "invalid now" }, 400);
  const scope = body.scope === "real_readonly" ? "real_readonly" : "test";
  const stubSend = body.stub_send === true;

  if (scope === "real_readonly") {
    if (stubSend) {
      await auditTestEntry({ entry_point: "sunday-lunch-checkin", scenario, allowed: false, reason: "real_readonly_cannot_write" });
      return jsonRes({ error: "real_readonly is build-only" }, 403);
    }
    await auditTestEntry({ entry_point: "sunday-lunch-checkin:real_readonly", scenario, allowed: true, reason: `${now.toISOString()} ignore_log=${body.ignore_sent_log === true}` });
    const built = await buildSundayMessages({ now, includeTestFamilies: false, ignoreSentLog: body.ignore_sent_log === true });
    return jsonRes({
      scope, now: now.toISOString(), week_start: built.weekStart, week_dates: built.weekDates,
      would_send_families: built.planned.length, skipped_holiday_families: built.skippedHoliday.length, already_sent_families: built.alreadySent,
      skipped: built.skippedHoliday.map((s) => ({ family: s.familyId.slice(0, 8), schools: s.schoolIds })),
      messages: built.planned.map((p) => ({ family: p.familyId.slice(0, 8), phones_last4: p.phones.map((x) => x.slice(-4)), names: p.names, week_dates: built.weekDates, summary: p.summary })),
    });
  }

  if (phones.length === 0) return jsonRes({ error: "only_phones required" }, 400);
  for (const ph of phones) {
    if (!(await isTestPhone(ph))) {
      await auditTestEntry({ entry_point: "sunday-lunch-checkin", phone_number: ph, scenario, allowed: false, reason: "not_on_allowlist" });
      return jsonRes({ error: `Refused: ${ph.slice(-4)} is not a test number` }, 403);
    }
  }
  await auditTestEntry({ entry_point: "sunday-lunch-checkin", phone_number: phones.join(","), scenario, allowed: true, reason: `${now.toISOString()} stub_send=${stubSend}` });
  const built = await buildSundayMessages({ now, includeTestFamilies: true, onlyPhones: new Set(phones) });
  const base = { scope, week_start: built.weekStart, week_dates: built.weekDates, skipped_holiday: built.skippedHoliday.length, already_sent: built.alreadySent };
  if (!stubSend) return jsonRes({ ...base, messages: built.planned.map((p) => ({ phones: p.phones, names: p.names, summary: p.summary })) });
  // Belt and braces: only families whose every phone is an allowlisted test number.
  const safe = built.planned.filter((p) => p.phones.every((x) => phones.includes(x)));
  const { delivered } = await deliverSundayMessages(safe, built.weekStart, built.weekDates, "stub");
  return jsonRes({ ...base, stub_send: true, delivered });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    const testSecretHeader = req.headers.get("x-monty-test-secret");
    if (testSecretHeader !== null || url.searchParams.get("dry_run") !== null) {
      return await handleTestEntry(req, testSecretHeader);
    }

    const testMode = url.searchParams.get("test") === "true";
    if (testMode) {
      console.log(`[sunday-lunch-checkin] TEST MODE active — only ${TEST_PHONE_NUMBER} will receive messages`);
    }

    const built = await buildSundayMessages({ now: new Date(), includeTestFamilies: false, testMode });
    const { sentCount, failures } = await deliverSundayMessages(built.planned, built.weekStart, built.weekDates, "real");

    return new Response(JSON.stringify({
      success: true, sent: sentCount, week_start: built.weekStart, skipped_holiday: built.skippedHoliday.length, failures, test_mode: testMode,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("sunday-lunch-checkin error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
