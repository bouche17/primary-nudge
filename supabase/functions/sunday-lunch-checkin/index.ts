// sunday-lunch-checkin/index.ts
// Runs every Sunday evening (5pm UTC / 6pm BST)
// Sends a week ahead summary + packed lunch check-in
// Triggered by pg_cron: 0 17 * * 0

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("Body", text);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) console.error("Twilio error:", await res.text());
  return res.ok;
}

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const nextMonday = getNextMonday();
    const weekStart = nextMonday.toISOString().split("T")[0];
    const weekDates = formatWeekDates(nextMonday);

    // Date range for the upcoming week (Mon–Fri)
    const weekStartDate = `${weekStart}T00:00:00Z`;
    const friday = new Date(nextMonday);
    friday.setDate(nextMonday.getDate() + 4);
    const weekEndDate = `${friday.toISOString().split("T")[0]}T23:59:59Z`;

    // Load all parents
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, phone_number")
      .not("phone_number", "is", null);

    if (!profiles || profiles.length === 0) {
      return new Response(JSON.stringify({ message: "No parents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let sentCount = 0;

    for (const profile of profiles) {
      const { user_id, phone_number } = profile;

      // Skip if already sent this week
      const { data: existing } = await supabase
        .from("lunch_checkin_log")
        .select("id")
        .eq("parent_id", user_id)
        .eq("week_start", weekStart)
        .maybeSingle();

      if (existing) continue;

      // Load children with year group and school
      const { data: children } = await supabase
        .from("children")
        .select("id, first_name, year_group, school_id")
        .eq("parent_id", user_id);

      if (!children || children.length === 0) continue;

      const childIds = children.map((c: any) => c.id);
      const schoolIds = [...new Set(children.map((c: any) => c.school_id).filter(Boolean))];

      // Load PE and recurring reminders for each child this week
      const weeklyItems: string[] = [];

      // Child-specific recurring reminders (PE days etc.)
      const { data: childReminders } = await supabase
        .from("child_reminders")
        .select("child_id, title, emoji, day_of_week, children(first_name)")
        .in("child_id", childIds)
        .eq("active", true);

      // Group reminders by day
      const remindersByDay: Record<string, string[]> = {};
      for (const rem of childReminders || []) {
        const childName = (rem as any).children?.first_name || "Unknown";
        const line = `${rem.emoji} ${childName}'s ${rem.title}`;
        if (!remindersByDay[rem.day_of_week]) remindersByDay[rem.day_of_week] = [];
        remindersByDay[rem.day_of_week].push(line);
      }

      // School events this week
      const { data: events } =
        schoolIds.length > 0
          ? await supabase
              .from("school_events")
              .select("title, start_at")
              .in("school_id", schoolIds)
              .gte("start_at", weekStartDate)
              .lte("start_at", weekEndDate)
              .order("start_at", { ascending: true })
          : { data: [] };

      // Parent notes this week
      const { data: notes } = await supabase
        .from("parent_notes")
        .select("summary, extracted_dates, child_name")
        .eq("phone_number", phone_number);

      // Build week ahead lines
      for (let i = 0; i < 5; i++) {
        const dayName = DAYS[i];
        const dayDate = getDateForDay(nextMonday, i);
        const dayLines: string[] = [];

        // Add recurring reminders
        if (remindersByDay[dayName]) {
          dayLines.push(...remindersByDay[dayName]);
        }

        // Add school events on this day
        for (const evt of events || []) {
          const evtDate = evt.start_at.split("T")[0];
          if (evtDate === dayDate) {
            dayLines.push(`📅 ${evt.title}`);
          }
        }

        // Add parent notes on this day
        for (const note of notes || []) {
          if (!note.extracted_dates) continue;
          const dates = note.extracted_dates as Array<{ date: string }>;
          if (!dates.some((d) => d.date === dayDate)) continue;
          const prefix = note.child_name ? `${note.child_name}: ` : "";
          dayLines.push(`📝 ${prefix}${note.summary}`);
        }

        if (dayLines.length > 0) {
          weeklyItems.push(`*${dayName}*\n${dayLines.map((l) => `  ${l}`).join("\n")}`);
        }
      }

      // Build the full message
      const childNames = children.map((c: any) => c.first_name);
      const message = buildSundayMessage(childNames, weekDates, weeklyItems);

      const ok = await sendWhatsApp(phone_number, message);

      if (ok) {
        await supabase.from("lunch_checkin_log").insert({
          parent_id: user_id,
          week_start: weekStart,
        });
        sentCount++;
        console.log(`Sent Sunday summary to ${phone_number}`);
      }
    }

    return new Response(JSON.stringify({ success: true, sent: sentCount, week_start: weekStart }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("sunday-lunch-checkin error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function buildSundayMessage(childNames: string[], weekDates: string, weeklyItems: string[]): string {
  const names =
    childNames.length === 1
      ? childNames[0]
      : childNames.length === 2
        ? `${childNames[0]} and ${childNames[1]}`
        : childNames.join(", ");

  const greeting = `Hey! 👋 Here's what Monty has on for ${names} this week (${weekDates}):`;

  const summary =
    weeklyItems.length > 0 ? weeklyItems.join("\n\n") : `Nothing specific flagged — looks like a quiet week!`;

  const lunchQuestion =
    childNames.length === 1
      ? `Which days does ${childNames[0]} need a packed lunch this week? Just reply with the days or say *"school dinners all week"* 🥪`
      : `Which days do they need packed lunches this week? Just let me know for each, e.g. *"${childNames[0]} needs one Monday and Wednesday, ${childNames[1]} every day"* 🥪`;

  return `${greeting}\n\n${summary}\n\n${lunchQuestion}`;
}
