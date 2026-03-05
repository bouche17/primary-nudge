import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Monty's Tone of Voice System Prompt ──────────────────────────────────────

function buildSystemPrompt(context: MontyContext): string {
  const childrenSummary = context.children
    .map((c) => `${c.first_name} (${c.year_group} at ${c.school_name})`)
    .join(", ");

  const upcomingEventsSummary =
    context.upcomingEvents.length > 0
      ? context.upcomingEvents
          .map((e) => {
            const date = new Date(e.start_at).toLocaleDateString("en-GB", {
              weekday: "long", day: "numeric", month: "long",
            });
            return `• ${e.title} — ${date}${e.school_name ? ` (${e.school_name})` : ""}`;
          })
          .join("\n")
      : "No upcoming events in the next 14 days.";

  const remindersSummary =
    context.reminders.length > 0
      ? context.reminders
          .map((r) => `• ${r.emoji} ${r.title} — every ${r.day_of_week}`)
          .join("\n")
      : "No recurring reminders set up yet.";

  return `You are Monty 🎒 — a friendly, warm AI assistant who helps UK primary school parents stay on top of their children's school life.

## Your personality
- You're like a knowledgeable, reassuring friend — never corporate, never stiff
- Warm and encouraging, but always concise. Parents are busy. Don't waffle.
- You use occasional emojis naturally (not excessively). Think how a friendly person texts.
- You're proactive — if you spot something relevant in the upcoming events, mention it helpfully
- You never panic parents or make them feel bad for forgetting things
- You speak British English. "Mum" not "Mom". "Autumn term" not "Fall semester".
- You never make up information. If you don't know something, say so honestly and warmly.
- Keep responses short — this is WhatsApp, not email. 3-5 sentences is usually perfect.

## What you must never do
- Never pretend to be human if directly asked
- Never discuss topics unrelated to school life, parenting reminders, or the parent's children
- Never share one parent's information with another
- Never make up school events or dates you don't have data for
- Never be sycophantic ("Great question!") — just answer naturally

## This parent's information
Children: ${childrenSummary || "Not set up yet"}

## Upcoming school events (next 14 days)
${upcomingEventsSummary}

## Recurring reminders
${remindersSummary}

## How to handle common requests
- "What's on this week?" → List upcoming events for their children's schools in a friendly way
- "Does [child] have PE today/tomorrow?" → Check reminders and events, answer directly
- "Remind me about X" → Explain they can forward school emails/newsletters to you and you'll extract the dates
- "When is [event]?" → Search upcoming events, be honest if you don't have the data
- "What's for lunch?" → Explain you don't have the school menu yet but it's coming soon
- If they forward school newsletter text → Extract dates and key info, summarise clearly

Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.
The current time in the UK is approximately ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}.`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MontyContext {
  children: Array<{
    first_name: string;
    year_group: string;
    school_name: string;
    school_id: string;
  }>;
  upcomingEvents: Array<{
    title: string;
    start_at: string;
    school_name: string;
  }>;
  reminders: Array<{
    title: string;
    emoji: string;
    day_of_week: string;
  }>;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Context loader ────────────────────────────────────────────────────────────

async function loadParentContext(phone: string): Promise<MontyContext> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("phone_number", phone)
    .maybeSingle();

  if (!profile) return { children: [], upcomingEvents: [], reminders: [] };

  const { data: children } = await supabase
    .from("children")
    .select("first_name, year_group, school_id, schools(name)")
    .eq("parent_id", profile.user_id);

  const enrichedChildren = (children || []).map((c: any) => ({
    first_name: c.first_name,
    year_group: c.year_group,
    school_id: c.school_id,
    school_name: c.schools?.name || "school",
  }));

  const schoolIds = enrichedChildren.map((c) => c.school_id);

  const now = new Date();
  const twoWeeksAhead = new Date(now);
  twoWeeksAhead.setDate(twoWeeksAhead.getDate() + 14);

  let upcomingEvents: Array<{ title: string; start_at: string; school_name: string }> = [];
  let reminders: Array<{ title: string; emoji: string; day_of_week: string }> = [];

  if (schoolIds.length > 0) {
    const { data: events } = await supabase
      .from("school_events")
      .select("title, start_at, school_id, schools(name)")
      .in("school_id", schoolIds)
      .gte("start_at", now.toISOString())
      .lte("start_at", twoWeeksAhead.toISOString())
      .order("start_at", { ascending: true })
      .limit(20);

    upcomingEvents = (events || []).map((e: any) => ({
      title: e.title,
      start_at: e.start_at,
      school_name: e.schools?.name || "",
    }));

    const { data: reminderData } = await supabase
      .from("school_reminders")
      .select("title, emoji, day_of_week")
      .eq("active", true)
      .or(`school_id.in.(${schoolIds.join(",")}),school_id.is.null`)
      .not("day_of_week", "is", null);

    reminders = reminderData || [];
  }

  return { children: enrichedChildren, upcomingEvents, reminders };
}

// ── Conversation manager ──────────────────────────────────────────────────────

async function getOrCreateConversation(phone: string): Promise<string> {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("phone_number", phone)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created } = await supabase
    .from("conversations")
    .insert({ phone_number: phone, current_step: "active" })
    .select("id")
    .single();

  return created!.id;
}

async function getRecentHistory(conversationId: string, limit = 10): Promise<ConversationMessage[]> {
  const { data: messages } = await supabase
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (messages || [])
    .reverse()
    .map((m: any) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: m.content,
    }));
}

async function saveMessage(
  conversationId: string,
  direction: "inbound" | "outbound",
  content: string
) {
  await supabase.from("messages").insert({
    conversation_id: conversationId,
    direction,
    content,
  });
}

// ── AI reply generator ────────────────────────────────────────────────────────

async function generateReply(
  incomingMessage: string,
  history: ConversationMessage[],
  context: MontyContext
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history,
    { role: "user" as const, content: incomingMessage },
  ];

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      max_tokens: 400,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("AI error:", err);
    throw new Error(`AI request failed: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ||
    "Sorry, I had a little hiccup there! Try again in a moment 😊";
}

// ── WhatsApp sender ───────────────────────────────────────────────────────────

async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("Body", body);

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

  if (!res.ok) console.error("Twilio send error:", await res.text());
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.text();
    const params = new URLSearchParams(body);

    const from = params.get("From")?.replace("whatsapp:", "") || "";
    const incomingMessage = params.get("Body")?.trim() || "";

    if (!from || !incomingMessage) {
      return new Response("Missing From or Body", { status: 400 });
    }

    console.log(`Inbound from ${from}: "${incomingMessage}"`);

    const [conversationId, context] = await Promise.all([
      getOrCreateConversation(from),
      loadParentContext(from),
    ]);

    await saveMessage(conversationId, "inbound", incomingMessage);

    const history = await getRecentHistory(conversationId, 10);

    const reply = await generateReply(incomingMessage, history, context);

    await saveMessage(conversationId, "outbound", reply);
    await sendWhatsApp(from, reply);

    console.log(`Replied to ${from}: "${reply.slice(0, 80)}…"`);

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { status: 200, headers: { "Content-Type": "text/xml" } }
    );
  }
});
