import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_MORNING_TEMPLATE_SID =
  Deno.env.get("TWILIO_MORNING_TEMPLATE_SID") || "HXc35dd5379ce57d50be8a7aeff9693f5f";
const TWILIO_EVENING_TEMPLATE_SID =
  Deno.env.get("TWILIO_EVENING_TEMPLATE_SID") || "HX34dd3ddbd9353dc3eeb09bdce3f13d0a";
const TWILIO_SUNDAY_TEMPLATE_SID =
  Deno.env.get("TWILIO_SUNDAY_TEMPLATE_SID") || "HXf63d73d24635780bb42d76ba726d83b4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

interface ReminderItem {
  childName: string;
  title: string;
  emoji: string;
  type: "reminder" | "event" | "note";
  refId: string;
}

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

async function sendWhatsApp(
  to: string,
  text: string,
  period: "morning" | "evening" | "sunday"
): Promise<boolean> {
  const sid = TWILIO_ACCOUNT_SID;
  const token = TWILIO_AUTH_TOKEN;
  const from = TWILIO_WHATSAPP_NUMBER;

  let templateSid: string;
  let contentVariables: string;

  if (period === "sunday") {
    // sunday payload is JSON: { names, weekDates, body }
    const payload = JSON.parse(text) as { names: string; weekDates: string; body: string };
    templateSid = TWILIO_SUNDAY_TEMPLATE_SID;
    contentVariables = JSON.stringify({
      "1": payload.names.slice(0, 200),
      "2": payload.weekDates.slice(0, 100),
      "3": payload.body.slice(0, 1024),
    });
  } else {
    templateSid = period === "morning" ? TWILIO_MORNING_TEMPLATE_SID : TWILIO_EVENING_TEMPLATE_SID;
    const sanitisedText = text
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/[^\S\n\r]+/g, " ")
      .trim()
      .slice(0, 1024);
    contentVariables = JSON.stringify({ "1": sanitisedText });
  }

  if (!templateSid) {
    console.error(`No template SID for period=${period}`);
    return false;
  }

  console.log("Sending to:", to, "templateSid:", templateSid);
  console.log("ContentVariables:", contentVariables);

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${from}`);
  params.append("ContentSid", templateSid);
  params.append("ContentVariables", contentVariables);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  console.log("Twilio response status:", res.status);
  const responseBody = await res.text();
  console.log("Twilio response body:", responseBody);

  return res.ok;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

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

// ── Message builders ──────────────────────────────────────────────────────────

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
      return buildItemLine({ ...item, childName: joinNames(names) }, period);
    })
    .join("\n");
}

function buildItemLine(item: ReminderItem, period: "morning" | "evening"): string {
  const { childName, title, emoji, type } = item;
  const when = period === "evening" ? "tomorrow" : "today";
  const plural = isPluralSubject(childName);
  const hasHave = plural ? "have" : "has";
  const needsNeed = plural ? "need" : "needs";

  if (type === "event") return `${emoji} ${childName} ${hasHave} *${title}* ${when}`;

  const actionMap: Record<string, string> = {
    "PE kit needed": `Don't forget ${childName}'s PE kit ${when}`,
    "Packed lunch": `${childName} ${needsNeed} a packed lunch ${when}`,
    "Reading books returned": `${childName}'s reading book ${needsNeed} to go in their bag ${when}`,
    "Dinner money due": `Dinner money is due for ${childName} ${when}`,
    "Forest School": `${childName} ${hasHave} Forest School ${when} — they'll need their outdoor kit`,
    "Homework due": `${childName}'s homework is due ${when}`,
  };

  return actionMap[title] || `${emoji} ${childName} ${hasHave} *${title}* ${when}`;
}

// ── Sunday week-ahead builder ─────────────────────────────────────────────────

