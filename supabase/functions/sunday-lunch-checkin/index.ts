// sunday-lunch-checkin/index.ts
// Runs every Sunday evening (5pm UTC / 6pm BST)
// Asks parents which days each child needs packed lunch this week
// Triggered by pg_cron: 0 17 * * 0

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("Body", text);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!res.ok) console.error("Twilio error:", await res.text());
  return res.ok;
}

// Get the Monday date for the upcoming week
function getNextMonday(): Date {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const nextMonday = getNextMonday();
    const weekStart = nextMonday.toISOString().split("T")[0];
    const weekDates = formatWeekDates(nextMonday);

    // Load all parents with phone numbers and children
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

      // Skip if already sent this week's check-in
      const { data: existing } = await supabase
        .from("lunch_checkin_log")
        .select("id")
        .eq("parent_id", user_id)
        .eq("week_start", weekStart)
        .maybeSingle();

      if (existing) continue;

      // Load their children
      const { data: children } = await supabase
        .from("children")
        .select("id, first_name")
        .eq("parent_id", user_id);

      if (!children || children.length === 0) continue;

      // Build the check-in message
      const childNames = children.map((c: any) => c.first_name);
      const message = buildCheckinMessage(childNames, weekDates);

      const ok = await sendWhatsApp(phone_number, message);

      if (ok) {
        // Log so we don't send again this week
        await supabase.from("lunch_checkin_log").insert({
          parent_id: user_id,
          week_start: weekStart,
        });
        sentCount++;
        console.log(`Sent lunch check-in to ${phone_number}`);
      }
    }

    return new Response(
      JSON.stringify({ success: true, sent: sentCount, week_start: weekStart }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("sunday-lunch-checkin error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function buildCheckinMessage(childNames: string[], weekDates: string): string {
  if (childNames.length === 1) {
    const name = childNames[0];
    return `Hey! 🗓️ Quick one before the week starts (${weekDates}) — which days does ${name} need a packed lunch?\n\nJust reply with the days, e.g. *"Monday, Wednesday and Friday"* or *"every day"* or *"school dinners all week"* 😊`;
  }

  const names = childNames.length === 2
    ? `${childNames[0]} and ${childNames[1]}`
    : childNames.join(", ");

  return `Hey! 🗓️ Quick one before the week starts (${weekDates}) — which days do ${names} need packed lunches?\n\nJust let me know for each of them, e.g. *"Jude needs one Monday and Wednesday, Harry every day"* 😊`;
}
