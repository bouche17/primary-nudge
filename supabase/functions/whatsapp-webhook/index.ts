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

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface Child {
  id: string;
  first_name: string;
  year_group: string;
  school_name: string;
  school_id: string;
}

interface MontyContext {
  parentId: string;
  children: Child[];
  childReminders: Array<{
    child_name: string;
    title: string;
    emoji: string;
    day_of_week: string;
  }>;
  upcomingEvents: Array<{
    title: string;
    start_at: string;
    school_name: string;
  }>;
  schoolReminders: Array<{
    title: string;
    emoji: string;
    day_of_week: string;
  }>;
  isOnboarding: boolean;
  onboardingStatus: string;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Context loader ────────────────────────────────────────────────────────────

async function loadParentContext(phone: string): Promise<MontyContext | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("phone_number", phone)
    .maybeSingle();

  if (!profile) return null;

  const parentId = profile.user_id;

  // Load children + schools
  const { data: children } = await supabase
    .from("children")
    .select("id, first_name, year_group, school_id, schools(name)")
    .eq("parent_id", parentId);

  const enrichedChildren: Child[] = (children || []).map((c: any) => ({
    id: c.id,
    first_name: c.first_name,
    year_group: c.year_group,
    school_id: c.school_id,
    school_name: c.schools?.name || "school",
  }));

  const schoolIds = enrichedChildren.map((c) => c.school_id);
  const childIds = enrichedChildren.map((c) => c.id);

  // Load child-specific reminders
  const { data: childRemindersRaw } = childIds.length > 0
    ? await supabase
        .from("child_reminders")
        .select("child_id, title, emoji, day_of_week, children(first_name)")
        .in("child_id", childIds)
        .eq("active", true)
    : { data: [] };

  const childReminders = (childRemindersRaw || []).map((r: any) => ({
    child_name: r.children?.first_name || "Unknown",
    title: r.title,
    emoji: r.emoji,
    day_of_week: r.day_of_week,
  }));

  // Load upcoming school events (next 14 days)
  const now = new Date();
  const twoWeeksAhead = new Date(now);
  twoWeeksAhead.setDate(twoWeeksAhead.getDate() + 14);

  const { data: events } = schoolIds.length > 0
    ? await supabase
        .from("school_events")
        .select("title, start_at, school_id, schools(name)")
        .in("school_id", schoolIds)
        .gte("start_at", now.toISOString())
        .lte("start_at", twoWeeksAhead.toISOString())
        .order("start_at", { ascending: true })
        .limit(20)
    : { data: [] };

  const upcomingEvents = (events || []).map((e: any) => ({
    title: e.title,
    start_at: e.start_at,
    school_name: e.schools?.name || "",
  }));

  // Load school-wide recurring reminders
  const { data: schoolReminders } = schoolIds.length > 0
    ? await supabase
        .from("school_reminders")
        .select("title, emoji, day_of_week")
        .eq("active", true)
        .or(`school_id.in.(${schoolIds.join(",")}),school_id.is.null`)
        .not("day_of_week", "is", null)
    : { data: [] };

  // Check onboarding state
  const { data: onboardingState } = await supabase
    .from("onboarding_state")
    .select("status")
    .eq("phone_number", phone)
    .maybeSingle();

  const onboardingStatus = onboardingState?.status || "complete";
  const isOnboarding = onboardingStatus === "new" || onboardingStatus === "collecting";

