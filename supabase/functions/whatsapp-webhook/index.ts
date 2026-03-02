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
const LOVABLE_API_KEY = () => Deno.env.get("LOVABLE_API_KEY")!;

// ── Twilio helpers ──────────────────────────────────────────────────

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

// ── Database helpers ────────────────────────────────────────────────

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

async function getBotFlowStep(stepName: string) {
  const { data } = await supabase
    .from("bot_flows")
    .select("*")
    .eq("step_name", stepName)
    .maybeSingle();
  return data;
}

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

// ── Dynamic content builders ────────────────────────────────────────

async function getChildSchoolForPhone(phoneNumber: string) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (!profile) return { schoolId: null, childName: null };

  const { data: child } = await supabase
    .from("children")
    .select("school_id, first_name")
    .eq("parent_id", profile.user_id)
    .limit(1)
    .maybeSingle();

  return {
    schoolId: child?.school_id || null,
    childName: child?.first_name || null,
  };
}

async function buildEventsMessage(phoneNumber: string): Promise<string | null> {
  const { schoolId } = await getChildSchoolForPhone(phoneNumber);

  let query = supabase
    .from("school_events")
    .select("title, start_at, all_day, location")
    .gte("start_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .limit(5);

  if (schoolId) query = query.eq("school_id", schoolId);

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

async function buildRemindersMessage(phoneNumber: string): Promise<string | null> {
  const { schoolId } = await getChildSchoolForPhone(phoneNumber);

  let query = supabase
    .from("school_reminders")
    .select("title, day_of_week, due_date, emoji")
    .eq("active", true)
    .order("sort_order", { ascending: true })
    .limit(10);

  if (schoolId) {
    query = query.or(`school_id.eq.${schoolId},school_id.is.null`);
  } else {
    query = query.is("school_id", null);
  }

  const { data: reminders } = await query;
  if (!reminders || reminders.length === 0) return null;

  const lines = reminders.map((r) => {
    const emoji = r.emoji || "✅";
    const when = r.due_date
      ? new Date(r.due_date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
      : r.day_of_week
        ? `every *${r.day_of_week}*`
        : "";
    return `${emoji} ${r.title}${when ? ` — ${when}` : ""}`;
  });

  return `Here are your reminders 🔔:\n\n${lines.join("\n")}\n\nAnything else?\n\n1️⃣ Back to main menu\n2️⃣ Contact school`;
}

// ── Forwarded message / note extraction ─────────────────────────────

function isForwardedOrLong(text: string): boolean {
  const lower = text.toLowerCase();
  // WhatsApp forwarded messages or long school emails/letters
  return (
    lower.includes("forwarded") ||
    lower.includes("------") ||
    lower.includes("from:") ||
    lower.includes("subject:") ||
    lower.includes("dear parent") ||
    lower.includes("dear carer") ||
    text.length > 300
  );
}

async function extractAndStoreNote(phoneNumber: string, rawContent: string): Promise<string> {
  const today = new Date().toISOString().split("T")[0];
  const { childName } = await getChildSchoolForPhone(phoneNumber);
  const name = childName || "your child";

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY()}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `You are Monty, a friendly school assistant. A parent has forwarded you a message from their child's school. Today's date is ${today}.

Extract the key information and return ONLY a JSON object with:
{
  "summary": "Brief 1-sentence summary of what it's about",
  "dates": [{"date": "YYYY-MM-DD", "label": "what's happening"}],
  "actions": [{"action": "what the parent needs to do", "by_date": "YYYY-MM-DD or null"}]
}

Be generous with dates — if something says "next Monday" work it out from today. If no dates found, return empty arrays.`,
          },
          { role: "user", content: rawContent },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    if (!res.ok) {
      console.error("AI extraction error:", await res.text());
      // Still store the raw content even if AI fails
      await supabase.from("parent_notes").insert({
        phone_number: phoneNumber,
        raw_content: rawContent,
        summary: "Forwarded message (processing failed)",
        source_type: "forwarded",
      });
      return `Thanks for forwarding that! 📩 I've saved it but couldn't quite parse all the details. I'll keep it on file for you. Need anything else?\n\n1️⃣ Back to main menu`;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);

    let summary = "Forwarded message";
    let dates: Array<{ date: string; label: string }> = [];
    let actions: Array<{ action: string; by_date: string | null }> = [];

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      summary = parsed.summary || summary;
      dates = parsed.dates || [];
      actions = parsed.actions || [];
    }

    await supabase.from("parent_notes").insert({
      phone_number: phoneNumber,
      raw_content: rawContent,
      summary,
      extracted_dates: dates,
      extracted_actions: actions,
      source_type: "forwarded",
    });

    // Build a friendly response
    let reply = `Got it! 📩 I've noted that down:\n\n📝 *${summary}*`;

    if (dates.length > 0) {
      reply += "\n\n📅 Key dates:";
      for (const d of dates) {
        const dateObj = new Date(d.date);
        const niceDate = dateObj.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
        });
        reply += `\n  • ${d.label} — ${niceDate}`;
      }
      reply += "\n\nI'll remind you before each of these! ⏰";
    }

    if (actions.length > 0) {
      reply += "\n\n✅ Things to do:";
      for (const a of actions) {
        const byDate = a.by_date
          ? ` (by ${new Date(a.by_date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })})`
          : "";
        reply += `\n  • ${a.action}${byDate}`;
      }
    }

    reply += `\n\nAnything else for ${name}? 😊\n\n1️⃣ Back to main menu`;
    return reply;
  } catch (err) {
    console.error("Note extraction error:", err);
    await supabase.from("parent_notes").insert({
      phone_number: phoneNumber,
      raw_content: rawContent,
      summary: "Forwarded message",
      source_type: "forwarded",
    });
    return `Thanks! 📩 I've saved that message. I'll keep it handy for you!\n\n1️⃣ Back to main menu`;
  }
}