function getNextMonday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function formatWeekDates(monday: Date): string {
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return `${monday.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}–${friday.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}

function getDateForDay(monday: Date, dayOffset: number): string {
  const d = new Date(monday);
  d.setDate(monday.getDate() + dayOffset);
  return d.toISOString().split("T")[0];
}

async function sendSundayCheckins(): Promise<number> {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const nextMonday = getNextMonday();
  const weekStart = nextMonday.toISOString().split("T")[0];
  const weekDates = formatWeekDates(nextMonday);

  const friday = new Date(nextMonday);
  friday.setDate(nextMonday.getDate() + 4);
  const weekStartDate = `${weekStart}T00:00:00Z`;
  const weekEndDate = `${friday.toISOString().split("T")[0]}T23:59:59Z`;

  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, phone_number")
    .not("phone_number", "is", null);

  if (!profiles || profiles.length === 0) return 0;

  // Load linked accounts to group families
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
  for (const p of profiles) familyOf.set(p.user_id, p.user_id);
  for (const link of linkedAccounts || []) {
    if (!familyOf.has(link.primary_user_id)) familyOf.set(link.primary_user_id, link.primary_user_id);
    if (!familyOf.has(link.linked_user_id)) familyOf.set(link.linked_user_id, link.linked_user_id);
    union(link.primary_user_id, link.linked_user_id);
  }

  const phoneByUser = new Map(profiles.map((p) => [p.user_id, p.phone_number!]));

  // Group phones by family
  const phonesByFamily = new Map<string, Set<string>>();
  for (const p of profiles) {
    const fam = find(p.user_id);
    if (!phonesByFamily.has(fam)) phonesByFamily.set(fam, new Set());
    phonesByFamily.get(fam)!.add(p.phone_number!);
  }

  // Group children by family
  const { data: allChildren } = await supabase
    .from("children")
    .select("id, first_name, year_group, school_id, parent_id");

  const childrenByFamily = new Map<string, typeof allChildren>();
  for (const child of allChildren || []) {
    const fam = find(child.parent_id);
    if (!childrenByFamily.has(fam)) childrenByFamily.set(fam, []);
    childrenByFamily.get(fam)!.push(child);
  }

  let sentCount = 0;

  for (const [familyId, familyPhones] of phonesByFamily) {
    const phones = Array.from(familyPhones);
    const anchorPhone = phones[0];

    // Skip if already sent this week
    const { data: existing } = await supabase
      .from("lunch_checkin_log")
      .select("id")
      .eq("parent_id", familyId)
      .eq("week_start", weekStart)
      .maybeSingle();
    if (existing) continue;

    const children = childrenByFamily.get(familyId) || [];
    if (children.length === 0) continue;

    const schoolIds = [...new Set(children.map((c: any) => c.school_id).filter(Boolean))];

    // Build week-ahead summary grouped by day
    const remindersByDay: Record<string, string[]> = {};

    // Child recurring reminders
    const childIds = children.map((c: any) => c.id);
    const { data: childReminders } = await supabase
      .from("child_reminders")
      .select("child_id, title, emoji, day_of_week, children(first_name)")
      .in("child_id", childIds)
      .eq("active", true);

    for (const rem of childReminders || []) {
      const childName = (rem as any).children?.first_name || "Unknown";
      if (!remindersByDay[rem.day_of_week]) remindersByDay[rem.day_of_week] = [];
      remindersByDay[rem.day_of_week].push(`${rem.emoji} ${childName}'s ${rem.title}`);
    }

    // School events this week
    const { data: events } =
      schoolIds.length > 0
        ? await supabase
            .from("school_events")
            .select("title, start_at, year_group")
            .in("school_id", schoolIds)
            .gte("start_at", weekStartDate)
            .lte("start_at", weekEndDate)
            .order("start_at", { ascending: true })
        : { data: [] };

    for (const evt of events || []) {
      const evtDate = evt.start_at.split("T")[0];
      const dayIndex = DAYS.findIndex((_, i) => getDateForDay(nextMonday, i) === evtDate);
      if (dayIndex === -1) continue;
      const dayName = DAYS[dayIndex];
      const relevantChild = children.find((c: any) =>
        isEventRelevantToChild(evt.year_group || "all", c.year_group || "")
      );
      if (!relevantChild) continue;
      if (!remindersByDay[dayName]) remindersByDay[dayName] = [];
      remindersByDay[dayName].push(`📅 ${cleanEventTitle(evt.title)}`);
    }

    // Parent notes this week
    const { data: notes } = await supabase
      .from("parent_notes")
      .select("summary, extracted_dates, child_name")
      .in("phone_number", phones);

    for (const note of notes || []) {
      if (!note.extracted_dates) continue;
      const dates = note.extracted_dates as Array<{ date: string }>;
      for (let i = 0; i < 5; i++) {
        const dayDate = getDateForDay(nextMonday, i);
        if (!dates.some((d) => d.date === dayDate)) continue;
        const dayName = DAYS[i];
        if (!remindersByDay[dayName]) remindersByDay[dayName] = [];
        const prefix = note.child_name ? `${note.child_name}: ` : "";
        remindersByDay[dayName].push(`📝 ${prefix}${note.summary}`);
      }
    }

    // Build the {{3}} body
    const weeklyItems: string[] = [];
    for (let i = 0; i < 5; i++) {
      const dayName = DAYS[i];
      const lines = remindersByDay[dayName];
      if (lines && lines.length > 0) {
        weeklyItems.push(`*${dayName}*\n${lines.map((l) => `  ${l}`).join("\n")}`);
      }
    }

    const bodyText =
      weeklyItems.length > 0
        ? weeklyItems.join("\n\n")
        : "Nothing specific flagged — looks like a quiet week!";

    const childNames = joinNames(children.map((c: any) => c.first_name));

    const payload = JSON.stringify({
      names: childNames,
      weekDates,
      body: bodyText,
    });

    for (const phone of phones) {
      const ok = await sendWhatsApp(phone, payload, "sunday");
      if (ok) {
        await supabase.from("lunch_checkin_log").insert({
          parent_id: familyId,
          week_start: weekStart,
        });
        sentCount++;
        console.log(`[sunday] Sent to ${phone}`);
      }
    }
  }

  return sentCount;
}

// ── Main send logic ───────────────────────────────────────────────────────────

