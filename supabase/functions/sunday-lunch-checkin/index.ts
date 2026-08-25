// sunday-lunch-checkin/index.ts
// Runs every Sunday evening (5pm UTC / 6pm BST)
// Sends the "week after next" ahead summary + packed lunch check-in via the
// approved monty_sunday_evening Content Template (3 variables: names, week
// dates, weekly summary — lunch question/examples are fixed template text).
// Triggered by pg_cron: 0 17 * * 0
// NOTE: deliberately does NOT respect the send-reminders holiday pause guard —
// this check-in is meant to build trust with parents in the run-up to term starting.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_SUNDAY_TEMPLATE_SID =
  Deno.env.get("TWILIO_SUNDAY_TEMPLATE_SID") || "HXf63d73d24635780bb42d76ba726d83b4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Matches the sanitisation used in send-reminders: preserve real newlines so
// WhatsApp renders line breaks, collapse other whitespace runs, and strip
// control chars / curly quotes / em-dashes that break JSON.
function sanitiseForTwilio(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\\/g, "")
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .trim()
    .slice(0, 1024);
}

async function sendWhatsApp(to: string, names: string, weekDates: string, summary: string): Promise<{ ok: boolean; status_code: number; body: string }> {
  if (!TWILIO_SUNDAY_TEMPLATE_SID) {
    console.error("No TWILIO_SUNDAY_TEMPLATE_SID configured — refusing to send freeform.");
    return { ok: false, status_code: 0, body: "No TWILIO_SUNDAY_TEMPLATE_SID configured" };
  }

  const contentVariables = JSON.stringify({
    "1": sanitiseForTwilio(names),
    "2": sanitiseForTwilio(weekDates),
    "3": sanitiseForTwilio(summary),
  });

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", TWILIO_SUNDAY_TEMPLATE_SID);
  params.append("ContentVariables", contentVariables);

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
  if (!res.ok) console.error("Twilio error:", responseBody);
  return { ok: res.ok, status_code: res.status, body: responseBody };
}

// Returns the Monday of the week AFTER next (two weeks out from "now"), giving
// parents runway to plan packed lunches and submit Arbor meal choices ahead of
// the deadline, rather than only previewing the immediate upcoming week.
function getWeekAfterNextMonday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilNextMonday + 7);
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
    const targetMonday = getWeekAfterNextMonday();
    const weekStart = targetMonday.toISOString().split("T")[0];
    const weekDates = formatWeekDates(targetMonday);

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
    const failures: { phone_number: string; status_code: number; body: string }[] = [];

    for (const profile of profiles) {
      const { user_id, phone_number } = profile;

      const { data: existing } = await supabase
        .from("lunch_checkin_log")
        .select("id")
        .eq("parent_id", user_id)
        .eq("week_start", weekStart)
        .maybeSingle();

      if (existing) continue;

      const { data: children } = await supabase
        .from("children")
        .select("id, first_name, year_group, school_id")
        .eq("parent_id", user_id);

      if (!children || children.length === 0) continue;

      const childIds = children.map((c: any) => c.id);

      const weeklyItems: string[] = [];

      const { data: childReminders } = await supabase
        .from("child_reminders")
        .select("child_id, title, emoji, day_of_week, children(first_name)")
        .in("child_id", childIds)
        .eq("active", true);

      const remindersByDay: Record<string, string[]> = {};
      for (const rem of childReminders || []) {
        const childName = (rem as any).children?.first_name || "Unknown";
        const line = `${rem.emoji} ${childName}'s ${rem.title}`;
        if (!remindersByDay[rem.day_of_week]) remindersByDay[rem.day_of_week] = [];
        remindersByDay[rem.day_of_week].push(line);
      }

      const { data: notes } = await supabase
        .from("parent_notes")
        .select("summary, extracted_dates, child_name")
        .eq("phone_number", phone_number);

      for (let i = 0; i < 5; i++) {
        const dayName = DAYS[i];
        const dayDate = getDateForDay(targetMonday, i);
        const dayLines: string[] = [];

        if (remindersByDay[dayName]) {
          dayLines.push(...remindersByDay[dayName]);
        }

        for (const note of notes || []) {
          if (!note.extracted_dates) continue;
          const dates = note.extracted_dates as Array<{ date: string }>;
          if (!dates.some((d) => d.date === dayDate)) continue;
          const prefix = note.child_name ? `${note.child_name}: ` : "";
          dayLines.push(`📝 ${prefix}${note.summary}`);
        }

        if (dayLines.length > 0) {
          weeklyItems.push(`${dayName}: ${dayLines.join(", ")}`);
        }
      }

      const childNames = children.map((c: any) => c.first_name);
      const names =
        childNames.length === 1
          ? childNames[0]
          : childNames.length === 2
            ? `${childNames[0]} and ${childNames[1]}`
            : childNames.join(", ");

      const summary =
        weeklyItems.length > 0 ? weeklyItems.join(" • ") : "Nothing specific flagged — looks like a quiet week!";

      const result = await sendWhatsApp(phone_number, names, weekDates, summary);

      if (result.ok) {
        await supabase.from("lunch_checkin_log").insert({
          parent_id: user_id,
          week_start: weekStart,
        });
        sentCount++;
        console.log(`Sent Sunday summary to ${phone_number} for week ${weekStart}`);
      } else {
        failures.push({
          phone_number,
          status_code: result.status_code,
          body: result.body,
        });
      }
    }

    return new Response(JSON.stringify({ success: true, sent: sentCount, week_start: weekStart, failures }), {
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
