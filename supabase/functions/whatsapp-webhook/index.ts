import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

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
- Use occasional emojis naturally — one per message maximum, never as punctuation at the end of a sentence
- Proactive — mention relevant upcoming things unprompted
- Honest — never make up information you don't have
- British English always: "mum" not "mom", "autumn term" not "fall semester", "PE kit" not "gym clothes"
- Never sycophantic ("Great question!") — just be natural and helpful
- Always refer to children by their first name, never use pronouns like "their", "his", "her", "they" — e.g. say "Jude's PE kit" not "their PE kit"

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

## When a parent forwards a message or pastes text from a WhatsApp group or school email
This is one of the most useful things you can do. The parent may say "just got this in the school group:" or "school emailed this:" or simply paste a chunk of text.
- Read it carefully and extract ANY dates, events, deadlines or action items
- If the message mentions a specific year group, automatically attribute it to the correct child using the children list above — NEVER ask the parent which child it's for
- Even if the event is for multiple year groups (e.g. "Year 1 and Year 2"), check if ANY of the parent's children are in those year groups and attribute accordingly
- Always pass child_name to save_parent_note when you can identify the child
- Confirm back exactly what you extracted, saved, and which child it's for by first name
- If something is ambiguous (e.g. "next Friday") clarify which date you've assumed
- If there's nothing actionable, let them know warmly
Example: Parent forwards "Year 1 and Year 2 — Earth Day litter pick Wednesday 22nd April, leaving at 1:15pm."
→ Harry is in Year 2 → save note with child_name="Harry"
→ Reply: "Got it! I've saved the Earth Day litter pick for Harry on Wednesday 22nd April — leaving at 1:15pm."

${onboardingInstructions}

Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.
UK time: ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}.`;
}

// ── AI tools (actions Monty can take) ────────────────────────────────────────
// Claude API uses a different tool format to OpenAI/Gemini

const tools = [
  {
    name: "save_child_reminder",
    description: "Save a recurring reminder for a specific child. Use this when a parent tells you about a regular activity or schedule item for their child.",
    input_schema: {
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
  {
    name: "save_parent_note",
    description: "Save a note about a school event or important date the parent has mentioned, so Monty can remind them when it comes around.",
    input_schema: {
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
  {
    name: "save_weekly_lunch_plan",
    description: "Save which days a child needs a packed lunch for the upcoming week. Use this when a parent responds to the Sunday lunch check-in or tells you about packed lunch days for the week.",
    input_schema: {
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
  {
    name: "complete_onboarding",
    description: "Mark onboarding as complete once all foundational reminders have been collected for all children.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
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
    // Find the child by name
    const child = context.children.find(
      (c) => c.first_name.toLowerCase() === toolArgs.child_name.toLowerCase()
    );

    if (!child) {
      return `Could not find child named ${toolArgs.child_name}`;
    }

    // Check if reminder already exists for this child/day/title
    const { data: existing } = await supabase
      .from("child_reminders")
      .select("id")
      .eq("child_id", child.id)
      .eq("day_of_week", toolArgs.day_of_week)
      .eq("title", toolArgs.title)
      .maybeSingle();

    if (existing) {
      // Update existing
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
      // Insert new
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
      child_name: toolArgs.child_name || null,
    });

    if (error) {
      console.error("Error saving note:", error);
      return `Error saving note: ${error.message}`;
    }
    return `Saved note: ${toolArgs.summary} on ${toolArgs.date}${toolArgs.child_name ? ` for ${toolArgs.child_name}` : ""}`;
  }

  if (toolName === "save_weekly_lunch_plan") {
    const child = context.children.find(
      (c) => c.first_name.toLowerCase() === toolArgs.child_name.toLowerCase()
    );

    if (!child) {
      return `Could not find child named ${toolArgs.child_name}`;
    }

    // Work out the Monday of the upcoming week
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

  // Claude API uses messages without system role — system is a top-level param
  // Convert history to Claude format (user/assistant only)
  const messages = [
    ...history.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: "user", content: incomingMessage },
  ];

  // First API call to Claude
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: systemPrompt,
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    console.error("Claude API error:", await response.text());
    return "Sorry, I had a little hiccup there! Try again in a moment 😊";
  }

  const data = await response.json();

  // Claude returns stop_reason "tool_use" when it wants to call a tool
  if (data.stop_reason === "tool_use") {
    const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use");
    const toolResults = [];

    for (const toolBlock of toolUseBlocks) {
      const toolName = toolBlock.name;
      const toolArgs = toolBlock.input;
      console.log(`Executing tool: ${toolName}`, toolArgs);

      const result = await executeTool(toolName, toolArgs, context, phone);
      console.log(`Tool result: ${result}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: result,
      });
    }

    // Second API call with tool results to get final conversational reply
    const followUpResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: "assistant", content: data.content },
          { role: "user", content: toolResults },
        ],
      }),
    });

    if (!followUpResponse.ok) {
      console.error("Claude follow-up error:", await followUpResponse.text());
      return "Done! I've saved that for you 😊";
    }

    const followUpData = await followUpResponse.json();
    const textBlock = followUpData.content?.find((b: any) => b.type === "text");
    return textBlock?.text?.trim() || "Done! I've saved that for you 😊";
  }

  // No tool use — just return the text response
  const textBlock = data.content?.find((b: any) => b.type === "text");
  return textBlock?.text?.trim() ||
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
// This is called when a parent first signs up via the web app
// It sends them a welcome WhatsApp and kicks off onboarding