// ── AI Intent Classification ────────────────────────────────────────

interface IntentResult {
  intent: string;
  confidence: number;
}

async function classifyIntent(
  userMessage: string,
  availableOptions: Array<{ keyword: string; label: string; next_step: string }>,
  recentHistory: Array<{ role: string; content: string }> = []
): Promise<IntentResult> {
  const optionDescriptions = availableOptions
    .map((o) => `- "${o.keyword}" (${o.label}) → step: ${o.next_step}`)
    .join("\n");

  const historyContext = recentHistory.length > 0
    ? `\nRecent conversation:\n${recentHistory.map((m) => `${m.role}: ${m.content}`).join("\n")}\n`
    : "";

  const systemPrompt = `You are Monty, a friendly school assistant WhatsApp bot. Your job is to classify a parent's message into one of the available menu options.
${historyContext}
Available options:
${optionDescriptions}

Rules:
- Respond with ONLY a JSON object: {"intent": "<next_step>", "confidence": <0.0-1.0>}
- If the message clearly matches an option, return that option's next_step with high confidence
- If the message is a greeting (hi, hello, hey), return {"intent": "greeting", "confidence": 0.9}
- If the message doesn't match any option, return {"intent": "unknown", "confidence": 0.0}
- Be generous in matching — "what's happening this week" should match events, "PE kit" should match reminders, "lunch" or "food" should match lunch menu, "call school" or "phone number" should match contact
- Use conversation history for context — e.g. "tell me more", "what else", "go back" should be understood in context
- Do NOT add any other text, just the JSON`;

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY()}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 100,
      }),
    });

    if (!res.ok) {
      console.error("AI Gateway error:", await res.text());
      return { intent: "unknown", confidence: 0 };
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "";

    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.error("AI returned non-JSON:", raw);
      return { intent: "unknown", confidence: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      intent: parsed.intent || "unknown",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch (err) {
    console.error("AI classification error:", err);
    return { intent: "unknown", confidence: 0 };
  }
}

// ── Core message processing ─────────────────────────────────────────

async function getRecentHistory(conversationId: string, limit = 6): Promise<Array<{ role: string; content: string }>> {
  const { data } = await supabase
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!data) return [];
  return data.reverse().map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.content,
  }));
}

