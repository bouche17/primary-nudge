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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReminderItem {
  childName: string;
  title: string;
  emoji: string;
  type: "reminder" | "event" | "note";
  refId: string;
}

// ── Year group filter ─────────────────────────────────────────────────────────
// Checks if a school event is relevant to a specific child based on the
// event's year_group field (set during calendar sync).
// year_group is "all" for whole-school events, or a comma-separated list
// like "Year 3,Year 4" or "Reception".

// Strip year group / key stage prefixes from event titles
// Examples: "Y3,4,5 Swimming" → "Swimming", "Y5/6 Football" → "Football",
// "KS1 Nativity" → "Nativity", "Year 3 Trip" → "Trip", "Reception Assembly" → "Assembly"
function cleanEventTitle(title: string): string {
  if (!title) return title;
  // Matches leading year/keystage tokens followed by separator(s)
  // Y/Yr/Year + numbers (with , / & - and spaces), or KS1/KS2/EYFS/Reception/Nursery
  const pattern =
    /^\s*(?:(?:y(?:ea)?r?s?)\s*[\d]+(?:\s*[,/&\-]\s*\d+)*|ks\s*[1-4]|eyfs|reception|nursery)\b[\s:.\-–—]*/i;
  let cleaned = title;
  // Strip up to 2 prefixes (e.g. "KS2 Y5/6 Trip")
  for (let i = 0; i < 2; i++) {
    const next = cleaned.replace(pattern, "");
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : title.trim();
}

function isEventRelevantToChild(eventYearGroup: string, childYearGroup: string): boolean {
  // "all" means whole school — always relevant
  if (!eventYearGroup || eventYearGroup === "all") return true;

  // Split the event's year groups and check for a match
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

  const templateSid = period === "morning" ? TWILIO_MORNING_TEMPLATE_SID : TWILIO_EVENING_TEMPLATE_SID;

  if (!templateSid) {
    console.error(`No template SID configured for period=${period} — refusing to send freeform.`);
    return false;
  }

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${from}`);
  params.append("ContentSid", templateSid);
  params.append("ContentVariables", JSON.stringify({ "1": text }));

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    console.error(`Twilio error [${res.status}]:`, await res.text());
  } else {
    const body = await res.json();
    console.log(`Twilio OK sid=${body.sid} status=${body.status} to=${to} template=${templateSid}`);
  }
  return res.ok;
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
// Builds ONE consolidated message per parent per period
// rather than firing a separate message for each reminder

function buildConsolidatedMessage(items: ReminderItem[], period: "morning" | "evening"): string {
  const greeting = period === "morning" ? "Good morning! ☀️" : "Good evening! 🌙";

  // Single item — keep it short and personal
  if (items.length === 1) {
    const item = items[0];
    if (period === "morning") {
      return buildSingleMorning(item);
    } else {
      return buildSingleEvening(item);
    }
  }

  // Multiple items — consolidated list
  const lines = items.map((item) => buildItemLine(item, period));

  if (period === "morning") {
    const intro =
      items.length === 2 ? `${greeting} A couple of things for today:` : `${greeting} Here's what's on today:`;
    return `${intro}\n\n${lines.join("\n")}\n\nHave a great day! 😊`;
  } else {
    const intro =
      items.length === 2
        ? `${greeting} Just a couple of things to prep for tomorrow:`
        : `${greeting} A few things to get ready for tomorrow:`;
    return `${intro}\n\n${lines.join("\n")}\n\nHope you have a lovely evening! 😊`;
  }
}

function buildItemLine(item: ReminderItem, period: "morning" | "evening"): string {
  const { childName, title, emoji, type } = item;

  if (type === "event") {
    if (period === "evening") {
      return `${emoji} ${childName} has *${title}* tomorrow — worth getting ready tonight`;
    }
    return `${emoji} ${childName} has *${title}* today`;
  }

  // Reminder — make it action-focused and natural
  const actionMap: Record<string, string> = {
    "PE kit needed": `Don't forget ${childName}'s PE kit`,
    "Packed lunch": `${childName} needs a packed lunch`,
    "Reading books returned": `${childName}'s reading book needs to go in their bag`,
    "Dinner money due": `Dinner money is due for ${childName}`,
    "Forest School": `${childName} has Forest School — they'll need their outdoor kit`,
    "Homework due": `${childName}'s homework is due today`,
  };

  // Use mapped version if available, otherwise build naturally
  const action = actionMap[title] || `${childName} has ${title}`;
  return `${emoji} ${action}`;
}