  return {
    parentId,
    children: enrichedChildren,
    childReminders,
    upcomingEvents,
    schoolReminders: schoolReminders || [],
    isOnboarding,
    onboardingStatus,
  };
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(context: MontyContext): string {
  const childrenSummary = context.children
    .map((c) => `${c.first_name} (${c.year_group} at ${c.school_name})`)
    .join(", ");

  const childRemindersSummary = context.childReminders.length > 0
    ? context.childReminders
        .map((r) => `• ${r.child_name}: ${r.emoji} ${r.title} — every ${r.day_of_week}`)
        .join("\n")
    : "No personal reminders set up yet.";

  const upcomingEventsSummary = context.upcomingEvents.length > 0
    ? context.upcomingEvents
        .map((e) => {
          const date = new Date(e.start_at).toLocaleDateString("en-GB", {
            weekday: "long", day: "numeric", month: "long",
          });
          return `• ${e.title} — ${date}${e.school_name ? ` (${e.school_name})` : ""}`;
        })
        .join("\n")
    : "No upcoming events in the next 14 days.";

  const schoolRemindersSummary = context.schoolReminders.length > 0
    ? context.schoolReminders
        .map((r) => `• ${r.emoji} ${r.title} — every ${r.day_of_week}`)
        .join("\n")
    : "None set.";

  const onboardingInstructions = context.isOnboarding ? `
## IMPORTANT: This parent is currently being onboarded
You are in the middle of a friendly setup conversation. Your goal is to collect foundational reminders for each child in a natural, conversational way.

Work through each child one at a time. For each child, ask about:
1. PE days 🏃
2. Packed lunch days (or if they always have school dinners) 🥪
3. Forest School day if they have it 🌲
4. Reading book return day 📚
5. Any homework due days 📝

Keep it light and fun. When the parent tells you something, use the save_child_reminder tool to save it immediately, then confirm what you've saved before moving on.

When you've collected the basics for all children, thank them warmly and tell them reminders are all set up. Then update the onboarding status to complete using the complete_onboarding tool.

Children to collect for: ${context.children.map(c => c.first_name).join(", ")}
` : "";

  return `You are Monty 🎒 — a friendly, warm AI assistant who helps UK primary school parents stay on top of their children's school life via WhatsApp.

## Your personality
- Warm and encouraging, like a knowledgeable friend — never corporate, never stiff
- Concise — parents are busy. 3-5 sentences max per message. This is WhatsApp, not email.
- Use occasional emojis naturally (not excessively)
- Proactive — mention relevant upcoming things unprompted
- Honest — never make up information you don't have
- British English always: "mum" not "mom", "autumn term" not "fall semester", "PE kit" not "gym clothes"
- Never sycophantic ("Great question!") — just be natural and helpful

## What you must never do
- Make up school events, dates or information
- Share one parent's information with another  
- Pretend to be human if sincerely asked
- Discuss topics unrelated to school life

## This parent's children
${childrenSummary || "No children set up yet"}

## Personal reminders set up for their children
${childRemindersSummary}

## School-wide recurring reminders
${schoolRemindersSummary}

## Upcoming school events (next 14 days)
${upcomingEventsSummary}

## When a parent asks you to set up or change a reminder
Use the save_child_reminder tool to save it. Always confirm back what you've saved in a friendly way.
Example: Parent says "Jude has PE on Mondays" → save it → reply "Done! 👟 I'll remind you about Jude's PE kit every Sunday evening and Monday morning."

## When a parent responds to the Sunday lunch check-in
Use the save_weekly_lunch_plan tool for each child they mention. Save even if they say "school dinners all week" (just save an empty array for packed_lunch_days).
Example: "Jude needs one Monday and Wednesday, Harry every day" → save Jude: [Monday, Wednesday], Harry: [Monday, Tuesday, Wednesday, Thursday, Friday]

## When a parent tells you about a school event or date
Use the save_parent_note tool to save it so they get a reminder when it comes around.

${onboardingInstructions}

Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.
UK time: ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}.`;
}

// ── AI tools (actions Monty can take) ────────────────────────────────────────

const tools = [
  {
    type: "function",
    function: {
      name: "save_child_reminder",
      description: "Save a recurring reminder for a specific child. Use this when a parent tells you about a regular activity or schedule item for their child.",
      parameters: {
        type: "object",
        properties: {
          child_name: {
            type: "string",
            description: "The first name of the child this reminder is for",
          },
          title: {
            type: "string",
            description: "Short description of the reminder e.g. 'PE kit needed', 'Packed lunch', 'Forest School'",
          },
          emoji: {
            type: "string",
            description: "A relevant emoji e.g. 🏃 for PE, 🥪 for packed lunch, 🌲 for Forest School, 📚 for reading",
          },
          day_of_week: {
            type: "string",
            enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
            description: "The day of the week this reminder applies to",
          },
          reminder_time: {
            type: "string",
            enum: ["morning", "evening", "both"],
            description: "When to send the reminder. Use 'both' for things like PE kit (remind evening before AND morning of). Use 'morning' for most things.",
          },
        },
        required: ["child_name", "title", "emoji", "day_of_week", "reminder_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_parent_note",
      description: "Save a note about a school event or important date the parent has mentioned, so Monty can remind them when it comes around.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief summary of the note e.g. 'School trip to Jodrell Bank'",
          },
          date: {
            type: "string",
            description: "The date in YYYY-MM-DD format",
          },
          child_name: {
            type: "string",
            description: "Which child this is for (optional)",
          },
        },
        required: ["summary", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_weekly_lunch_plan",
      description: "Save which days a child needs a packed lunch for the upcoming week. Use this when a parent responds to the Sunday lunch check-in or tells you about packed lunch days for the week.",
      parameters: {
        type: "object",
        properties: {
          child_name: {
            type: "string",
            description: "The first name of the child",
          },
          packed_lunch_days: {
            type: "array",
            items: {
              type: "string",
              enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
            },
            description: "Which days this child needs a packed lunch. Empty array means school dinners all week.",
          },
        },
        required: ["child_name", "packed_lunch_days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_onboarding",
      description: "Mark onboarding as complete once all foundational reminders have been collected for all children.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  toolArgs: any,
  context: MontyContext,
  phone: string
): Promise<string> {
  if (toolName === "save_child_reminder") {
    const child = context.children.find(
      (c) => c.first_name.toLowerCase() === toolArgs.child_name.toLowerCase()
    );

    if (!child) {
      return `Could not find child named ${toolArgs.child_name}`;
    }

    const { data: existing } = await supabase
      .from("child_reminders")
      .select("id")
      .eq("child_id", child.id)
      .eq("day_of_week", toolArgs.day_of_week)
      .eq("title", toolArgs.title)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("child_reminders")
        .update({
          emoji: toolArgs.emoji,
          reminder_time: toolArgs.reminder_time,
          active: true,
        })
        .eq("id", existing.id);
      return `Updated reminder for ${toolArgs.child_name}: ${toolArgs.title} on ${toolArgs.day_of_week}`;
    } else {
      const { error } = await supabase.from("child_reminders").insert({
        child_id: child.id,
        parent_id: context.parentId,
        title: toolArgs.title,
        emoji: toolArgs.emoji,
        day_of_week: toolArgs.day_of_week,
        reminder_time: toolArgs.reminder_time,
        active: true,
      });

      if (error) {
        console.error("Error saving reminder:", error);
        return `Error saving reminder: ${error.message}`;
      }
      return `Saved reminder for ${toolArgs.child_name}: ${toolArgs.title} on ${toolArgs.day_of_week}`;
    }
  }

  if (toolName === "save_parent_note") {
    const { error } = await supabase.from("parent_notes").insert({
      phone_number: phone,
      raw_content: toolArgs.summary,
      summary: toolArgs.summary,
      extracted_dates: [{ date: toolArgs.date }],
      source_type: "whatsapp",
    });

    if (error) {
      console.error("Error saving note:", error);
      return `Error saving note: ${error.message}`;
    }
    return `Saved note: ${toolArgs.summary} on ${toolArgs.date}`;
  }

  if (toolName === "save_weekly_lunch_plan") {
    const child = context.children.find(
      (c) => c.first_name.toLowerCase() === toolArgs.child_name.toLowerCase()
    );

    if (!child) {
      return `Could not find child named ${toolArgs.child_name}`;
    }

    const now = new Date();
    const day = now.getDay();
    const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + daysUntilMonday);
    monday.setHours(0, 0, 0, 0);
    const weekStart = monday.toISOString().split("T")[0];

    const { error } = await supabase
      .from("weekly_lunch_plans")
      .upsert({
        child_id: child.id,
        parent_id: context.parentId,
        week_start: weekStart,
        packed_lunch_days: toolArgs.packed_lunch_days,
      }, { onConflict: "child_id,week_start" });

    if (error) {
      console.error("Error saving lunch plan:", error);
      return `Error saving lunch plan: ${error.message}`;
    }

    const days = toolArgs.packed_lunch_days;
    if (days.length === 0) {
      return `Saved: ${toolArgs.child_name} has school dinners all week`;
    }
    return `Saved: ${toolArgs.child_name} needs packed lunch on ${days.join(", ")}`;
  }

  if (toolName === "complete_onboarding") {
    await supabase
      .from("onboarding_state")
      .update({ status: "complete" })
      .eq("phone_number", phone);
    return "Onboarding marked as complete";
  }

  return "Unknown tool";
}

// ── AI reply generator ────────────────────────────────────────────────────────

async function generateReply(
  incomingMessage: string,
  history: ConversationMessage[],
  context: MontyContext,
  phone: string
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: incomingMessage },
  ];

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      max_tokens: 500,
      messages,
      tools,
      tool_choice: "auto",
    }),
  });

  if (!response.ok) {
    console.error("AI error:", await response.text());
    return "Sorry, I had a little hiccup there! Try again in a moment 😊";
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  if (choice?.finish_reason === "tool_calls" && choice?.message?.tool_calls) {
    const toolResults = [];

    for (const toolCall of choice.message.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);
      console.log(`Executing tool: ${toolName}`, toolArgs);

      const result = await executeTool(toolName, toolArgs, context, phone);
      console.log(`Tool result: ${result}`);

      toolResults.push({
        tool_call_id: toolCall.id,
        role: "tool",
        content: result,
      });
    }

    const followUpResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        max_tokens: 400,
        messages: [
          ...messages,
          choice.message,
          ...toolResults,
        ],
      }),
    });

    if (!followUpResponse.ok) {
      console.error("Follow-up AI error:", await followUpResponse.text());
      return "Done! I've saved that for you 😊";
    }

    const followUpData = await followUpResponse.json();
    return followUpData.choices?.[0]?.message?.content?.trim() ||
      "Done! I've saved that for you 😊";
  }

  return choice?.message?.content?.trim() ||
    "Sorry, I had a little hiccup there! Try again in a moment 😊";
}

