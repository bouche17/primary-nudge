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

const WHATSAPP_ACCESS_TOKEN = () => Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = () => Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const WHATSAPP_VERIFY_TOKEN = () => Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;

// Send a WhatsApp message via the Cloud API
async function sendWhatsAppMessage(to: string, text: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID()}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
  if (!res.ok) {
    console.error("WhatsApp API error:", await res.text());
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

// Process incoming message through bot flow
async function processMessage(phoneNumber: string, incomingText: string) {
  const conversation = await getOrCreateConversation(phoneNumber);
  
  // Log inbound message
  await logMessage(conversation.id, "inbound", incomingText);

  // Get current flow step
  const flowStep = await getBotFlowStep(conversation.current_step);

  if (!flowStep) {
    // No flow defined yet — send a default reply
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

  // Get the next step's message
  const nextFlowStep = await getBotFlowStep(nextStep);
  const replyText = nextFlowStep?.message_template || "Thank you!";

  await sendWhatsAppMessage(phoneNumber, replyText);
  await logMessage(conversation.id, "outbound", replyText);
}

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // Webhook verification (GET request from Meta)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN()) {
      console.log("Webhook verified successfully");
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // Handle incoming messages (POST from Meta)
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // Process only message events
      if (value?.messages) {
        for (const message of value.messages) {
          const phoneNumber = message.from;
          const text = message.text?.body || "";

          if (text) {
            await processMessage(phoneNumber, text);
          }
        }
      }

      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