function buildSingleMorning(item: ReminderItem): string {
  const { childName, title, emoji, type } = item;

  if (type === "event") {
    return `Morning! ${emoji} Just a heads up — ${childName} has *${title}* today. Have a great one! 😊`;
  }

  const actionMap: Record<string, string> = {
    "PE kit needed": `Morning! ${emoji} Quick one — don't forget ${childName}'s PE kit today. You've got this! 💪`,
    "Packed lunch": `Morning! ${emoji} Don't forget ${childName}'s packed lunch today!`,
    "Reading books returned": `Morning! ${emoji} ${childName}'s reading book needs to go back to school today 📚`,
    "Dinner money due": `Morning! ${emoji} Dinner money is due for ${childName} today. Worth sorting before the school run!`,
    "Forest School": `Morning! ${emoji} It's Forest School for ${childName} today — make sure they've got their outdoor kit! 🌲`,
    "Homework due": `Morning! ${emoji} ${childName}'s homework is due in today — hope it's all done! ✏️`,
  };

  return (
    actionMap[title] || `Morning! ${emoji} Quick reminder — ${childName} has *${title}* today. Have a great day! 😊`
  );
}

function buildSingleEvening(item: ReminderItem): string {
  const { childName, title, emoji, type } = item;

  if (type === "event") {
    return `Hey! ${emoji} Just a heads up for tomorrow — ${childName} has *${title}*. Worth getting sorted tonight! 😊`;
  }

  const actionMap: Record<string, string> = {
    "PE kit needed": `Hey! ${emoji} Don't forget — ${childName} needs their PE kit tomorrow. Best to pack it tonight! 👟`,
    "Packed lunch": `Hey! ${emoji} ${childName} needs a packed lunch tomorrow — worth getting it ready tonight 🥪`,
    "Reading books returned": `Hey! ${emoji} ${childName}'s reading book needs to go back tomorrow — worth popping it in their bag tonight 📚`,
    "Dinner money due": `Hey! ${emoji} Dinner money is due for ${childName} tomorrow. Worth sorting it tonight! 💰`,
    "Forest School": `Hey! ${emoji} ${childName} has Forest School tomorrow — make sure their outdoor kit is ready tonight 🌲`,
    "Homework due": `Hey! ${emoji} ${childName}'s homework is due tomorrow — just checking it's all done! ✏️`,
  };

  return (
    actionMap[title] ||
    `Hey! ${emoji} Just a reminder — ${childName} has *${title}* tomorrow. Worth getting ready tonight! 😊`
  );
}

// ── Main send logic ───────────────────────────────────────────────────────────

