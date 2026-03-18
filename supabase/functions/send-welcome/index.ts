// send-welcome/index.ts
// Sends a welcome WhatsApp message to a newly onboarded parent
// Called from the frontend after onboarding completes

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

const WELCOME_MESSAGE = `Hi! 👋 I'm Monty — I'm all set up and ready to help you stay on top of school life. Just message me here any time to add reminders, ask what's coming up, or tell me about upcoming events. I'll send you a morning heads-up on days when there's something to remember. Talk soon! 🎒`;

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
    console.error("Twilio error:", await res.text());
  }
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_id } = await req.json();

    if (!user_id) {
      return new Response(
        JSON.stringify({ error: "user_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Look up the user's phone number
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("phone_number")
      .eq("user_id", user_id)
      .maybeSingle();

    if (profileError || !profile?.phone_number) {
      console.error("Could not find phone number for user:", user_id, profileError);
      return new Response(
        JSON.stringify({ error: "No phone number found for user" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Send the welcome message
    const sent = await sendWhatsApp(profile.phone_number, WELCOME_MESSAGE);

    return new Response(
      JSON.stringify({ success: sent, phone: profile.phone_number }),
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