async function sendReminders(period: "morning" | "evening") {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  const targetDate = new Date(now);
  if (period === "evening") targetDate.setDate(targetDate.getDate() + 1);

  const targetDay = targetDate.toLocaleDateString("en-GB", { weekday: "long" });
  const targetDateStr = targetDate.toISOString().split("T")[0];
  const targetStart = `${targetDateStr}T00:00:00Z`;
  const targetEnd = `${targetDateStr}T23:59:59Z`;

  const { data: children } = await supabase
    .from("children")
    .select("id, first_name, school_id, parent_id, year_group");

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

    const anchorPhone = familyPhones[0];
    const reminderItems: ReminderItem[] = [];
    const refIdsToLog: Array<{ refId: string; title: string; type: string }> = [];

    for (const child of familyChildren) {
      const schoolIds = [child.school_id].filter(Boolean);

      const { data: events } = await supabase
        .from("school_events")
        .select("id, title, year_group")
        .eq("school_id", child.school_id)
        .gte("start_at", targetStart)
        .lte("start_at", targetEnd);

      const { data: exclusions } = await supabase
        .from("event_exclusions")
        .select("keyword")
        .eq("child_id", child.id);
      const exclusionKeywords = (exclusions || [])
        .map((e: any) => (e.keyword || "").toLowerCase())
        .filter(Boolean);

      const eventTitlesForChild: string[] = [];
      for (const evt of events || []) {
        if (!isEventRelevantToChild(evt.year_group || "all", child.year_group || "")) continue;
        const titleLower = (evt.title || "").toLowerCase();
        if (exclusionKeywords.some((kw) => titleLower.includes(kw))) continue;

        const refId = `event_${evt.id}_${child.id}_${period}`;
        if (await alreadySent(anchorPhone, refId, period, today)) continue;
        const cleanTitle = cleanEventTitle(evt.title);
        eventTitlesForChild.push(cleanTitle);
        reminderItems.push({ childName: child.first_name, title: cleanTitle, emoji: "📅", type: "event", refId });
        refIdsToLog.push({ refId, title: cleanTitle, type: "event" });
      }

      const hasSwimmingEvent = eventTitlesForChild.some((t) => t.toLowerCase().includes("swimming"));

      const { data: childReminders } = await supabase
        .from("child_reminders")
        .select("id, title, emoji, reminder_time")
        .eq("child_id", child.id)
        .eq("active", true)
        .eq("day_of_week", targetDay);

      for (const rem of childReminders || []) {
        const shouldSend = rem.reminder_time === "both" || rem.reminder_time === period;
        if (!shouldSend) continue;
        if (hasSwimmingEvent && rem.title.toLowerCase().includes("swimming")) continue;

        const refId = `childreminder_${rem.id}_${targetDateStr}_${period}`;
        if (await alreadySent(anchorPhone, refId, period, today)) continue;
        reminderItems.push({ childName: child.first_name, title: rem.title, emoji: rem.emoji || "✅", type: "reminder", refId });
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
          reminderItems.push({ childName: child.first_name, title: "Packed lunch", emoji: "🥪", type: "reminder", refId });
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
        .eq("day_of_week", targetDay);

      for (const rem of schoolReminders || []) {
        const refId = `reminder_${rem.id}_${child.id}_${targetDateStr}_${period}`;
        if (await alreadySent(anchorPhone, refId, period, today)) continue;
        reminderItems.push({ childName: child.first_name, title: rem.title, emoji: rem.emoji || "✅", type: "reminder", refId });
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

      const todayStr = now.toISOString().split("T")[0];
      const hasFutureOrTodayDate = dates.some((d) => d.date && d.date >= todayStr);
      if (!hasFutureOrTodayDate) continue;

      const refId = `note_${note.id}_${targetDateStr}_${period}`;
      if (await alreadySent(anchorPhone, refId, period, today)) continue;

      reminderItems.push({ childName: note.child_name || "the children", title: note.summary, emoji: "📝", type: "note", refId });
      refIdsToLog.push({ refId, title: note.summary, type: "note" });
    }

    if (reminderItems.length === 0) continue;

    const message = buildConsolidatedMessage(reminderItems, period);

    for (const phone of familyPhones) {
      const ok = await sendWhatsApp(phone, message, period);
      if (ok) {
        for (const { refId, title, type } of refIdsToLog) {
          await logReminder(phone, type, refId, title, period);
        }
        sentCount++;
        console.log(`[${period}] Sent to family phone ${phone} with ${reminderItems.length} items`);
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

    if (!period) {
      const hour = new Date().getUTCHours();
      period = hour < 12 ? "morning" : "evening";
    }

    // On Sunday evenings, run the packed lunch check-in instead of normal evening reminders
    const isEvening = period === "evening";
    const isSunday = new Date().getDay() === 0;

    if (isEvening && isSunday) {
      const sent = await sendSundayCheckins();
      return new Response(JSON.stringify({ success: true, period: "sunday", sent }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await sendReminders(period);

    return new Response(JSON.stringify({ success: true, period }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("send-reminders error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
