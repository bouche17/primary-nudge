import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_MORNING_TEMPLATE_SID =
  Deno.env.get("TWILIO_MORNING_TEMPLATE_SID") || "HXc35dd5379ce57d50be8a7aeff9693f5f";
const TWILIO_EVENING_TEMPLATE_SID =
  Deno.env.get("TWILIO_EVENING_TEMPLATE_SID") || "HX34dd3ddbd9353dc3eeb09bdce3f13d0a";

const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReminderItem {
  childName: string;
  title: string;
  emoji: string;
  type: "reminder" | "event" | "note" | "announcement";
  refId: string;
}

// ── Year group filter ─────────────────────────────────────────────────────────

function cleanEventTitle(title: string): string {
  if (!title) return title;
  const pattern =
    /^\s*(?:(?:y(?:ea)?r?s?)\s*[\d]+(?:\s*[,/&\-]\s*\d+)*|ks\s*[1-4]|eyfs|reception|nursery)\b[\s:.\-–—]*/i;
  let cleaned = title;
  for (let i = 0; i < 2; i++) {
    const next = cleaned.replace(pattern, "");
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : title.trim();
}

function isEventRelevantToChild(eventYearGroup: string, childYearGroup: string): boolean {
  if (!eventYearGroup || eventYearGroup === "all") return true;
  const eventGroups = eventYearGroup.split(",").map((g) => g.trim().toLowerCase());
  const childGroup = childYearGroup.trim().toLowerCase();
  return eventGroups.includes(childGroup);
}

// ── WhatsApp sender ───────────────────────────────────────────────────────────

async function sendWhatsApp(to: string, text: string, period: "morning" | "evening"): Promise<boolean> {
  const sid = TWILIO_ACCOUNT_SID;
  const token = TWILIO_AUTH_TOKEN;
  const from = TWILIO_WHATSAPP_NUMBER;

  const templateSid = period === "morning" ? TWILIO_MORNING_TEMPLATE_SID : TWILIO_EVENING_TEMPLATE_SID;

  if (!templateSid) {
    console.error(`No template SID configured for period=${period} — refusing to send freeform.`);
    return false;
  }

  console.log('Sending to:', to, 'templateSid:', templateSid);

  const sanitisedText = text
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\\/g, "")
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .trim()
    .slice(0, 1024);

  const contentVariables = JSON.stringify({ "1": sanitisedText });

  console.log("RAW sanitisedText:", JSON.stringify(sanitisedText));

  console.log("ContentVariables JSON valid:", (() => { try { JSON.parse(contentVariables); return true; } catch { return false; } })());
  console.log('ContentVariables string:', contentVariables);

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${from}`);
  params.append("ContentSid", templateSid);
  params.append("ContentVariables", contentVariables);
  params.append(
    "StatusCallback",
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=send-reminders`
  );

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  console.log('Twilio response status:', res.status);
  const responseBody = await res.text();
  console.log('Twilio response body:', responseBody);

  if (!res.ok) {
    try {
      await supabase.from("message_send_failures").insert({
        function_name: "send-reminders",
        phone_number: to,
        period,
        status_code: res.status,
        error_body: responseBody,
        context: `Template SID: ${templateSid}`,
      });
    } catch (logError) {
      console.error("Failed to log message send failure:", logError);
    }
  }

  return res.ok;
}

// ── Holiday check ─────────────────────────────────────────────────────────────

const holidayCache = new Map<string, boolean>();
async function isSchoolHoliday(schoolId: string | null, dateStr: string): Promise<boolean> {
  const key = `${schoolId ?? "null"}_${dateStr}`;
  if (holidayCache.has(key)) return holidayCache.get(key)!;
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
  holidayCache.set(key, result);
  return result;
}

// ── Dedup check ───────────────────────────────────────────────────────────────