async function sendReminders(period: "morning" | "evening") {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // For evening, look at tomorrow; for morning, look at today
  const targetDate = new Date(now);
  if (period === "evening") targetDate.setDate(targetDate.getDate() + 1);

  const targetDay = targetDate.toLocaleDateString("en-GB", { weekday: "long" });
  const targetDateStr = targetDate.toISOString().split("T")[0];
  const targetStart = `${targetDateStr}T00:00:00Z`;
  const targetEnd = `${targetDateStr}T23:59:59Z`;

  // Load all children including year_group for event filtering
  const { data: children } = await supabase.from("children").select("id, first_name, school_id, parent_id, year_group");

  if (!children || children.length === 0) {
    console.log("No children registered yet");
    return;
  }

  // Load all parent phone numbers (we'll need linked partners too)
  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, phone_number")
    .not("phone_number", "is", null);

  if (!profiles || profiles.length === 0) {
    console.log("No parent phone numbers found");
    return;
  }

  const phoneByUser = new Map(profiles.map((p) => [p.user_id, p.phone_number!]));

  // Load all accepted linked accounts and build a union-find of family groups
  const { data: linkedAccounts } = await supabase
    .from("linked_accounts")
    .select("primary_user_id, linked_user_id")
    .eq("status", "accepted");

  // familyOf[user_id] = canonical family-leader user_id
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
  // Seed every known parent
  for (const c of children) if (!familyOf.has(c.parent_id)) familyOf.set(c.parent_id, c.parent_id);
  for (const p of profiles) if (!familyOf.has(p.user_id)) familyOf.set(p.user_id, p.user_id);
  for (const link of linkedAccounts || []) {
    if (!familyOf.has(link.primary_user_id)) familyOf.set(link.primary_user_id, link.primary_user_id);
    if (!familyOf.has(link.linked_user_id)) familyOf.set(link.linked_user_id, link.linked_user_id);
    union(link.primary_user_id, link.linked_user_id);
  }

  // Group children + phones by family
  const childrenByFamily = new Map<string, typeof children>();
  const phonesByFamily = new Map<string, Set<string>>();

  for (const child of children) {
    const fam = find(child.parent_id);
    if (!childrenByFamily.has(fam)) childrenByFamily.set(fam, []);
    childrenByFamily.get(fam)!.push(child);
  }

  // Walk every user we've seen and bucket their phone into their family
  const allUsers = new Set<string>([...familyOf.keys()]);
  for (const userId of allUsers) {
    const phone = phoneByUser.get(userId);
    if (!phone) continue;
    const fam = find(userId);
    if (!phonesByFamily.has(fam)) phonesByFamily.set(fam, new Set());
    phonesByFamily.get(fam)!.add(phone);
  }

  let sentCount = 0;

  // Process each FAMILY — one message per family, sent to every family phone
  for (const [familyId, familyChildren] of childrenByFamily) {
    const familyPhones = Array.from(phonesByFamily.get(familyId) || []);
    if (familyPhones.length === 0) continue;

    // Use first family phone as the dedup anchor (so retries don't re-send to anyone)
    const anchorPhone = familyPhones[0];

    const reminderItems: ReminderItem[] = [];
    const refIdsToLog: Array<{ refId: string; title: string; type: string }> = [];

    for (const child of familyChildren) {
      const schoolIds = [child.school_id].filter(Boolean);

      // 1. School events for target date
      const { data: events } = await supabase
        .from("school_events")
        .select("id, title, year_group")
        .eq("school_id", child.school_id)
        .gte("start_at", targetStart)
        .lte("start_at", targetEnd);

      for (const evt of events || []) {
        if (!isEventRelevantToChild(evt.year_group || "all", child.year_group || "")) continue;

        const refId = `event_${evt.id}_${child.id}_${period}`;
        if (await alreadySent(anchorPhone, refId, period, today)) continue;
        const cleanTitle = cleanEventTitle(evt.title);
        reminderItems.push({
          childName: child.first_name,
          title: cleanTitle,
          emoji: "📅",
          type: "event",
          refId,
        });
        refIdsToLog.push({ refId, title: cleanTitle, type: "event" });
      }

      // 2. Child-specific reminders (any family parent's reminders for this child)
      const { data: childReminders } = await supabase
        .from("child_reminders")
        .select("id, title, emoji, reminder_time")
        .eq("child_id", child.id)
        .eq("active", true)
        .eq("day_of_week", targetDay);

      for (const rem of childReminders || []) {
        const shouldSend = rem.reminder_time === "both" || rem.reminder_time === period;
        if (!shouldSend) continue;

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

      // 2b. Weekly packed lunch plan
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

      // 3. School-wide recurring reminders
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
        reminderItems.push({
          childName: child.first_name,
          title: rem.title,
          emoji: rem.emoji || "✅",
          type: "reminder",
          refId,
        });
        refIdsToLog.push({ refId, title: rem.title, type: "weekly" });
      }
    }

    // 4. Parent notes — fetch ALL notes from ANY family phone, once per family
    const { data: notes } = await supabase
      .from("parent_notes")
      .select("id, summary, extracted_dates, child_name")
      .in("phone_number", familyPhones);

    for (const note of notes || []) {
      if (!note.summary || !note.extracted_dates) continue;
      const dates = note.extracted_dates as Array<{ date: string }>;
      if (!dates.some((d) => d.date === targetDateStr)) continue;

      const refId = `note_${note.id}_${targetDateStr}_${period}`;
      if (await alreadySent(anchorPhone, refId, period, today)) continue;

      const noteName = note.child_name || "the children";
      reminderItems.push({
        childName: noteName,
        title: note.summary,
        emoji: "📝",
        type: "note",
        refId,
      });
      refIdsToLog.push({ refId, title: note.summary, type: "note" });
    }

    // Skip if nothing to send
    if (reminderItems.length === 0) continue;

    // Build ONE consolidated message and send to every family phone
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
