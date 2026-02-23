import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = () => Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = () => Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = () => Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;

// Send a WhatsApp message via Twilio
async function sendWhatsAppMessage(to: string, text: string) {
  const accountSid = TWILIO_ACCOUNT_SID();
  const authToken = TWILIO_AUTH_TOKEN();
  const fromNumber = TWILIO_WHATSAPP_NUMBER();

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${fromNumber}`);
  params.append("Body", text);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!res.ok) {
    console.error("Twilio API error:", await res.text());
  }
  return res;
}

// Get or create a conversation for this phone number
async function getOrCreateConversation(phoneNumber: string) {
  const { data: existing } = await supabase
    .from("conversations")
    .select("*")
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ phone_number: phoneNumber })
    .select()
    .single();

  if (error) throw error;
  return created;
}

// Get the bot flow step
async function getBotFlowStep(stepName: string) {
  const { data } = await supabase
    .from("bot_flows")
    .select("*")
    .eq("step_name", stepName)
    .maybeSingle();
  return data;
}

// Log a message
async function logMessage(
  conversationId: string,
  direction: string,
  content: string,
  messageType = "text"
) {
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction,
    content,
    message_type: messageType,
  });
}

// Build a dynamic events message from the school_events table
async function buildEventsMessage(conversation: Record<string, unknown>): Promise<string | null> {
  // Try to find the user's school via profiles + children
  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("phone_number", conversation.phone_number as string)
    .maybeSingle();

  let schoolFilter: string | null = null;
  if (profile) {
    const { data: child } = await supabase
      .from("children")
      .select("school_id")
      .eq("parent_id", profile.user_id)
      .limit(1)
      .maybeSingle();
    if (child) schoolFilter = child.school_id;
  }

  let query = supabase
    .from("school_events")
    .select("title, start_at, all_day, location")
    .gte("start_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .limit(5);

  if (schoolFilter) {
    query = query.eq("school_id", schoolFilter);
  }

  const { data: events } = await query;

  if (!events || events.length === 0) return null;

  const lines = events.map((e) => {
    const d = new Date(e.start_at);
    const dateStr = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    const loc = e.location ? ` — ${e.location}` : "";
    return `📅 *${e.title}* — ${dateStr}${loc}`;
  });

  return `Here are the upcoming events:\n\n${lines.join("\n")}\n\n1️⃣ Back to main menu`;
}

// Process incoming message through bot flow
async function processMessage(phoneNumber: string, incomingText: string) {
  const conversation = await getOrCreateConversation(phoneNumber);
  
  // Log inbound message
  await logMessage(conversation.id, "inbound", incomingText);

  // Get current flow step
  const flowStep = await getBotFlowStep(conversation.current_step);

  if (!flowStep) {
    const defaultReply = "Thanks for your message! We'll get back to you soon.";
    await sendWhatsAppMessage(phoneNumber, defaultReply);
    await logMessage(conversation.id, "outbound", defaultReply);
    return;
  }

  // Check if user input matches an option
  const options = (flowStep.options as Array<{ keyword: string; next_step: string; label: string }>) || [];
  const userInput = incomingText.trim().toLowerCase();
  const matchedOption = options.find(
    (opt) => opt.keyword?.toLowerCase() === userInput
  );

  let nextStep = matchedOption?.next_step || flowStep.next_step || conversation.current_step;

  // Update conversation context and step
  const updatedContext = {
    ...(conversation.context as Record<string, unknown>),
    last_input: incomingText,
    last_step: conversation.current_step,
  };

  await supabase
    .from("conversations")
    .update({ current_step: nextStep, context: updatedContext })
    .eq("id", conversation.id);

  // For the "events" step, try to serve live calendar data
  let replyText: string | undefined;
  if (nextStep === "events") {
    const dynamicEvents = await buildEventsMessage(conversation);
    if (dynamicEvents) {
      replyText = dynamicEvents;
    }
  }

  // Fall back to the flow template
  if (!replyText) {
    const nextFlowStep = await getBotFlowStep(nextStep);
    replyText = nextFlowStep?.message_template || "Thank you!";
  }

  await sendWhatsAppMessage(phoneNumber, replyText);
  await logMessage(conversation.id, "outbound", replyText);
}

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Handle incoming messages from Twilio (POST with form data)
  if (req.method === "POST") {
    try {
      const contentType = req.headers.get("content-type") || "";

      let phoneNumber = "";
      let text = "";

      if (contentType.includes("application/x-www-form-urlencoded")) {
        // Twilio sends form-encoded data
        const formData = await req.formData();
        const from = formData.get("From")?.toString() || "";
        // Twilio format: "whatsapp:+447..." — strip the prefix
        phoneNumber = from.replace("whatsapp:", "");
        text = formData.get("Body")?.toString() || "";
      } else {
        // Fallback: JSON body (e.g. for testing)
        const body = await req.json();
        phoneNumber = body.from || body.From || "";
        text = body.body || body.Body || "";
        phoneNumber = phoneNumber.replace("whatsapp:", "");
      }

      if (phoneNumber && text) {
        await processMessage(phoneNumber, text);
      }

      // Twilio expects a TwiML response (empty is fine for no immediate reply)
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        {
          headers: { ...corsHeaders, "Content-Type": "text/xml" },
        }
      );
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "text/xml" },
        }
      );
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
