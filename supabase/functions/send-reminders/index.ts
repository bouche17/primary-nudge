import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;

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

function isEventRelevantToChild(eventYearGroup: string, childYearGroup: string): boolean {
  // "all" means whole school — always relevant
  if (!eventYearGroup || eventYearGroup === "all") return true;

  // Split the event's year groups and check for a match
  const eventGroups = eventYearGroup.split(",").map((g) => g.trim().toLowerCase());
  const childGroup = childYearGroup.trim().toLowerCase();

  return eventGroups.includes(childGroup);
}

// ── WhatsApp sender ───────────────────────────────────────────────────────────

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const sid = TWILIO_ACCOUNT_SID;
  const token = TWILIO_AUTH_TOKEN;
  const from = TWILIO_WHATSAPP_NUMBER;

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${from}`);
  params.append("Body", text);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${sid}:${token}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) console.error("Twilio error:", await res.text());
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

  // Load parent phone numbers
  const parentIds = [...new Set(children.map((c) => c.parent_id))];
  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, phone_number")
    .in("user_id", parentIds)
    .not("phone_number", "is", null);

  if (!profiles || profiles.length === 0) {
    console.log("No parent phone numbers found");
    return;
  }

  const phoneByParent = new Map(profiles.map((p) => [p.user_id, p.phone_number!]));

  // Load linked accounts — so reminders fire to both parents
  // A linked account means Partner B should receive the same reminders as Parent A
  const { data: linkedAccounts } = await supabase
    .from("linked_accounts")
    .select("primary_user_id, linked_user_id")
    .eq("status", "accepted");

  // Build a map of linked phone numbers per primary parent
  // e.g. if Matt and Sarah are linked, Sarah also gets Matt's reminders
  const linkedPhones = new Map<string, string[]>();
  for (const link of linkedAccounts || []) {
    const linkedPhone = phoneByParent.get(link.linked_user_id);
    if (!linkedPhone) continue;
    if (!linkedPhones.has(link.primary_user_id)) {
      linkedPhones.set(link.primary_user_id, []);
    }
    linkedPhones.get(link.primary_user_id)!.push(linkedPhone);
  }

  // Group children by parent
  const childrenByParent = new Map<string, typeof children>();
  for (const child of children) {
    const phone = phoneByParent.get(child.parent_id);
    if (!phone) continue;
    if (!childrenByParent.has(child.parent_id)) {
      childrenByParent.set(child.parent_id, []);
    }
    childrenByParent.get(child.parent_id)!.push(child);
  }

  let sentCount = 0;

  // Process each parent — ONE message per parent
  for (const [parentId, parentChildren] of childrenByParent) {
    const phone = phoneByParent.get(parentId)!;
    const reminderItems: ReminderItem[] = [];
    const refIdsToLog: Array<{ refId: string; title: string; type: string }> = [];

    for (const child of parentChildren) {
      const schoolIds = [child.school_id].filter(Boolean);

      // 1. School events for target date
      const { data: events } = await supabase
        .from("school_events")
        .select("id, title, year_group")
        .eq("school_id", child.school_id)
        .gte("start_at", targetStart)
        .lte("start_at", targetEnd);

      for (const evt of events || []) {
        // Skip events not relevant to this child's year group
        if (!isEventRelevantToChild(evt.year_group || "all", child.year_group || "")) continue;

        const refId = `event_${evt.id}_${period}`;
        if (await alreadySent(phone, refId, period, today)) continue;
        reminderItems.push({
          childName: child.first_name,
          title: evt.title,
          emoji: "📅",
          type: "event",
          refId,
        });
        refIdsToLog.push({ refId, title: evt.title, type: "event" });
      }

      // 2. Child-specific reminders (e.g. Jude's PE on Monday)
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
        if (await alreadySent(phone, refId, period, today)) continue;
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
      // Check if today/tomorrow is a packed lunch day for this child
      // Calculate Monday of the target week using local date arithmetic
      // Avoids UTC conversion bugs by working with the date string directly
      const targetDateObj = new Date(targetDateStr + "T12:00:00Z"); // noon UTC = safe local date
      const targetDayNum = targetDateObj.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
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
        if (!(await alreadySent(phone, refId, period, today))) {
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
        const refId = `reminder_${rem.id}_${targetDateStr}_${period}`;
        if (await alreadySent(phone, refId, period, today)) continue;
        reminderItems.push({
          childName: child.first_name,
          title: rem.title,
          emoji: rem.emoji || "✅",
          type: "reminder",
          refId,
        });
        refIdsToLog.push({ refId, title: rem.title, type: "weekly" });
      }

      // 4. Parent notes matching target date
      // Notes are fetched per parent (not per child) since they're stored by phone number
      // Only fetch once per parent — skip for subsequent children to avoid duplicates
      if (parentChildren.indexOf(child) === 0) {
        const { data: notes } = await supabase
          .from("parent_notes")
          .select("id, summary, extracted_dates, child_name")
          .eq("phone_number", phone);

        for (const note of notes || []) {
          if (!note.summary || !note.extracted_dates) continue;
          const dates = note.extracted_dates as Array<{ date: string }>;
          if (!dates.some((d) => d.date === targetDateStr)) continue;

          const refId = `note_${note.id}_${targetDateStr}_${period}`;
          if (await alreadySent(phone, refId, period, today)) continue;

          // Use child_name from the note if available, otherwise use generic name
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
      }
    }

    // Skip if nothing to send
    if (reminderItems.length === 0) continue;

    // Build ONE consolidated message for this parent
    const message = buildConsolidatedMessage(reminderItems, period);

    // Send to primary parent
    const ok = await sendWhatsApp(phone, message);

    if (ok) {
      for (const { refId, title, type } of refIdsToLog) {
        await logReminder(phone, type, refId, title, period);
      }
      sentCount++;
      console.log(`Sent consolidated ${period} message to ${phone} with ${reminderItems.length} items`);
    }

    // Send to linked partner accounts (e.g. both Mum and Dad)
    const partnerPhones = linkedPhones.get(parentId) || [];
    for (const partnerPhone of partnerPhones) {
      const partnerOk = await sendWhatsApp(partnerPhone, message);
      if (partnerOk) {
        for (const { refId, title, type } of refIdsToLog) {
          await logReminder(partnerPhone, type, refId, title, period);
        }
        sentCount++;
        console.log(`Sent consolidated ${period} message to linked partner ${partnerPhone}`);
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
