// send-welcome/index.ts
// Called by the frontend when a parent completes onboarding (clicks "Finish setup")
// Inserts a row into onboarding_state and sends a welcome WhatsApp from Monty
// 
// Called via POST with JSON body: { user_id: "uuid" }
// Or via GET with query param: ?user_id=uuid

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

// ── WhatsApp sender ───────────────────────────────────────────────────────────

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

  if (!res.ok) {
    const err = await res.text();
    console.error("Twilio error:", err);
  }
  return res.ok;
}

// ── Welcome message builder ───────────────────────────────────────────────────

function buildWelcomeMessage(childNames: string[]): string {
  if (childNames.length === 0) {
    return `Hi! 👋 I'm Monty — I'm all set up and ready to help you stay on top of school life.\n\nJust message me here any time to add reminders, ask what's coming up, or tell me about an upcoming event. I'll send you a morning heads-up on days when there's something to remember. 🎒`;
  }

  const names = childNames.length === 1
    ? childNames[0]
    : childNames.length === 2
      ? `${childNames[0]} and ${childNames[1]}`
      : `${childNames.slice(0, -1).join(", ")} and ${childNames[childNames.length - 1]}`;

  return `Hi! 👋 I'm Monty — I'm all set up and ready to help you keep on top of school life for ${names}.\n\nJust message me here any time — tell me about PE days, packed lunch days, school trips, or anything else you want to remember. I'll send you a morning heads-up when it matters. 🎒\n\nTo get started, try saying something like *"${childNames[0]} has PE on Tuesdays"* 😊`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get user_id from POST body or GET query param
    let userId: string | null = null;

    if (req.method === "POST") {
      const body = await req.json();
      userId = body.user_id;
    } else {
      const url = new URL(req.url);
      userId = url.searchParams.get("user_id");
    }

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "user_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if already welcomed
    const { data: existing } = await supabase
      .from("onboarding_state")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing) {
      console.log("Already welcomed user:", userId);
      return new Response(
        JSON.stringify({ message: "Already welcomed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get their phone number
    const { data: profile } = await supabase
      .from("profiles")
      .select("phone_number")
      .eq("user_id", userId)
      .maybeSingle();

    if (!profile?.phone_number) {
      return new Response(
        JSON.stringify({ error: "No phone number found for user" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get their children's names
    const { data: children } = await supabase
      .from("children")
      .select("first_name")
      .eq("parent_id", userId);

    const childNames = (children || []).map((c: any) => c.first_name);

    // Build and send welcome message
    const message = buildWelcomeMessage(childNames);
    const ok = await sendWhatsApp(profile.phone_number, message);

    // Mark onboarding as complete regardless of WhatsApp success
    // (so we don't spam if they message manually before welcome arrives)
    await supabase.from("onboarding_state").insert({
      user_id: userId,
      phone_number: profile.phone_number,
      status: "complete",
    });

    console.log(`Welcome sent to ${profile.phone_number} for user ${userId}`);

    return new Response(
      JSON.stringify({ success: ok, phone: profile.phone_number }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("send-welcome error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