async function handleNewParent(phone: string, context: MontyContext): Promise<string> {
  const childNames = context.children.map((c) => c.first_name).join(" and ");
  const schoolName = context.children[0]?.school_name || "school";

  // Mark as collecting
  await supabase
    .from("onboarding_state")
    .upsert({ phone_number: phone, status: "collecting" });

  return `Hi! 👋 I'm Monty — your school reminder assistant! I can see you've added ${childNames} at ${schoolName}. 

To get started, I'd love to set up some personal reminders for ${context.children.length > 1 ? "your children" : "them"}.

Let's start with ${context.children[0].first_name} — what day do they have PE? 🏃`;
}

// ── Image type checker ────────────────────────────────────────────────────────

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

// ── Image message handler ─────────────────────────────────────────────────────
// Downloads the image from Twilio, converts to base64, sends to Claude vision
// Claude reads the image and extracts dates/events, saves them as parent_notes

async function handleImageMessage(
  mediaUrl: string,
  mediaType: string,
  caption: string,
  context: MontyContext,
  phone: string
): Promise<string> {
  try {
    console.log("Fetching image from Twilio:", mediaUrl);

    // Fetch image from Twilio (requires auth)
    const imageRes = await fetch(mediaUrl, {
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      },
    });

    if (!imageRes.ok) {
      console.error("Failed to fetch image:", imageRes.status);
      return "I couldn't read that image — could you try forwarding it again, or copy and paste the text instead? 😊";
    }

    const imageBuffer = await imageRes.arrayBuffer();
    const imageBase64 = btoa(String.fromCharCode(...new Uint8Array(imageBuffer)));

    const childNames = context.children.map((c) => c.first_name).join(" and ");
    const childrenWithYearGroups = context.children
      .map((c) => `${c.first_name} (${c.year_group || "unknown year"})`)
      .join(", ");
    console.log("Children with year groups:", childrenWithYearGroups);
    const today = new Date().toISOString().split("T")[0];

    // Build Claude vision request
    const systemPrompt = `You are Monty, a friendly school reminder assistant. A parent has forwarded you an image — likely a screenshot from a school WhatsApp group, a photo of a school letter, or a school email screenshot.

Your job is to:
1. Read the image carefully
2. Extract ANY dates, events, deadlines, or action items relevant to school life
3. For each item found, call the save_parent_note tool to save it — include the child_name if you can identify which child it's for
4. Reply confirming EXACTLY what you found and saved — be specific (event name, date, time if visible, which child)

The parent's children and their year groups: ${childrenWithYearGroups}
Today's date is: ${today}

## Year group attribution — IMPORTANT
If the event or message mentions a specific year group, automatically attribute it to the correct child:
- Match "Year 1", "Y1", "Yr1" etc. to the child in that year group
- Match "Year 2", "Y2" etc. to the child in Year 2
- If an event is for multiple year groups (e.g. "Year 1 and Year 2"), check ALL year groups against the parent's children — if ANY of the parent's children are in those year groups, attribute it to them
- In this parent's case: if the event mentions Year 2, save it for Harry. If it mentions Year 5, save it for Jude. If it mentions both Year 2 and Year 5, save it for both.
- Never save a note without a child_name if you can identify which child it belongs to
- Never ask the parent which child — figure it out from the year group information above
- If no year group is mentioned, or the year group doesn't match any of the parent's children, save as a general note without child_name

## Confirmation style
- Always state specifically what you saved: event name, date, time, and which child it's for
- Good: "Got it! I've saved the Earth Day litter pick for Harry on Wednesday 22nd April — leaving at 1:15pm. They'll need outdoor clothing and walking footwear."
- Bad: "Done! I've saved that for you 😊"
- Use ONE emoji at most, only if it naturally fits — never as punctuation at the end
- Keep it to 2-3 sentences max
- British English always
- Use the child's first name, never pronouns like "they/their" if you know which child it is

If you can't find any actionable dates or events, let the parent know warmly.
If the image is unclear or unreadable, ask them to try again.`;

    const userContent = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: imageBase64,
        },
      },
    ];

    // Add caption as text if parent included one
    if (caption) {
      userContent.push({
        type: "text",
        source: undefined,
        // @ts-ignore
        text: caption,
      } as any);
    } else {
      userContent.push({
        type: "text",
        source: undefined,
        // @ts-ignore
        text: "I've forwarded this from the school WhatsApp group — can you save any important dates?",
      } as any);
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        tools,
      }),
    });

    if (!response.ok) {
      console.error("Claude vision error:", await response.text());
      return "I had trouble reading that image. Could you try forwarding it again? 😊";
    }

    const data = await response.json();

    // Handle tool use — save extracted dates
    if (data.stop_reason === "tool_use") {
      const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use");

      // Get all text Claude extracted from the image — use this for year group detection
      const claudeExtractedText = data.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(" ");


      const toolResults = [];

      for (const toolBlock of toolUseBlocks) {
        // For save_parent_note, auto-inject child_name based on year group detection
        if (toolBlock.name === "save_parent_note" && !toolBlock.input.child_name) {
          // Check the note summary AND Claude's full extracted text for year groups
          const searchText = `${toolBlock.input.summary || ""} ${claudeExtractedText}`;
          const matchedChildren = detectYearGroupChildren(searchText, context.children);

          if (matchedChildren.length >= 1) {
            toolBlock.input.child_name = matchedChildren[0];
            console.log(`Image: Auto-attributed note to: ${matchedChildren[0]}`);
          }
        }

        const result = await executeTool(toolBlock.name, toolBlock.input, context, phone);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: result,
        });
      }

      // Build explicit child attribution hint for the follow-up
      const attributedChildren = toolUseBlocks
        .filter((b: any) => b.name === "save_parent_note" && b.input.child_name)
        .map((b: any) => b.input.child_name);
      const uniqueChildren = [...new Set(attributedChildren)];

      const childHint = uniqueChildren.length > 0
        ? ` The note was saved specifically for ${uniqueChildren.join(" and ")}. In your reply, refer to them by name rather than saying "Year 1 and Year 2".`
        : "";

      // Get final reply after saving
      const followUp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 400,
          system: systemPrompt + childHint,
          messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: data.content },
            { role: "user", content: toolResults },
          ],
        }),
      });

      const followUpData = await followUp.json();
      const textBlock = followUpData.content?.find((b: any) => b.type === "text");
      return textBlock?.text?.trim() || "Done! I've saved those dates for you 😊";
    }

    // No tool use — Claude couldn't find anything or image was unreadable
    const textBlock = data.content?.find((b: any) => b.type === "text");
    return textBlock?.text?.trim() || "I couldn't find any dates in that image — could you try sending the text instead? 😊";

  } catch (err) {
    console.error("Image handling error:", err);
    return "I had trouble reading that image. Could you try forwarding the text instead? 😊";
  }
}

