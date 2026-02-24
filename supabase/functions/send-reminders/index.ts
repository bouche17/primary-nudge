import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = () => Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = () => Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = () => Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;

// ── Send WhatsApp ───────────────────────────────────────────────────

async function sendWhatsApp(to: string, text: string) {
  const sid = TWILIO_ACCOUNT_SID();
  const token = TWILIO_AUTH_TOKEN();
  const from = TWILIO_WHATSAPP_NUMBER();

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${from}`);
  params.append("Body", text);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${sid}:${token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    console.error("Twilio error:", await res.text());
  }
  return res.ok;
}

// ── Dedup check ─────────────────────────────────────────────────────

async function alreadySent(
  phone: string,
  refId: string,
  period: string,
  today: string
): Promise<boolean> {
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

async function logReminder(
  phone: string,
  type: string,
  refId: string,
  title: string,
  period: string
) {
  await supabase.from("reminder_log").insert({
    phone_number: phone,
    reminder_type: type,
    reference_id: refId,
    reference_title: title,
    period,
  });
}

// ── Build personalised messages ─────────────────────────────────────

function buildEventReminder(
  childName: string,
  schoolName: string,
  eventTitle: string,
  eventDate: Date,
  period: string
): string {
  const dayStr = eventDate.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  if (period === "evening") {
    return `Good evening! 🌙 Just a heads up — ${childName} has *${eventTitle}* tomorrow at ${schoolName}. Make sure everything's ready tonight! 📋`;
  }
  return `Good morning! ☀️ Quick reminder: ${childName} has *${eventTitle}* today (${dayStr}) at ${schoolName}. Have a great day! 🎒`;
}

function buildWeeklyReminder(
  childName: string,
  title: string,
  emoji: string,
  dayOfWeek: string,
  period: string
): string {
  if (period === "evening") {
    return `Hey! 👋 Don't forget — ${childName} needs *${title}* ${emoji} tomorrow (${dayOfWeek}). Best to get it sorted tonight! 😊`;
  }
  return `Good morning! ☀️ Reminder: ${childName} needs *${title}* ${emoji} today (${dayOfWeek}). You've got this! 💪`;
}

function buildNoteReminder(
  childName: string,
  summary: string,
  period: string
): string {
  if (period === "evening") {
    return `Hey! 📝 Just checking — you saved a note about: *${summary}*. That's coming up tomorrow for ${childName}. All sorted? 😊`;
  }
  return `Good morning! 📝 Reminder about: *${summary}* — that's today for ${childName}! 🎯`;
}

// ── Main logic ──────────────────────────────────────────────────────

async function sendReminders(period: "evening" | "morning") {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // For evening reminders, look at tomorrow; for morning, look at today
  const targetDate = new Date(now);
  if (period === "evening") {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  const targetDay = targetDate.toLocaleDateString("en-GB", { weekday: "long" });
  const targetDateStr = targetDate.toISOString().split("T")[0];
  const targetStart = `${targetDateStr}T00:00:00Z`;
  const targetEnd = `${targetDateStr}T23:59:59Z`;

  // Get all parent-child-school relationships
  const { data: children } = await supabase
    .from("children")
    .select("first_name, school_id, parent_id");

  if (!children || children.length === 0) {
    console.log("No children registered yet");
    return;
  }

  // Map parent_id → phone_number via profiles
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

  const phoneByParent = new Map(
    profiles.map((p) => [p.user_id, p.phone_number!])
  );

  // Get school names
  const schoolIds = [...new Set(children.map((c) => c.school_id))];
  const { data: schools } = await supabase
    .from("schools")
    .select("id, name")
    .in("id", schoolIds);
  const schoolName = new Map(schools?.map((s) => [s.id, s.name]) ?? []);

  let sentCount = 0;

  for (const child of children) {
    const phone = phoneByParent.get(child.parent_id);
    if (!phone) continue;

    const school = schoolName.get(child.school_id) || "school";

    // 1. School events for the target date
    const { data: events } = await supabase
      .from("school_events")
      .select("id, title, start_at")
      .eq("school_id", child.school_id)
      .gte("start_at", targetStart)
      .lte("start_at", targetEnd);

    for (const evt of events || []) {
      const refId = `event_${evt.id}`;
      if (await alreadySent(phone, refId, period, today)) continue;

      const msg = buildEventReminder(
        child.first_name,
        school,
        evt.title,
        new Date(evt.start_at),
        period
      );
      const ok = await sendWhatsApp(phone, msg);
      if (ok) {
        await logReminder(phone, "event", refId, evt.title, period);
        sentCount++;
      }
    }

    // 2. Weekly recurring reminders matching the target day
    const { data: reminders } = await supabase
      .from("school_reminders")
      .select("id, title, emoji, day_of_week")
      .eq("active", true)
      .or(`school_id.eq.${child.school_id},school_id.is.null`)
      .eq("day_of_week", targetDay);

    for (const rem of reminders || []) {
      const refId = `reminder_${rem.id}_${targetDateStr}`;
      if (await alreadySent(phone, refId, period, today)) continue;

      const msg = buildWeeklyReminder(
        child.first_name,
        rem.title,
        rem.emoji || "✅",
        targetDay,
        period
      );
      const ok = await sendWhatsApp(phone, msg);
      if (ok) {
        await logReminder(phone, "weekly", refId, rem.title, period);
        sentCount++;
      }
    }

    // 3. Parent notes with dates matching the target date
    const { data: notes } = await supabase
      .from("parent_notes")
      .select("id, summary, extracted_dates")
      .eq("phone_number", phone);

    for (const note of notes || []) {
      if (!note.summary || !note.extracted_dates) continue;
      const dates = note.extracted_dates as Array<{ date: string }>;
      const hasMatch = dates.some((d) => d.date === targetDateStr);
      if (!hasMatch) continue;

      const refId = `note_${note.id}_${targetDateStr}`;
      if (await alreadySent(phone, refId, period, today)) continue;

      const msg = buildNoteReminder(child.first_name, note.summary, period);
      const ok = await sendWhatsApp(phone, msg);
      if (ok) {
        await logReminder(phone, "note", refId, note.summary, period);
        sentCount++;
      }
    }
  }

  console.log(`[${period}] Sent ${sentCount} reminders`);
}

// ── HTTP handler ────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Determine period from query param or time of day
    const url = new URL(req.url);
    let period = url.searchParams.get("period") as "evening" | "morning" | null;

    if (!period) {
      const hour = new Date().getUTCHours();
      // Default: before 12 UTC = morning, after = evening
      period = hour < 12 ? "morning" : "evening";
    }

    await sendReminders(period);

    return new Response(
      JSON.stringify({ success: true, period }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-reminders error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