async function alreadySent(phone: string, refId: string, period: string, today: string): Promise<boolean> {
  const { data } = await supabase
    .from("reminder_log")
    .select("id")
    .eq("phone_number", phone)
    .eq("reference_id", refId)
    .eq("period", period)
    .gte("sent_at", `${today}T00:00:00Z`)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function logReminder(phone: string, type: string, refId: string, title: string, period: string) {
  await supabase.from("reminder_log").insert({
    phone_number: phone,
    reminder_type: type,
    reference_id: refId,
    reference_title: title,
    period,
  });
}

// ── Message builder ───────────────────────────────────────────────────────────

function joinNames(names: string[]): string {
  const unique = Array.from(new Set(names));
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

function isPluralSubject(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (lower === "the children" || lower === "the kids") return true;
  return / and /.test(lower) || /,/.test(lower);
}

function buildConsolidatedMessage(items: ReminderItem[], period: "morning" | "evening"): string {
  const groups = new Map<string, { item: ReminderItem; names: string[] }>();
  const order: string[] = [];
  for (const item of items) {
    const key =
      item.type === "note"
        ? `note:${item.refId}`
        : `${item.type}:${item.emoji}:${item.title.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, { item, names: [item.childName] });
      order.push(key);
    } else {
      groups.get(key)!.names.push(item.childName);
    }
  }

  return order
    .map((key) => {
      const { item, names } = groups.get(key)!;
      const merged: ReminderItem = { ...item, childName: joinNames(names) };
      return buildItemLine(merged, period);
    })
    .join(" | ");
}

function buildItemLine(item: ReminderItem, period: "morning" | "evening"): string {
  const { childName, title, emoji, type } = item;
  const when = period === "evening" ? "tomorrow" : "today";
  const plural = isPluralSubject(childName);
  const hasHave = plural ? "have" : "has";
  const needsNeed = plural ? "need" : "needs";

  if (type === "announcement") {
    return `${emoji} ${title}`;
  }

  // Notes are already complete sentences (from parent_notes.summary) — never wrap them in the generic template
  if (type === "note") {
    const cleanSummary = title.replace(/\.+\s*$/, "");
    const mentionsChild =
      childName === "the children" ||
      new RegExp(`\\b${childName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cleanSummary);
    if (mentionsChild) {
      return `${emoji} ${cleanSummary} ${when}`;
    }
    return `${emoji} ${childName}: ${cleanSummary} ${when}`;
  }

  if (type === "event") {
    return `${emoji} ${childName} ${hasHave} *${title}* ${when}`;
  }

  const actionMap: Record<string, string> = {
    "PE kit needed": `Don't forget ${childName}'s PE kit ${when}`,
    "Packed lunch": `${childName} ${needsNeed} a packed lunch ${when}`,
    "Reading books returned": `${childName}'s reading book ${needsNeed} to go in their bag ${when}`,
    "Dinner money due": `Dinner money is due for ${childName} ${when}`,
    "Forest School": `${childName} ${hasHave} Forest School ${when} — they'll need their outdoor kit`,
    "Homework due": `${childName}'s homework is due ${when}`,
  };

  const action = actionMap[title] || `${emoji} ${childName} ${hasHave} *${title}* ${when}`;
  return action;
}

// ── Main send logic ───────────────────────────────────────────────────────────

// Slot-level claim: one message per phone per target date per period, even if
// the function is invoked twice (e.g. both BST/GMT cron slots or a manual run).
// Backed by a unique index on reminder_log(reference_id) WHERE reminder_type='slot'.
async function claimSlot(phone: string, targetDateStr: string, period: string): Promise<boolean> {
  const { error } = await supabase.from("reminder_log").insert({
    phone_number: phone,
    reminder_type: "slot",
    reference_id: `slot_${phone}_${targetDateStr}_${period}`,
    reference_title: `${period} slot ${targetDateStr}`,
    period,
  });
  if (error) {
    if ((error as any).code !== "23505") console.error("claimSlot failed:", error);
    return false;
  }
  return true;
}

async function releaseSlot(phone: string, targetDateStr: string, period: string) {
  await supabase
    .from("reminder_log")
    .delete()
    .eq("reminder_type", "slot")
    .eq("reference_id", `slot_${phone}_${targetDateStr}_${period}`);
}

async function sendReminders(period: "morning" | "evening", testMode: boolean = false) {
  const now = new Date();
  // All dates are UK-local (Europe/London) so they're correct in both BST and GMT.
  const today = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  const targetDate = new Date(today + "T12:00:00Z");
  if (period === "evening") targetDate.setUTCDate(targetDate.getUTCDate() + 1);

  const targetDay = targetDate.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  const targetDateStr = targetDate.toISOString().split("T")[0];

  const { data: children } = await supabase.from("children").select("id, first_name, school_id, parent_id");

  if (!children || children.length === 0) {
    console.log("No children registered yet");
    return;
  }

  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, phone_number")
    .not("phone_number", "is", null);

  if (!profiles || profiles.length === 0) {
    console.log("No parent phone numbers found");
    return;
  }

  const phoneByUser = new Map(profiles.map((p) => [p.user_id, p.phone_number!]));

  const { data: linkedAccounts } = await supabase
    .from("linked_accounts")
    .select("primary_user_id, linked_user_id")
    .eq("status", "accepted");

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
  for (const p of profiles) if (!familyOf.has(p.user_id)) familyOf.set(p.user_id, p.user_id);
  for (const link of linkedAccounts || []) {
    if (!familyOf.has(link.primary_user_id)) familyOf.set(link.primary_user_id, link.primary_user_id);
    if (!familyOf.has(link.linked_user_id)) familyOf.set(link.linked_user_id, link.linked_user_id);
    union(link.primary_user_id, link.linked_user_id);
  }

  const childrenByFamily = new Map<string, typeof children>();
  const phonesByFamily = new Map<string, Set<string>>();

  for (const child of children) {
    const fam = find(child.parent_id);
    if (!childrenByFamily.has(fam)) childrenByFamily.set(fam, []);
    childrenByFamily.get(fam)!.push(child);
  }

  const allUsers = new Set<string>([...familyOf.keys()]);
  for (const userId of allUsers) {
    const phone = phoneByUser.get(userId);
    if (!phone) continue;
    const fam = find(userId);
    if (!phonesByFamily.has(fam)) phonesByFamily.set(fam, new Set());
    phonesByFamily.get(fam)!.add(phone);
  }

  let sentCount = 0;

  for (const [familyId, familyChildren] of childrenByFamily) {
    const familyPhones = Array.from(phonesByFamily.get(familyId) || []);
    if (familyPhones.length === 0) continue;

    if (testMode && !familyPhones.includes(TEST_PHONE_NUMBER)) {
      console.log(`[${period}] Test mode: skipping family ${familyId} — test number not in family phones`);
      continue;
    }

    const anchorPhone = familyPhones[0];

    const reminderItems: ReminderItem[] = [];
    const refIdsToLog: Array<{ refId: string; title: string; type: string }> = [];

    for (const child of familyChildren) {
      const schoolIds = [child.school_id].filter(Boolean);

      const { data: childReminders } = await supabase
        .from("child_reminders")
        .select("id, title, emoji, reminder_time, recurrence_interval, anchor_date")
        .eq("child_id", child.id)
        .eq("active", true)
        .eq("day_of_week", targetDay);

      for (const rem of childReminders || []) {
        const shouldSend = rem.reminder_time === "both" || rem.reminder_time === period;
        if (!shouldSend) continue;

        // Fortnightly (or other interval) recurrence: only fire when the target
        // date aligns with anchor_date's cycle parity.
        const interval = rem.recurrence_interval ?? 1;
        if (interval > 1 && rem.anchor_date) {
          const anchorMs = new Date(rem.anchor_date + "T12:00:00Z").getTime();
          const targetMs = new Date(targetDateStr + "T12:00:00Z").getTime();
          const weeksDiff = Math.round((targetMs - anchorMs) / (7 * 24 * 60 * 60 * 1000));
          const parity = (((weeksDiff % interval) + interval) % interval);
          if (parity !== 0) continue;
        }

        // Holiday suppression (applies to all intervals). Skips this occurrence
        // only — the anchor-based cycle is unchanged.
        if (await isSchoolHoliday(child.school_id, targetDateStr)) {
          console.log(`[${period}] Skipping reminder ${rem.id} — ${targetDateStr} is a school holiday`);
          continue;
        }

        const refId = `childreminder_${rem.id}_${targetDateStr}_${period}`;
        if (await alreadySent(anchorPhone, refId, period, today)) continue;
        reminderItems.push({
          childName: child.first_name,
          title: rem.title,
          emoji: rem.emoji || "✅",
          type: "reminder",
          refId,
        });
        refIdsToLog.push({ refId, title: rem.title, type: "child_reminder" });
      }

      // Weekly packed lunch plan
      const targetDateObj = new Date(targetDateStr + "T12:00:00Z");
      const targetDayNum = targetDateObj.getUTCDay();
      const daysFromMonday = targetDayNum === 0 ? 6 : targetDayNum - 1;
      const mondayObj = new Date(targetDateObj);
      mondayObj.setUTCDate(targetDateObj.getUTCDate() - daysFromMonday);
      const weekStartStr = mondayObj.toISOString().split("T")[0];

      const { data: lunchPlan } = await supabase
        .from("weekly_lunch_plans")
        .select("packed_lunch_days")
        .eq("child_id", child.id)
        .eq("week_start", weekStartStr)
        .maybeSingle();

      if (lunchPlan && lunchPlan.packed_lunch_days?.includes(targetDay)) {
        const refId = `lunch_${child.id}_${targetDateStr}_${period}`;
        if (!(await alreadySent(anchorPhone, refId, period, today))) {
          reminderItems.push({
            childName: child.first_name,
            title: "Packed lunch",
            emoji: "🥪",
            type: "reminder",
            refId,
          });
          refIdsToLog.push({ refId, title: "Packed lunch", type: "lunch_plan" });
        }
      }

      const schoolIdFilter =
        schoolIds.length > 0 ? `school_id.in.(${schoolIds.join(",")}),school_id.is.null` : `school_id.is.null`;

      const { data: schoolReminders } = await supabase
        .from("school_reminders")
        .select("id, title, emoji")
        .eq("active", true)
        .or(schoolIdFilter)
        .or(`day_of_week.eq.${targetDay},due_date.eq.${targetDateStr}`);


      for (const rem of schoolReminders || []) {
        const refId = `reminder_${rem.id}_${child.id}_${targetDateStr}_${period}`;
        if (await alreadySent(anchorPhone, refId, period, today)) continue;
        reminderItems.push({
          childName: child.first_name,
          title: rem.title,
          emoji: rem.emoji || "✅",
          type: "announcement",
          refId,
        });
        refIdsToLog.push({ refId, title: rem.title, type: "weekly" });
      }
    }

    const { data: notes } = await supabase
      .from("parent_notes")
      .select("id, summary, extracted_dates, child_name")
      .in("phone_number", familyPhones);

    for (const note of notes || []) {
      if (!note.summary || !note.extracted_dates) continue;
      const dates = note.extracted_dates as Array<{ date: string }>;
      if (!dates.some((d) => d.date === targetDateStr)) continue;

      const todayStr = today;
      const hasFutureOrTodayDate = dates.some((d) => d.date && d.date >= todayStr);
      if (!hasFutureOrTodayDate) {
        console.log(`Skipping note ${note.id} — all extracted dates are in the past:`, dates);
        continue;
      }

      const refId = `note_${note.id}_${targetDateStr}_${period}`;
      if (await alreadySent(anchorPhone, refId, period, today)) continue;

      reminderItems.push({
        childName: note.child_name || "the children",
        title: note.summary,
        emoji: "📝",
        type: "note",
        refId,
      });
      refIdsToLog.push({ refId, title: note.summary, type: "note" });
    }

    if (reminderItems.length === 0) continue;

    const message = buildConsolidatedMessage(reminderItems, period);

    for (const phone of familyPhones) {
      if (testMode && phone !== TEST_PHONE_NUMBER) continue;
      if (!(await claimSlot(phone, targetDateStr, period))) {
        console.log(`[${period}] Skipping ${phone} — slot ${targetDateStr} already claimed`);
        continue;
      }
      const ok = await sendWhatsApp(phone, message, period);
      if (ok) {
        for (const { refId, title, type } of refIdsToLog) {
          await logReminder(phone, type, refId, title, period);
        }
        sentCount++;
        console.log(`[${period}] Sent to family phone ${phone} with ${reminderItems.length} items`);
      } else {
        await releaseSlot(phone, targetDateStr, period);
      }
    }
  }

  console.log(`[${period}] Sent ${sentCount} consolidated messages`);
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    let period = url.searchParams.get("period") as "evening" | "morning" | null;
    const testMode = url.searchParams.get("test") === "true";

    if (testMode) {
      console.log(`[send-reminders] TEST MODE active — only ${TEST_PHONE_NUMBER} will receive messages`);
    }

    if (!period) {
      const hour = new Date().getUTCHours();
      period = hour < 12 ? "morning" : "evening";
    }

    // --- Holiday pause guard --------------------------------------------------
    // Reminders are paused for the summer break and resume automatically on 2 Sep.
    const RESUME_DATE = "2026-09-02"; // first day back; reminders fire from this date onward
    // Today's date in UK local time as YYYY-MM-DD (en-CA gives ISO-style output,
    // timeZone keeps it correct through BST/GMT so it flips on the right morning)
    const todayUK = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/London",
    });
    if (todayUK < RESUME_DATE) {
      console.log(
        `Reminders paused for school holiday (today ${todayUK} < resume ${RESUME_DATE}) - skipping.`
      );
      return new Response(
        JSON.stringify({ skipped: true, reason: "holiday_pause", today: todayUK, resume: RESUME_DATE, test_mode: testMode }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // --------------------------------------------------------------------------

    await sendReminders(period, testMode);

    return new Response(JSON.stringify({ success: true, period, test_mode: testMode }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-reminders error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