// ── Year group pre-processor ──────────────────────────────────────────────────
// Detects year group mentions in text and returns matching children
// This runs in code rather than relying on the AI to figure it out

function detectYearGroupChildren(
  text: string,
  children: Array<{ first_name: string; year_group: string }>
): string[] {
  const lowerText = text.toLowerCase();
  const matchedChildren: string[] = [];

  for (const child of children) {
    if (!child.year_group) continue;

    // Extract year number e.g. "Year 5" → "5"
    const yearMatch = child.year_group.match(/(\d+)/);
    if (!yearMatch) continue;
    const yearNum = yearMatch[1];

    // Check various formats: Year 2, Y2, Yr2, year2
    const patterns = [
      new RegExp(`\\byear\\s*${yearNum}\\b`, "i"),
      new RegExp(`\\by${yearNum}\\b`, "i"),
      new RegExp(`\\byr\\s*${yearNum}\\b`, "i"),
    ];

    if (patterns.some((p) => p.test(lowerText))) {
      matchedChildren.push(child.first_name);
    }
  }

  return matchedChildren;
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
    const numMedia = parseInt(params.get("NumMedia") || "0");
    const mediaUrl = params.get("MediaUrl0") || "";
    const mediaType = params.get("MediaContentType0") || "";

    if (!from) {
      return new Response("Missing From", { status: 400 });
    }

    if (!incomingMessage && numMedia === 0) {
      return new Response("Missing Body and Media", { status: 400 });
    }

    console.log(`Inbound from ${from}: "${incomingMessage}" (media: ${numMedia})`);

    // Load context and conversation in parallel
    const [context, conversationId] = await Promise.all([
      loadParentContext(from),
      getOrCreateConversation(from),
    ]);

    // Parent not found in system
    if (!context) {
      const reply = `Hi! 👋 I'm Monty, a school reminder assistant for UK primary school parents. To get set up, head to primary-nudge.lovable.app and create your account — it only takes a minute!`;
      await saveMessage(conversationId, "inbound", incomingMessage || "[image]");
      await saveMessage(conversationId, "outbound", reply);
      await sendWhatsApp(from, reply);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
        { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
      );
    }

    // Save inbound message
    await saveMessage(conversationId, "inbound", incomingMessage || "[image forwarded]");

    let reply: string;

    // New parent — kick off onboarding
    if (context.onboardingStatus === "new") {
      reply = await handleNewParent(from, context);
    } else if (numMedia > 0 && mediaUrl && isImageType(mediaType)) {
      // Parent forwarded an image/screenshot
      reply = await handleImageMessage(mediaUrl, mediaType, incomingMessage, context, from);
    } else {
      // Pre-process text to detect year group mentions and inject child names
      // This ensures Claude always knows which child to attribute events to
      let processedMessage = incomingMessage;
      if (context.children.length > 0) {
        const matchedChildren = detectYearGroupChildren(incomingMessage, context.children);
        if (matchedChildren.length > 0) {
          const childList = matchedChildren.join(" and ");
          processedMessage = `${incomingMessage}\n\n[System note: Based on year groups mentioned, this is relevant to: ${childList}. Please save notes with child_name set accordingly.]`;
          console.log(`Year group pre-processor matched: ${childList}`);
        }
      }

      // Normal text conversation
      const history = await getRecentHistory(conversationId, 10);
      reply = await generateReply(processedMessage, history, context, from);
    }

    // Save and send reply
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