// ── Conversation helpers ──────────────────────────────────────────────────────

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

// ── Onboarding initiator ──────────────────────────────────────────────────────

async function handleNewParent(phone: string, context: MontyContext): Promise<string> {
  const childNames = context.children.map((c) => c.first_name).join(" and ");
  const schoolName = context.children[0]?.school_name || "school";

  await supabase
    .from("onboarding_state")
    .upsert({ phone_number: phone, status: "collecting" });

  return `Hi! 👋 I'm Monty — your school reminder assistant! I can see you've added ${childNames} at ${schoolName}. 

To get started, I'd love to set up some personal reminders for ${context.children.length > 1 ? "your children" : "them"}.

Let's start with ${context.children[0].first_name} — what day do they have PE? 🏃`;
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

    const [context, conversationId] = await Promise.all([
      loadParentContext(from),
      getOrCreateConversation(from),
    ]);

    if (!context) {
      const reply = `Hi! 👋 I'm Monty, a school reminder assistant for UK primary school parents. To get set up, head to primary-nudge.lovable.app and create your account — it only takes a minute!`;
      await saveMessage(conversationId, "inbound", incomingMessage);
      await saveMessage(conversationId, "outbound", reply);
      await sendWhatsApp(from, reply);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
        { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    }

    await saveMessage(conversationId, "inbound", incomingMessage);

    let reply: string;

    if (context.onboardingStatus === "new") {
      reply = await handleNewParent(from, context);
    } else {
      const history = await getRecentHistory(conversationId, 10);
      reply = await generateReply(incomingMessage, history, context, from);
    }

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

