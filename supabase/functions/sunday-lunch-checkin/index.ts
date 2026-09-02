// sunday-lunch-checkin/index.ts
// Runs every Sunday evening (5pm UTC / 6pm BST)
// Sends the upcoming week's ahead summary + packed lunch check-in via the
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

// Returns the Monday of the upcoming week (the Monday immediately following
// the current date), so the Sunday evening check-in previews the week ahead.
function getNextMonday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + daysUntilNextMonday);
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
    const targetMonday = getNextMonday();
    const weekStart = targetMonday.toISOString().split("T")[0];
    const weekDates = formatWeekDates(targetMonday);

    const { data: allChildren } = await supabase
      .from("children")
      .select("id, first_name, year_group, school_id, parent_id");

    if (!allChildren || allChildren.length === 0) {
      return new Response(JSON.stringify({ message: "No children found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, phone_number")
      .not("phone_number", "is", null);

    if (!profiles || profiles.length === 0) {
      return new Response(JSON.stringify({ message: "No parents found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    let sentCount = 0;
    const failures: { phone_number: string; status_code: number; body: string }[] = [];

    for (const [familyId, children] of childrenByFamily) {
      const familyPhones = Array.from(phonesByFamily.get(familyId) || []);
      if (familyPhones.length === 0) continue;

      const familyMembers = membersByFamily.get(familyId) || [familyId];
      const anchorUserId = familyId;

      const { data: existing } = await supabase
        .from("lunch_checkin_log")
        .select("id")
        .in("parent_id", familyMembers)
        .eq("week_start", weekStart)
        .limit(1);

      if (existing && existing.length > 0) continue;

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
        .in("phone_number", familyPhones);

      for (let i = 0; i < 5; i++) {
        const dayName = DAYS[i];
        const dayDate = getDateForDay(targetMonday, i);
        const dayLines: string[] = [];

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

      const summary =
        weeklyItems.length > 0 ? weeklyItems.join(" | ") : "Nothing specific flagged — looks like a quiet week!";

      let anySent = false;
      for (const phone_number of familyPhones) {
        const result = await sendWhatsApp(phone_number, names, weekDates, summary);

        if (result.ok) {
          anySent = true;
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

      if (anySent) {
        await supabase.from("lunch_checkin_log").insert({
          parent_id: anchorUserId,
          week_start: weekStart,
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