async function processMessage(phoneNumber: string, incomingText: string) {
  const conversation = await getOrCreateConversation(phoneNumber);
  await logMessage(conversation.id, "inbound", incomingText);

  // ── Check for forwarded messages first ──
  if (isForwardedOrLong(incomingText)) {
    console.log("Detected forwarded/long message, extracting notes...");
    const reply = await extractAndStoreNote(phoneNumber, incomingText);
    await sendWhatsAppMessage(phoneNumber, reply);
    await logMessage(conversation.id, "outbound", reply);
    return;
  }

  const flowStep = await getBotFlowStep(conversation.current_step);

  if (!flowStep) {
    const defaultReply = "Thanks for your message! We'll get back to you soon.";
    await sendWhatsAppMessage(phoneNumber, defaultReply);
    await logMessage(conversation.id, "outbound", defaultReply);
    return;
  }

  // Try exact keyword match first (fast path)
  const options = (flowStep.options as Array<{ keyword: string; next_step: string; label: string }>) || [];
  const userInput = incomingText.trim().toLowerCase();
  let matchedOption = options.find(
    (opt) => opt.keyword?.toLowerCase() === userInput
  );

  // If no exact match, use AI with conversation history
  if (!matchedOption && options.length > 0 && userInput.length > 0) {
    console.log(`No exact match for "${userInput}", using AI classification...`);
    const recentHistory = await getRecentHistory(conversation.id);
    const aiResult = await classifyIntent(userInput, options, recentHistory);
    console.log(`AI classified as: ${aiResult.intent} (confidence: ${aiResult.confidence})`);

    if (aiResult.confidence >= 0.6 && aiResult.intent !== "unknown") {
      if (aiResult.intent === "greeting") {
        const greetings = [
          "Hi there! 😊 How can I help today?",
          "Hey! 👋 What can I do for you?",
          "Hello! How can I help you today? 😊",
          "Hi! 🙂 What do you need help with?",
        ];
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];
        const greetingReply = `${greeting}\n\n${flowStep.message_template}`;
        await sendWhatsAppMessage(phoneNumber, greetingReply);
        await logMessage(conversation.id, "outbound", greetingReply);
        return;
      }
      matchedOption = options.find((opt) => opt.next_step === aiResult.intent);
    }
  }

  let nextStep = matchedOption?.next_step || flowStep.next_step || conversation.current_step;

  // If still no match and it's not a navigation step, send a friendly nudge
  if (!matchedOption && !flowStep.next_step && options.length > 0) {
    const optionLabels = options.map((o) => `${o.keyword}️⃣ ${o.label}`).join("\n");
    const nudge = `Hmm, I didn't quite catch that 🤔\n\nHere's what I can help with:\n${optionLabels}\n\nJust type a number or tell me what you need!`;
    await sendWhatsAppMessage(phoneNumber, nudge);
    await logMessage(conversation.id, "outbound", nudge);
    return;
  }

  // Update conversation state with history summary
  const ctx = conversation.context as Record<string, unknown> || {};
  const history = Array.isArray(ctx.recent_topics) ? ctx.recent_topics as string[] : [];
  if (nextStep !== conversation.current_step) history.push(nextStep);
  const updatedContext = {
    ...ctx,
    last_input: incomingText,
    last_step: conversation.current_step,
    recent_topics: history.slice(-5),
  };

  await supabase
    .from("conversations")
    .update({ current_step: nextStep, context: updatedContext })
    .eq("id", conversation.id);

  // Build reply — dynamic for events & reminders, template for everything else
  let replyText: string | undefined;
  if (nextStep === "events") {
    const dynamicEvents = await buildEventsMessage(phoneNumber);
    if (dynamicEvents) replyText = dynamicEvents;
  } else if (nextStep === "reminders") {
    const dynamicReminders = await buildRemindersMessage(phoneNumber);
    if (dynamicReminders) replyText = dynamicReminders;
  }

  if (!replyText) {
    const nextFlowStep = await getBotFlowStep(nextStep);
    replyText = nextFlowStep?.message_template || "Thank you!";
  }

  await sendWhatsAppMessage(phoneNumber, replyText);
  await logMessage(conversation.id, "outbound", replyText);
}

// ── HTTP handler ────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === "POST") {
    try {
      const contentType = req.headers.get("content-type") || "";
      let phoneNumber = "";
      let text = "";

      if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await req.formData();
        const from = formData.get("From")?.toString() || "";
        phoneNumber = from.replace("whatsapp:", "");
        text = formData.get("Body")?.toString() || "";
      } else {
        const body = await req.json();
        phoneNumber = body.from || body.From || "";
        text = body.body || body.Body || "";
        phoneNumber = phoneNumber.replace("whatsapp:", "");
      }

      if (phoneNumber && text) {
        await processMessage(phoneNumber, text);
      }

      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    } catch (error) {
      console.error("Webhook error:", error);
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { status: 200, headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
