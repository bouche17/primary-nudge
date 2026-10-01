import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";

// ── Twilio Signature Validation ──────────────────────────────────────────────

async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  // Build the data string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  // HMAC-SHA1
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const computed = encodeBase64(new Uint8Array(sig));

  return computed === signature;
}

// ── Config ────────────────────────────────────────────────────────────────────

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const TWILIO_PARTNER_REMINDER_TEMPLATE_SID = Deno.env.get("TWILIO_PARTNER_REMINDER_TEMPLATE_SID");
const TWILIO_PARTNER_NOTE_TEMPLATE_SID = Deno.env.get("TWILIO_PARTNER_NOTE_TEMPLATE_SID");
const TWILIO_PARTNER_LUNCH_TEMPLATE_SID = Deno.env.get("TWILIO_PARTNER_LUNCH_TEMPLATE_SID");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function logClaudeFailure(
  phone: string,
  statusCode: number,
  errorBody: string,
  context: string
) {
  try {
    await supabase.from("message_send_failures").insert({
      function_name: "whatsapp-webhook",
      phone_number: phone,
      period: null,
      status_code: statusCode,
      error_body: errorBody,
      context,
    });
  } catch (logError) {
    console.error("Failed to log Claude API failure:", logError);
  }
}

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
  upcomingNotes: Array<{
    summary: string;
    child_name: string | null;
    extracted_dates: string[];
  }>;
  lunchPlans: Array<{ child_name: string; week_start: string; packed_lunch_days: string[] }>;
  lunchWeeks: string[];
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

  // Resolve the full family: the caller plus anyone linked via accepted linked_accounts
  const { data: linkedRows } = await supabase
    .from("linked_accounts")
    .select("primary_user_id, linked_user_id")
    .eq("status", "accepted")
    .or(`primary_user_id.eq.${parentId},linked_user_id.eq.${parentId}`);

  const familyUserIds = new Set<string>([parentId]);
  for (const row of linkedRows || []) {
    familyUserIds.add(row.primary_user_id);
    familyUserIds.add(row.linked_user_id);
  }

  // Load children + schools across the whole family
  const { data: children } = await supabase
    .from("children")
    .select("id, first_name, year_group, school_id, schools(name)")
    .in("parent_id", Array.from(familyUserIds));

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

  // Load parent-saved notes with a date in the next 14 days
  const { data: notesRaw } = await supabase
    .from("parent_notes")
    .select("summary, child_name, extracted_dates, created_at")
    .eq("phone_number", phone)
    .order("created_at", { ascending: false })
    .limit(20);

  const upcomingNotes = (notesRaw || [])
    .filter((n: any) => {
      const dates = Array.isArray(n.extracted_dates) ? n.extracted_dates : [];
      return dates.some((d: any) => {
        const dateStr = typeof d === "string" ? d : d?.date;
        if (!dateStr) return false;
        const dObj = new Date(dateStr);
        return !isNaN(dObj.getTime()) && dObj >= now && dObj <= twoWeeksAhead;
      });
    })
    .map((n: any) => ({
      summary: n.summary,
      child_name: n.child_name || null,
      extracted_dates: (Array.isArray(n.extracted_dates) ? n.extracted_dates : [])
        .map((d: any) => (typeof d === "string" ? d : d?.date))
        .filter((d: any) => typeof d === "string"),
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

  // Saved packed lunch plans for this and next UK week
  const ukTodayIso = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const ukNoon = new Date(ukTodayIso + "T12:00:00Z");
  const dow = ukNoon.getUTCDay();
  const thisMon = new Date(ukNoon);
  thisMon.setUTCDate(ukNoon.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  const nextMon = new Date(thisMon);
  nextMon.setUTCDate(thisMon.getUTCDate() + 7);
  const lunchWeeks = [thisMon.toISOString().split("T")[0], nextMon.toISOString().split("T")[0]];
  const { data: lunchRaw } = childIds.length > 0
    ? await supabase
        .from("weekly_lunch_plans")
        .select("child_id, week_start, packed_lunch_days")
        .in("child_id", childIds)
        .in("week_start", lunchWeeks)
    : { data: [] };
  const lunchPlans = (lunchRaw || []).map((p: any) => ({
    child_name: enrichedChildren.find((c) => c.id === p.child_id)?.first_name || "",
    week_start: p.week_start,
    packed_lunch_days: (p.packed_lunch_days || []) as string[],
  }));

  return {
    parentId,
    children: enrichedChildren,
    childReminders,
    upcomingEvents,
    upcomingNotes,
    lunchPlans,
    lunchWeeks,
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

  const upcomingNotesSummary = context.upcomingNotes.length > 0
    ? context.upcomingNotes
      .map((n) => {
        const childPrefix = n.child_name ? `${n.child_name}: ` : "";
        const dateStr = n.extracted_dates
          .map((d) =>
            new Date(d).toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })
          )
          .join(", ");
        return `• ${childPrefix}${n.summary}${dateStr ? ` — ${dateStr}` : ""}`;
      })
      .join("\n")
    : "No notes saved yet.";

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

  // ── Authoritative UK date anchors ──
  const nowDate = new Date();
  const ukTime = nowDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  const ukIso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const ukLong = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
  const todayIsoUK = ukIso(nowDate);
  const noonOf = (iso: string, addDays: number) => {
    const d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + addDays);
    return d;
  };
  const tomorrowD = noonOf(todayIsoUK, 1);
  const next7 = Array.from({ length: 7 }, (_, i) => {
    const d = noonOf(todayIsoUK, i + 1);
    return `- ${d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })} → ${d.toISOString().split("T")[0]}`;
  }).join("\n");

  const shortDay: Record<string, string> = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri" };
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const lunchLines: string[] = [];
  for (const wk of context.lunchWeeks) {
    const wkLabel = new Date(wk + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    for (const c of context.children) {
      const plan = context.lunchPlans.find((p) => p.child_name === c.first_name && p.week_start === wk);
      let desc: string;
      if (!plan) desc = "nothing saved";
      else if (!plan.packed_lunch_days || plan.packed_lunch_days.length === 0) desc = "school dinners all week";
      else desc = "packed lunch " + dayOrder.filter((d) => plan.packed_lunch_days.includes(d)).map((d) => shortDay[d]).join(", ");
      lunchLines.push(`• ${c.first_name} — week of ${wkLabel}: ${desc}`);
    }
  }
  const lunchPlansSummary = lunchLines.length > 0 ? lunchLines.join("\n") : "No children registered.";

  return `You are Monty 🎒 — a friendly, warm AI assistant who helps UK school parents stay on top of their children's school life via WhatsApp.

## Right now (authoritative — trust this over anything in the chat history)
- Current UK time: ${ukTime}
- Today: ${ukLong(nowDate)} (${todayIsoUK})
- Tomorrow: ${tomorrowD.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })} (${tomorrowD.toISOString().split("T")[0]})
- Next 7 days:
${next7}
Earlier messages in the chat history may refer to "tomorrow" or "this week" relative to an older date — always resolve relative dates using the anchors above, never from past messages.

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

## HARD RULE — never claim something is "already saved" yourself
- You must NEVER decide from the lists above that something is already saved, covered, down, or set. Duplicate checks are done by the save tools against the database.
- Whenever a parent tells you about something for a child on a date (an activity, kit, event, packed lunch), ALWAYS call the matching save tool (save_parent_note, save_weekly_lunch_plan or save_child_reminder). Only say "already saved" if the tool result starts with "ALREADY_SAVED:".
- A different activity on the same day is a NEW item (e.g. "gymnastics" is not "PE kit"; packed lunch Wednesday is not packed lunch Monday).
- If the tool result contains "POSSIBLE_DUPLICATE", ask the parent whether it's the same thing — don't claim either way.
- If the result contains "NOT SAVED", tell the parent plainly it didn't save. Only confirm a save when the result says "Saved".

## Upcoming school events (next 14 days)
${upcomingEventsSummary}

IMPORTANT: This events list is purely informational — it helps you answer questions like "what's coming up", but it does NOT mean a reminder will automatically be sent for any of these events. The real reminders are the "Personal reminders set up for their children", "School-wide recurring reminders", and "Things this parent has told you about" sections above. If a parent explicitly asks to be reminded about something that only appears in this events list (and isn't already covered by an existing personal reminder, school-wide reminder, or parent note with a matching date), you MUST call save_parent_note with the correct child_name and date to actually create a real reminder. Never tell a parent something is "already saved" or "already covered" just because it appears in this passive events list.

## Things this parent has told you about (upcoming)
${upcomingNotesSummary}

## When a parent asks you to set up or change a reminder
Use the save_child_reminder tool to save it. Always confirm back what you've saved in a friendly way.

## Reminder timing — always describe it accurately
When confirming a saved reminder, packed lunch or note, describe the timing accurately: packed lunches and notes always get a reminder the evening before AND the morning of. For save_child_reminder, describe it based on the reminder_time you set ("both" = evening before and morning of). Never say "I'll remind you in the morning" unless the reminder is genuinely morning-only.
Evening reminders go out at 6pm UK time the evening before; morning reminders at 7am UK time on the day. Use the current UK time above: if it's after 6pm and the item is for tomorrow, do NOT promise an evening reminder — say you'll remind them at 7am tomorrow (your confirmation now counts as tonight's heads-up). If it's for today and after 7am, say it's saved but today's reminders have already gone out.

## Packed lunches already saved
${lunchPlansSummary}

Only say a packed lunch is "already saved" if it appears in this section for that exact date. If a parent tells you a child needs a packed lunch on a day, always call save_weekly_lunch_plan with mode 'add' (it's safe even if already saved) and confirm the specific day and date back.

## HARD RULE — fortnightly / every-other reminders
- If a parent describes a reminder as "fortnightly", "every other [day]", "alternate weeks" or similar, you MUST call save_child_reminder with recurrence_interval=2 AND a real anchor_date (YYYY-MM-DD) that the parent has actually given or clearly stated (e.g. "the next one is 2nd October").
- If the parent has NOT given a specific confirmed date, do NOT call save_child_reminder at all yet. Ask them first: "When's the next one?" — then save once they answer.
- NEVER save a fortnightly reminder as weekly (recurrence_interval=1) as a stopgap. NEVER guess the anchor date.
- NEVER put frequency words like "fortnightly", "every other week", "every other Friday" or "alternate" in the title. The title describes WHAT the reminder is for (e.g. "Swimming kit"); frequency is captured only by recurrence_interval and anchor_date.
Example: Parent says "Jude has PE on Mondays" → save it → reply "Done! 👟 I'll remind you about Jude's PE kit every Sunday evening and Monday morning."

## When a parent responds to the Sunday lunch check-in
Use the save_weekly_lunch_plan tool for each child they mention. Save even if they say "school dinners all week" (just save an empty array for packed_lunch_days).
IMPORTANT — which week: look back in the conversation history at Monty's own check-in message and find the date range it mentioned (e.g. "this week (7 Sept-11 Sept)"). Work out the Monday of that range and pass it as week_start in YYYY-MM-DD form. The check-in is about the upcoming week, so use the date range Monty named rather than guessing.
Example: "Jude needs one Monday and Wednesday, Harry every day" → save Jude: [Monday, Wednesday], Harry: [Monday, Tuesday, Wednesday, Thursday, Friday]

## Packed lunches and school dinners (HARD RULE)
Any message about packed lunches or school dinners for specific days (e.g. "Harry needs a packed lunch Friday", "Jude's on school dinners tomorrow") MUST use save_weekly_lunch_plan, never save_parent_note. Always work out and pass week_start (the Monday of the week those days fall in, using today's date). Use mode 'replace' only when the parent is giving the full week (e.g. answering the Sunday check-in). Use mode 'add' when they mention extra packed lunch days, and mode 'remove' when they switch a day back to school dinners.


## When a parent tells you about a school event or date
Use the save_parent_note tool to save it so they get a reminder when it comes around.
- If the parent's message itself names a specific child (e.g. "Lucy's piano lesson"), pass that child_name directly to save_parent_note even if no year group is mentioned — a child's name mentioned directly is just as strong a signal as year-group detection.

## When a parent forwards a message or pastes text from a WhatsApp group or school email
This is one of the most useful things you can do. The parent may say "just got this in the school group:" or "school emailed this:" or simply paste a chunk of text.
- Read it carefully and extract ANY dates, events, deadlines or action items
- If the message mentions a specific year group, automatically attribute it to the correct child using the children list above — NEVER ask the parent which child it's for
- Even if the event is for multiple year groups (e.g. "Year 1 and Year 2"), check if ANY of the parent's children are in those year groups and attribute accordingly
- Always pass child_name to save_parent_note when you can identify the child
- Confirm back exactly what you extracted, saved, and which child it's for by first name
- If the tool result starts with "ALREADY_SAVED:", that event was already saved previously — confirm warmly that you've already got it, e.g. "I've already got that saved for Harry on 22nd April 👍". Do NOT save it again.
- If something is ambiguous (e.g. "next Friday") clarify which date you've assumed
- If there's nothing actionable, let them know warmly
Example: Parent forwards "Year 1 and Year 2 — Earth Day litter pick Wednesday 22nd April, leaving at 1:15pm."
→ Harry is in Year 2 → save note with child_name="Harry"
→ Reply: "Got it! I've saved the Earth Day litter pick for Harry on Wednesday 22nd April — leaving at 1:15pm."

${onboardingInstructions}`;
}

// ── AI tools (actions Monty can take) ────────────────────────────────────────
// Claude API uses a different tool format to OpenAI/Gemini

const tools = [
  {
    name: "save_child_reminder",
    description: "Save a recurring reminder for a specific child. Use this when a parent tells you about a regular activity or schedule item for their child. If the parent describes something as 'every other [day]' or 'fortnightly', set recurrence_interval to 2 and use one specific confirmed occurrence date as anchor_date — ask the parent for the next actual date if they haven't given one; never guess.",
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
          enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
          description: "The day of the week this reminder applies to (weekends allowed, e.g. Saturday gymnastics). For an activity on several days, call this tool once per day with the same title.",
        },
        reminder_time: {
          type: "string",
          enum: ["morning", "evening", "both"],
          description: "When to send the reminder. Default to 'both' (evening before AND morning of) for anything that involves bringing, packing, or preparing an item — kit, equipment, books, forms, money, etc. — so the parent gets advance notice to prepare it the night before. Only use 'morning'-only for pure same-day FYI reminders that don't require any advance preparation, or if the parent explicitly asks for a morning-only reminder. When in doubt, prefer 'both'.",
        },
        recurrence_interval: {
          type: "integer",
          enum: [1, 2],
          description: "How often the reminder repeats: 1 = every week (the default), 2 = every other week (fortnightly). If a parent describes something as 'every other [day]', 'alternate weeks', or 'fortnightly', set this to 2.",
        },
        anchor_date: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) of one specific confirmed occurrence, required when recurrence_interval is 2 — used to calculate which weeks are 'on'. Infer it from what the parent said if they gave a real date (e.g. 'next one is 2nd October'); never guess. If the parent hasn't stated an actual occurrence date, ask them for the next one before saving. Omit for weekly reminders.",
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
        confirm_new: {
          type: "boolean",
          description: "Only set true after a POSSIBLE_DUPLICATE result, once the parent has confirmed this is a different thing.",
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
        week_start: {
          type: "string",
          description: "ISO date (YYYY-MM-DD) of the MONDAY of the week these days fall in. Always work this out from today's date (or the Sunday check-in's date range) and pass it.",
        },
        mode: {
          type: "string",
          enum: ["replace", "add", "remove"],
          description: "'replace' (default) = these are the full week's packed lunch days (e.g. answering the Sunday check-in). 'add' = add these extra packed lunch days to the existing plan. 'remove' = switch these days back to school dinners.",
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

async function getLinkedPartnerPhones(currentPhone: string): Promise<string[]> {
  const { data: myProfile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("phone_number", currentPhone)
    .maybeSingle();

  if (!myProfile?.user_id) return [];
  const myUserId = myProfile.user_id;

  const { data: links } = await supabase
    .from("linked_accounts")
    .select("primary_user_id, linked_user_id")
    .eq("status", "accepted")
    .or(`primary_user_id.eq.${myUserId},linked_user_id.eq.${myUserId}`);

  if (!links || links.length === 0) return [];

  const otherUserIds = links.map((l: any) =>
    l.primary_user_id === myUserId ? l.linked_user_id : l.primary_user_id
  );

  const { data: partnerProfiles } = await supabase
    .from("profiles")
    .select("phone_number")
    .in("user_id", otherUserIds)
    .not("phone_number", "is", null);

  return (partnerProfiles || [])
    .map((p: any) => p.phone_number as string)
    .filter((pn: string) => pn && pn !== currentPhone);
}

type PartnerNotification =
  | { type: "reminder"; data: { child: string; title: string; day: string } }
  | { type: "note"; data: { summary: string; date: string } }
  | { type: "lunch"; data: { child: string; daysSummary: string } };

async function notifyLinkedPartners(
  currentPhone: string,
  notification: PartnerNotification
): Promise<void> {
  const partners = await getLinkedPartnerPhones(currentPhone);
  if (partners.length === 0) return;

  let contentSid: string | undefined;
  let variables: Record<string, string> = {};

  if (notification.type === "reminder") {
    contentSid = TWILIO_PARTNER_REMINDER_TEMPLATE_SID;
    variables = {
      "1": notification.data.child,
      "2": notification.data.title,
      "3": notification.data.day,
    };
  } else if (notification.type === "note") {
    contentSid = TWILIO_PARTNER_NOTE_TEMPLATE_SID;
    variables = {
      "1": notification.data.summary,
      "2": formatNoteDate(notification.data.date),
    };
  } else if (notification.type === "lunch") {
    contentSid = TWILIO_PARTNER_LUNCH_TEMPLATE_SID;
    variables = {
      "1": notification.data.child,
      "2": notification.data.daysSummary,
    };
  }

  if (!contentSid) {
    console.log(
      `Partner ${notification.type} template SID not configured yet; skipping partner notifications.`
    );
    return;
  }

  for (const partnerPhone of partners) {
    try {
      await sendWhatsAppTemplate(partnerPhone, contentSid, variables);
    } catch (err) {
      console.error(`Partner notification to ${partnerPhone} failed:`, err);
    }
  }
}

function formatNoteDate(dateStr: string): string {
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  } catch {
    return dateStr;
  }
}

// ── Duplicate matching (done in code, never by the model) ─────────────────────
const MATCH_STOP = new Set([
  "the", "and", "for", "with", "has", "have", "had", "needs", "need", "needed", "is", "are", "on", "at", "to", "in",
  "of", "a", "an", "his", "her", "their", "my", "our", "your", "me", "remind", "reminder", "please", "about", "bring",
  "take", "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "am", "pm", "next", "this", "week",
  "day", "school", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
  "december", "st", "nd", "rd", "th", "o", "clock",
]);
function itemTokens(text: string, childNames: string[]): Set<string> {
  const names = new Set(childNames.map((n) => n.toLowerCase()));
  return new Set(
    (text || "").toLowerCase().replace(/'s\b/g, "").split(/[^a-z]+/)
      .filter((w) => w.length >= 2 && !MATCH_STOP.has(w) && !names.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );
}
/** exact = same thing; ambiguous = overlapping but not identical; none = different thing */
function matchItem(existing: string, incoming: string, childNames: string[]): "exact" | "ambiguous" | "none" {
  const a = itemTokens(existing, childNames);
  const b = itemTokens(incoming, childNames);
  if (a.size === 0 || b.size === 0) return "none";
  const shared = [...a].filter((w) => b.has(w));
  if (shared.length === 0) return "none";
  if (shared.length === a.size && shared.length === b.size) return "exact";
  return "ambiguous";
}
async function logDedupDecision(d: {
  phone: string; childName: string | null; tool: string; date?: string | null; newItem: string;
  decision: string; match?: { table: string; id: string; text: string };
}) {
  console.log("[DEDUP]", JSON.stringify({ ...d, phone: `…${d.phone.slice(-4)}` }));
  try {
    await supabase.from("dedup_decisions").insert({
      phone_number: d.phone, child_name: d.childName, tool: d.tool, item_date: d.date ?? null,
      new_item: d.newItem, decision: d.decision,
      matched_table: d.match?.table ?? null, matched_id: d.match?.id ?? "no match", matched_text: d.match?.text ?? null,
    });
  } catch (err) {
    console.error("dedup log failed:", err);
  }
}
const ALREADY_CLAIM = /\balready\s+(got|saved|down|covered|set|on|have|in|booked|noted|there|sorted)\b|\ball set\b|\bgot (that|it) (saved|covered|already)\b/i;
const SUCCESS_CLAIM = /\b(saved|added|set up|sorted|noted|booked|done|updated|got (that|it|them) down|i'?ll remind)\b/i;
/** Structured tool outcome. The honesty guard reads `ok`/`failed`, never the text. */
type ToolAction = "saved" | "updated" | "deleted" | "onboarding_complete" | "no_change" | "not_saved" | "pending" | "unknown_tool";
interface ToolResult {
  ok: boolean;          // something genuinely succeeded (or was confirmed already saved)
  action: ToolAction;
  summary: string;      // short, parent-facing description used by the honest reply
  text: string;         // full text given to Claude as the tool_result content
  failed?: boolean;     // part of the request failed (may be true alongside ok)
}
const okResult = (action: ToolAction, summary: string, text: string = summary, failed = false): ToolResult =>
  ({ ok: true, action, summary, text, failed });
const failResult = (text: string, action: ToolAction = "not_saved"): ToolResult =>
  ({ ok: false, action, summary: text, text, failed: action === "not_saved" });
const isSuccessResult = (r: ToolResult) => r.ok;
const isFailResult = (r: ToolResult) => !!r.failed;

/** Reply built only from what the tools actually did — never claims unconfirmed success. */
function buildHonestReply(results: ToolResult[]): string {
  const successes = results.filter((r) => r.ok);
  const failed = results.some(isFailResult);
  if (successes.length === 0) {
    if (results.some((r) => r.action === "pending")) {
      return "I haven't saved that yet — could you tell me which child it's for? 🙏";
    }
    return "Sorry — that didn't save. Could you send it to me again? 🙏";
  }
  const lines = successes.map((r) => r.summary);
  return lines.join(" | ") + (failed ? " | Some of it didn't save though — could you send the rest again? 🙏" : " ✅");
}

/** Every reply replacement goes through here so it's always audited. */
async function replaceReply(
  original: string, results: ToolResult[], phone: string, path: string, decision: string,
): Promise<string> {
  const honest = buildHonestReply(results);
  await logDedupDecision({
    phone, childName: null, tool: `reply_guard_${path}`,
    newItem: JSON.stringify(results.map(({ ok, action, summary, failed }) => ({ ok, action, summary, failed }))).slice(0, 2000),
    decision,
    match: { table: "model_reply", id: "no match", text: (original || "(empty reply)").slice(0, 2000) },
  });
  return honest;
}

async function enforceHonestReply(reply: string, results: ToolResult[], phone: string, path: string): Promise<string> {
  if (!reply) return await replaceReply(reply, results, phone, path, "empty_reply_replaced");
  const anySuccess = results.some(isSuccessResult);
  if (!anySuccess && SUCCESS_CLAIM.test(reply) && !/didn'?t save|not saved|couldn'?t save|haven'?t saved/i.test(reply)) {
    return await replaceReply(reply, results, phone, path, "unverified_success_claim_blocked");
  }
  return reply;
}

async function executeTool(
  toolName: string,
  toolArgs: any,
  context: MontyContext,
  phone: string
): Promise<ToolResult> {
  if (toolName === "save_child_reminder") {
    // Find the child by name
    const child = context.children.find(
      (c) => c.first_name.toLowerCase() === toolArgs.child_name.toLowerCase()
    );

    if (!child) {
      return failResult(`NOT SAVED: Could not find child named ${toolArgs.child_name}`);
    }

    // Server-side guard: never save a fortnightly reminder without a real anchor,
    // and never let frequency be encoded in the title.
    const freqPattern = /\b(fortnight(ly)?|every\s+other|alternate\s+(weeks?|\w+days?)|bi-?weekly)\b/i;
    if (toolArgs.recurrence_interval === 2 && !(typeof toolArgs.anchor_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(toolArgs.anchor_date))) {
      return failResult("NOT SAVED: fortnightly reminders need a specific confirmed next date (anchor_date). Ask the parent when the next one is, then save with recurrence_interval=2 and that date.");
    }
    if (typeof toolArgs.title === "string" && freqPattern.test(toolArgs.title)) {
      if (toolArgs.recurrence_interval === 2 && toolArgs.anchor_date) {
        toolArgs.title = toolArgs.title.replace(/\s*\(?\s*(fortnight(ly)?|every\s+other\s+\w+|alternate\s+\w+|bi-?weekly)\s*\)?\s*/gi, " ").trim();
      } else {
        return failResult("NOT SAVED: the title mentions a fortnightly/every-other frequency but recurrence_interval is not 2 with a real anchor_date. Ask the parent for the next specific date, then save with recurrence_interval=2, that anchor_date, and a title describing only what it's for.");
      }
    }

    if (!DAYS.includes(toolArgs.day_of_week)) {
      return failResult(`NOT SAVED: "${toolArgs.day_of_week}" isn't a valid day. Use Monday to Sunday.`);
    }

    // Match existing reminders for this child/title. A day change updates the row,
    // but the same activity on several days in one message (e.g. gymnastics Mon, Wed, Sat)
    // creates one row per day rather than overwriting.
    const { data: existingRows, error: lookupErr } = await supabase
      .from("child_reminders")
      .select("id, day_of_week")
      .eq("child_id", child.id)
      .eq("title", toolArgs.title);
    if (lookupErr) {
      console.error("Reminder lookup failed:", lookupErr);
      return failResult(`NOT SAVED: Error saving reminder (${lookupErr.message})`);
    }
    const turnKey = `${child.id}|${String(toolArgs.title).toLowerCase()}`;
    const ctxAny = context as any;
    ctxAny.__savedThisTurn = ctxAny.__savedThisTurn || new Set<string>();
    const sameDay = (existingRows ?? []).find((r: any) => r.day_of_week === toolArgs.day_of_week);
    const touchedThisTurn: Set<string> = ctxAny.__touchedIds || (ctxAny.__touchedIds = new Set<string>());
    const existing = sameDay
      ?? (ctxAny.__savedThisTurn.has(turnKey)
        ? undefined
        : (existingRows ?? []).find((r: any) => !touchedThisTurn.has(r.id)));

    const fields = {
      emoji: toolArgs.emoji,
      day_of_week: toolArgs.day_of_week,
      reminder_time: toolArgs.reminder_time,
      recurrence_interval: toolArgs.recurrence_interval ?? 1,
      anchor_date: toolArgs.recurrence_interval === 2 ? toolArgs.anchor_date ?? null : null,
      active: true,
    };

    let savedId: string | null = null;
    let verb: "Updated" | "Saved";
    if (existing) {
      const { error: updErr } = await supabase.from("child_reminders").update(fields).eq("id", existing.id);
      if (updErr) {
        console.error("Error updating reminder:", updErr);
        return failResult(`NOT SAVED: Error saving reminder (${updErr.message})`);
      }
      savedId = existing.id;
      verb = "Updated";
    } else {
      const { data: ins, error } = await supabase
        .from("child_reminders")
        .insert({ child_id: child.id, parent_id: context.parentId, title: toolArgs.title, ...fields })
        .select("id")
        .single();
      if (error) {
        console.error("Error saving reminder:", error);
        return failResult(`NOT SAVED: Error saving reminder (${error.message})`);
      }
      savedId = ins.id;
      verb = "Saved";
    }
    ctxAny.__savedThisTurn.add(turnKey);
    if (savedId) touchedThisTurn.add(savedId);

    try {
      await notifyLinkedPartners(phone, {
        type: "reminder",
        data: { child: toolArgs.child_name, title: toolArgs.title, day: toolArgs.day_of_week },
      });
    } catch (err) {
      console.error("Partner notification failed:", err);
    }
    return okResult(
      verb === "Updated" ? "updated" : "saved",
      `${verb}: ${toolArgs.child_name} — ${toolArgs.title} on ${toolArgs.day_of_week}`,
      `${verb} reminder for ${toolArgs.child_name}: ${toolArgs.title} on ${toolArgs.day_of_week}`,
    );
  }

  if (toolName === "save_parent_note") {
    const noteDate: string = toolArgs.date;
    const noteChild = toolArgs.child_name || null;
    const confirmNew = toolArgs.confirm_new === true;

    // If no specific child, save for ALL children
    const childNames: (string | null)[] = noteChild
      ? [noteChild]
      : context.children.length > 0
        ? context.children.map((c) => c.first_name)
        : [null];

    const savedFor: string[] = [];
    const alreadySavedFor: string[] = [];
    const failedFor: string[] = [];
    const ambiguous: string[] = [];

    const newSummary: string = (toolArgs.summary || "").toString();
    const allChildNames = context.children.map((c) => c.first_name);
    const validDate = typeof noteDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(noteDate);
    const weekday = validDate
      ? new Date(`${noteDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })
      : null;

    let dupSummary: string | null = null;

    for (const childName of childNames) {
      const child = childName
        ? context.children.find((c) => c.first_name.toLowerCase() === childName.toLowerCase())
        : null;
      const candidates: Array<{ table: string; id: string; text: string }> = [];

      if (validDate) {
        // 1. Existing notes on the same date for the same child
        const { data: existingNotes } = await supabase
          .from("parent_notes")
          .select("id, child_name, summary")
          .eq("phone_number", phone)
          .filter("extracted_dates", "cs", JSON.stringify([{ date: noteDate }]));
        for (const row of existingNotes ?? []) {
          const sameChild = childName
            ? (row.child_name || "").toLowerCase() === childName.toLowerCase()
            : !row.child_name;
          if (sameChild) candidates.push({ table: "parent_notes", id: row.id, text: row.summary || "" });
        }

        // 2. This child's active recurring reminders on the same weekday
        if (child && weekday) {
          const { data: recurring } = await supabase
            .from("child_reminders")
            .select("id, title")
            .eq("child_id", child.id)
            .eq("day_of_week", weekday)
            .eq("active", true);
          for (const r of recurring ?? []) candidates.push({ table: "child_reminders", id: r.id, text: r.title });
        }

        // 3. School events + school-wide reminders on that date for the child's school
        const schoolIds = child ? [child.school_id] : context.children.map((c) => c.school_id);
        if (schoolIds.length > 0) {
          const { data: events } = await supabase
            .from("school_events")
            .select("id, title, year_group")
            .in("school_id", schoolIds)
            .gte("start_at", `${noteDate}T00:00:00.000Z`)
            .lte("start_at", `${noteDate}T23:59:59.999Z`);
          for (const ev of events ?? []) {
            const yg = (ev.year_group || "all").toLowerCase();
            if (child && yg !== "all" && !yg.includes((child.year_group || "").toLowerCase())) continue;
            candidates.push({ table: "school_events", id: ev.id, text: ev.title || "" });
          }
          const { data: schoolRems } = await supabase
            .from("school_reminders")
            .select("id, title")
            .or(`school_id.in.(${schoolIds.join(",")}),school_id.is.null`)
            .or(`day_of_week.eq.${weekday},due_date.eq.${noteDate}`)
            .eq("active", true);
          for (const r of schoolRems ?? []) candidates.push({ table: "school_reminders", id: r.id, text: r.title });
        }
      }

      // Exact match on same child + same date + same thing → genuine duplicate
      let exact: typeof candidates[number] | undefined;
      let partial: typeof candidates[number] | undefined;
      for (const c of candidates) {
        const m = matchItem(c.text, newSummary, allChildNames);
        if (m === "exact") { exact = c; break; }
        if (m === "ambiguous" && !partial) partial = c;
      }

      if (exact) {
        await logDedupDecision({ phone, childName, tool: toolName, date: noteDate, newItem: newSummary, decision: "exact_match", match: exact });
        alreadySavedFor.push(childName || "general");
        dupSummary = dupSummary || exact.text || newSummary;
        continue;
      }
      if (partial && !confirmNew) {
        await logDedupDecision({ phone, childName, tool: toolName, date: noteDate, newItem: newSummary, decision: "ambiguous_asked_parent", match: partial });
        ambiguous.push(`${childName || "the family"} already has "${partial.text}" on ${noteDate}`);
        continue;
      }
      await logDedupDecision({
        phone, childName, tool: toolName, date: noteDate, newItem: newSummary,
        decision: partial ? "ambiguous_parent_confirmed_new" : "no_match", match: partial,
      });

      const { error } = await supabase.from("parent_notes").insert({
        phone_number: phone,
        raw_content: toolArgs.summary,
        summary: toolArgs.summary,
        extracted_dates: [{ date: toolArgs.date }],
        source_type: "whatsapp",
        child_name: childName,
      });

      if (error) {
        console.error("Error saving note:", error);
        failedFor.push(childName || "general");
      } else {
        savedFor.push(childName || "general");
      }
    }

    // Notify linked partners only about genuinely new saves (not dedup hits)
    if (savedFor.length > 0 && noteDate) {
      try {
        await notifyLinkedPartners(phone, {
          type: "note",
          data: { summary: newSummary, date: noteDate },
        });
      } catch (err) {
        console.error("Partner notification failed:", err);
      }
    }

    const parts: string[] = [];
    const names = savedFor.filter((n) => n !== "general");
    if (savedFor.length > 0) {
      parts.push(`Saved note: ${toolArgs.summary} on ${toolArgs.date}${names.length > 0 ? ` for ${names.join(" and ")}` : ""} (reminders go out the evening before and the morning of)`);
    }
    if (alreadySavedFor.length > 0) {
      parts.push(`ALREADY_SAVED:${dupSummary || newSummary}:${noteDate}:${alreadySavedFor.join(" and ")}`);
    }
    if (ambiguous.length > 0) {
      parts.push(`POSSIBLE_DUPLICATE (NOT SAVED): ${ambiguous.join("; ")}. Ask the parent whether "${newSummary}" is the same thing. If they say it's different, call save_parent_note again with confirm_new: true.`);
    }
    if (failedFor.length > 0) {
      parts.push(`NOT SAVED (database error) for ${failedFor.join(" and ")} — tell the parent it didn't save and ask them to try again.`);
    }
    const text = parts.join("\n") || "NOT SAVED: nothing was saved — tell the parent it didn't save.";
    const partFailed = failedFor.length > 0;
    if (savedFor.length > 0) {
      return okResult("saved", `Saved: ${newSummary} on ${noteDate}${names.length > 0 ? ` for ${names.join(" and ")}` : ""}`, text, partFailed);
    }
    if (alreadySavedFor.length > 0) {
      return okResult("no_change", `Already saved: ${alreadySavedFor.join(" and ")} — ${dupSummary || newSummary} on ${noteDate}`, text, partFailed);
    }
    if (ambiguous.length > 0 && !partFailed) return failResult(text, "pending");
    return failResult(text);
  }

  if (toolName === "save_weekly_lunch_plan") {
    const child = context.children.find(
      (c) => c.first_name.toLowerCase() === toolArgs.child_name.toLowerCase()
    );

    if (!child) {
      return failResult(`NOT SAVED: Could not find child named ${toolArgs.child_name}`);
    }

    // Prefer an explicit week_start from the AI (must be a valid Monday), else
    // fall back: Sat/Sun (UK) → next Monday; Mon–Fri → this week's Monday.
    let weekStart: string | null = null;
    const provided = typeof toolArgs.week_start === "string" ? toolArgs.week_start.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(provided)) {
      const parsed = new Date(`${provided}T12:00:00Z`);
      if (!isNaN(parsed.getTime()) && parsed.getUTCDay() === 1) {
        weekStart = provided;
      }
    }

    if (!weekStart) {
      const ukDateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const ukNoon = new Date(`${ukDateStr}T12:00:00Z`);
      const dow = ukNoon.getUTCDay(); // 0=Sun
      const offset = dow === 6 ? 2 : dow === 0 ? 1 : 1 - dow;
      ukNoon.setUTCDate(ukNoon.getUTCDate() + offset);
      weekStart = ukNoon.toISOString().split("T")[0];
    }

    const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const normDays = (arr: unknown): string[] =>
      Array.isArray(arr)
        ? arr
            .map((d) => String(d).trim())
            .map((d) => DAY_ORDER.find((o) => o.toLowerCase() === d.toLowerCase()))
            .filter((d): d is string => !!d)
        : [];
    const mode = ["replace", "add", "remove"].includes(toolArgs.mode) ? toolArgs.mode : "replace";
    const given = normDays(toolArgs.packed_lunch_days);

    let resultSet: Set<string>;
    if (mode === "replace") {
      resultSet = new Set(given);
    } else {
      const { data: existing, error: fetchErr } = await supabase
        .from("weekly_lunch_plans")
        .select("packed_lunch_days")
        .eq("child_id", child.id)
        .eq("week_start", weekStart)
        .maybeSingle();
      if (fetchErr) {
        console.error("Error fetching existing lunch plan:", fetchErr);
        return failResult(`NOT SAVED: Error saving lunch plan: ${fetchErr.message}`);
      }
      resultSet = new Set(normDays(existing?.packed_lunch_days));
      if (mode === "add") given.forEach((d) => resultSet.add(d));
      else given.forEach((d) => resultSet.delete(d));
    }
    const days = DAY_ORDER.filter((d) => resultSet.has(d));

    const { error } = await supabase
      .from("weekly_lunch_plans")
      .upsert({
        child_id: child.id,
        parent_id: context.parentId,
        week_start: weekStart,
        packed_lunch_days: days,
      }, { onConflict: "child_id,week_start" });

    if (error) {
      console.error("Error saving lunch plan:", error);
      return failResult(`NOT SAVED: Error saving lunch plan: ${error.message}`);
    }

    const weekLabel = new Date(`${weekStart}T12:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", timeZone: "UTC",
    });

    try {
      const lunchSummary =
        days.length === 0 ? "school dinners all week" : `packed lunch on ${days.join(", ")}`;
      await notifyLinkedPartners(phone, {
        type: "lunch",
        data: { child: toolArgs.child_name, daysSummary: lunchSummary },
      });
    } catch (err) {
      console.error("Partner notification failed:", err);
    }

    if (days.length === 0) {
      return okResult("saved", `Saved: ${toolArgs.child_name} — school dinners all week (week of ${weekLabel})`, `Saved: ${toolArgs.child_name} now has school dinners all week for week of ${weekLabel}`);
    }
    return okResult("saved", `Saved: ${toolArgs.child_name} — packed lunch on ${days.join(", ")} (week of ${weekLabel})`, `Saved: ${toolArgs.child_name} now needs packed lunch on ${days.join(", ")} for week of ${weekLabel} (reminders go out the evening before and the morning of each day)`);
  }

  if (toolName === "complete_onboarding") {
    const { error: obErr } = await supabase
      .from("onboarding_state")
      .update({ status: "complete" })
      .eq("phone_number", phone);
    if (obErr) {
      console.error("complete_onboarding failed:", obErr);
      return failResult(`NOT SAVED: Error completing onboarding (${obErr.message})`);
    }
    return okResult("onboarding_complete", "You're all set up — your reminders are ready", "Onboarding marked as complete");
  }

  return failResult(`Unknown tool ${toolName}`, "unknown_tool");
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
  const model1 = "claude-sonnet-4-6";
  console.log("[Claude] Calling model:", model1);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model1,
      max_tokens: 500,
      system: systemPrompt,
      messages,
      tools,
    }),
  });

  const rawText1 = await response.text();
  console.log("[Claude] Raw response text (first call):", rawText1);

  if (!response.ok) {
    console.error("Claude API error:", response.status, rawText1);
    await logClaudeFailure(phone, response.status, rawText1, "Claude API - initial reply");
    return "Sorry, I had a little hiccup there! Try again in a moment 😊";
  }

  let data = JSON.parse(rawText1);

  // Guard: the model may not claim "already saved" without a database check.
  // If it did so without calling a tool, force a tool call so the check runs in code.
  if (data.stop_reason !== "tool_use") {
    const firstText = data.content?.find((b: any) => b.type === "text")?.text || "";
    if (ALREADY_CLAIM.test(firstText)) {
      await logDedupDecision({
        phone, childName: null, tool: "reply_guard", newItem: incomingMessage.slice(0, 300),
        decision: "unverified_claim_blocked", match: { table: "model_reply", id: "no match", text: firstText.slice(0, 300) },
      });
      const retry = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: model1,
          max_tokens: 500,
          system: systemPrompt + "\n\nSYSTEM CHECK: You must not claim anything is already saved without calling a save tool. Call the correct save tool now for what the parent just asked; the tool checks the database for duplicates.",
          messages,
          tools,
          tool_choice: { type: "any" },
        }),
      });
      if (retry.ok) {
        data = await retry.json();
      } else {
        await logClaudeFailure(phone, retry.status, await retry.text(), "Claude API - already-claim retry");
        return "Sorry, I couldn't save that just now — could you send it again? 😊";
      }
    }
  }

  // Claude returns stop_reason "tool_use" when it wants to call a tool
  if (data.stop_reason === "tool_use") {
    const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use");
    const toolResults = [];
    const structuredResults: ToolResult[] = [];

    for (const toolBlock of toolUseBlocks) {
      const toolName = toolBlock.name;
      const toolArgs = toolBlock.input;
      console.log(`Executing tool: ${toolName}`, toolArgs);

      const result = await executeTool(toolName, toolArgs, context, phone);
      console.log(`Tool result:`, JSON.stringify(result));
      structuredResults.push(result);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: result.text,
      });
    }

    // Second API call with tool results to get final conversational reply
    const model2 = "claude-sonnet-4-6";
    console.log("[Claude] Calling model (follow-up):", model2);
    const followUpResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model2,
        max_tokens: 400,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: "assistant", content: data.content },
          { role: "user", content: toolResults },
        ],
      }),
    });

    const rawFollowUp = await followUpResponse.text();
    console.log("[Claude] Raw response text (follow-up):", rawFollowUp);

    if (!followUpResponse.ok) {
      console.error("Claude follow-up error:", followUpResponse.status, rawFollowUp);
      await logClaudeFailure(phone, followUpResponse.status, rawFollowUp, "Claude API - tool follow-up");
      return await replaceReply("", structuredResults, phone, "text", "followup_failed_replaced");
    }

    let followUpData: any = null;
    try { followUpData = JSON.parse(rawFollowUp); } catch { /* fall through */ }
    const textBlock = followUpData?.content?.find((b: any) => b.type === "text");
    return await enforceHonestReply(textBlock?.text?.trim() || "", structuredResults, phone, "text");
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
  params.append(
    "StatusCallback",
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=whatsapp-webhook`
  );

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

async function sendWhatsAppTemplate(
  to: string,
  contentSid: string,
  variables: Record<string, string>
): Promise<boolean> {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", contentSid);
  params.append("ContentVariables", JSON.stringify(variables));
  params.append(
    "StatusCallback",
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback?source=whatsapp-webhook-partner`
  );

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

  if (!res.ok) console.error("Twilio template send error:", await res.text());
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
    // Chunk the encoding to avoid call-stack overflow on large images
    const bytes = new Uint8Array(imageBuffer);
    let imageBase64 = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      imageBase64 += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    imageBase64 = btoa(imageBase64);

    const childNames = context.children.map((c) => c.first_name).join(" and ");
    const childrenWithYearGroups = context.children
      .map((c) => `${c.first_name} (${c.year_group || "unknown year"})`)
      .join(", ");
    console.log("Children with year groups:", childrenWithYearGroups);
    const nowDate = new Date();
    const today = nowDate.toISOString().split("T")[0];
    const todayHuman = nowDate.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/London",
    });
    // Compute the next 7 days as explicit anchors so Claude doesn't miscalculate
    const upcomingDays: string[] = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(nowDate);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().split("T")[0];
      const human = d.toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Europe/London",
      });
      const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
      upcomingDays.push(`- ${human} = ${iso}${label}`);
    }
    const dateAnchors = upcomingDays.join("\n");

    // Build Claude vision request
    const systemPrompt = `You are Monty, a friendly school reminder assistant. A parent has forwarded you an image — likely a screenshot from a school WhatsApp group, a photo of a school letter, or a school email screenshot.

Your job is to:
1. Read the image carefully
2. Extract ANY dates, events, deadlines, or action items relevant to school life
3. For each item found, call the save_parent_note tool to save it — include the child_name if you can identify which child it's for
4. Reply confirming EXACTLY what you found and saved — be specific (event name, date, time if visible, which child)

The parent's children and their year groups: ${childrenWithYearGroups}
Today's date is: ${todayHuman} (${today})

## Resolving relative dates — CRITICAL
When the image mentions a day name like "Monday", "Tuesday", "next Friday" etc., resolve it using these exact anchors. Do NOT calculate the date yourself — use this lookup:
${dateAnchors}

- "Monday", "this Monday", "on Monday" → the NEXT occurrence of Monday from the list above (today counts only if today is Monday)
- "next Monday" → the Monday in the list above (in British usage this usually means the upcoming Monday, not the one after)
- "tomorrow" → the date marked (tomorrow) above
- Always output dates in YYYY-MM-DD format using the anchors above — never guess

## Year group attribution — IMPORTANT
If the event or message mentions a specific year group, automatically attribute it to the correct child:
- Match "Year 1", "Y1", "Yr1" etc. to the child in that year group
- Match "Year 2", "Y2" etc. to the child in Year 2
- If an event is for multiple year groups (e.g. "Year 1 and Year 2"), check ALL year groups against the parent's children — if ANY of the parent's children are in those year groups, attribute it to them
- Never save a note without a child_name if you can identify which child it belongs to
- Never ask the parent which child — figure it out from the year group information above
- If no year group is mentioned, or the year group doesn't match any of the parent's children, save as a general note without child_name

## Confirmation style
- Confirm the event name, the child's name, the date, and any key details (time, what to bring, etc.)
- Do NOT explain year group logic, why an event applies to a child, or which year groups are involved
- Good: "Got it! I've saved the Earth Day litter pick for Harry on Wednesday 22nd April — leaving at 1:15pm. They'll need outdoor clothing and walking footwear."
- Bad: "Since Year 2 is mentioned, this applies to Harry. I've saved the Earth Day litter pick..."
- Use ONE emoji at most, only if it naturally fits — never as punctuation at the end
- Keep it to 2-3 sentences max
- British English always
- Use the child's first name, never pronouns like "they/their" if you know which child it is

If the tool result starts with "ALREADY_SAVED:", that event was already saved previously — confirm warmly that you've already got it, e.g. "I've already got that saved for Harry on 22nd April 👍". Do NOT save it again.
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

    const visionModel = "claude-sonnet-4-6";
    console.log("[Claude] Calling model (vision):", visionModel);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: visionModel,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        tools,
      }),
    });

    const rawVisionText = await response.text();
    console.log("[Claude] Raw response text (vision):", rawVisionText);

    if (!response.ok) {
      console.error("Claude vision error:", response.status, rawVisionText);
      await logClaudeFailure(phone, response.status, rawVisionText, "Claude API - vision");
      return "I had trouble reading that image. Could you try forwarding it again? 😊";
    }

    const data = JSON.parse(rawVisionText);

    // Handle tool use — save extracted dates
    if (data.stop_reason === "tool_use") {
      const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use");

      // Get all text Claude extracted from the image — use this for year group detection
      const claudeExtractedText = data.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(" ");


      const toolResults = [];

      // Track notes that need clarification (no child identified, 2+ children in family)
      const pendingClarifications: Array<{ summary: string; date: string }> = [];
      const visionStructured: ToolResult[] = [];

      for (const toolBlock of toolUseBlocks) {
        // For save_parent_note, auto-inject child_name based on year group detection
        if (toolBlock.name === "save_parent_note" && !toolBlock.input.child_name) {
          // Check the note summary AND Claude's full extracted text for year groups
          const searchText = `${toolBlock.input.summary || ""} ${claudeExtractedText}`;
          const matchedChildren = detectYearGroupChildren(searchText, context.children);

          if (matchedChildren.length >= 1) {
            // Save once per matched child (so each child gets their own attributed note).
            const results: string[] = [];
            for (const childName of matchedChildren) {
              const childInput = { ...toolBlock.input, child_name: childName };
              const r = await executeTool(toolBlock.name, childInput, context, phone);
              visionStructured.push(r);
              results.push(r.text);
            }
            console.log(`Image: Auto-attributed note to: ${matchedChildren.join(", ")}`);
            toolBlock.input.child_name = matchedChildren.join(" and ");
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: results.join("\n"),
            });
            continue;
          }

          // No year group matched. If parent has 2+ children, defer and ask for clarification.
          if (context.children.length >= 2) {
            pendingClarifications.push({
              summary: toolBlock.input.summary,
              date: toolBlock.input.date,
            });
            console.log(`Image: Deferring note for clarification — ${toolBlock.input.summary}`);
            visionStructured.push(failResult("PENDING_CLARIFICATION: not saved yet — awaiting parent to confirm which child this is for", "pending"));
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: `PENDING_CLARIFICATION: not saved yet — awaiting parent to confirm which child this is for`,
            });
            continue;
          }
          // Single child or no children — fall through to normal save (executeTool handles fallback)
        }

        const result = await executeTool(toolBlock.name, toolBlock.input, context, phone);
        visionStructured.push(result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: result.text,
        });
      }

      // If we have pending clarifications, store them on the conversation and short-circuit reply
      if (pendingClarifications.length > 0) {
        const childOptions = context.children.map((c) => c.first_name);
        await supabase
          .from("conversations")
          .update({
            context: { pending_notes: pendingClarifications },
          })
          .eq("phone_number", phone);

        const note = pendingClarifications[0];
        const dateLabel = note.date
          ? new Date(note.date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
          : "";
        const childList = childOptions.length === 2
          ? `${childOptions[0]} or ${childOptions[1]}?`
          : `${childOptions.slice(0, -1).join(", ")} or ${childOptions[childOptions.length - 1]}?`;
        return `Got it — I can see there's ${note.summary}${dateLabel ? ` on ${dateLabel}` : ""}! Which child is this for? ${childList}`;
      }

      // Build explicit child attribution hint for the follow-up
      const attributedChildren = toolUseBlocks
        .filter((b: any) => b.name === "save_parent_note" && b.input.child_name)
        .flatMap((b: any) => String(b.input.child_name).split(" and "));
      const uniqueChildren = [...new Set(attributedChildren)];

      const childHint = uniqueChildren.length > 0
        ? ` The note was saved specifically for ${uniqueChildren.join(" and ")}. In your reply, refer to them by name rather than saying "Year 1 and Year 2".`
        : "";

      // Get final reply after saving
      const visionFollowModel = "claude-sonnet-4-6";
      console.log("[Claude] Calling model (vision follow-up):", visionFollowModel);
      const followUp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: visionFollowModel,
          max_tokens: 400,
          system: systemPrompt + childHint,
          messages: [
            { role: "user", content: userContent },
            { role: "assistant", content: data.content },
            { role: "user", content: toolResults },
          ],
        }),
      });

      const rawVisionFollowUp = await followUp.text();
      console.log("[Claude] Raw response text (vision follow-up):", rawVisionFollowUp);
      if (!followUp.ok) {
        await logClaudeFailure(phone, followUp.status, rawVisionFollowUp, "Claude API - vision follow-up");
        return await replaceReply("", visionStructured, phone, "vision", "followup_failed_replaced");
      }
      let followUpData: any = null;
      try { followUpData = JSON.parse(rawVisionFollowUp); } catch { /* fall through */ }
      const textBlock = followUpData?.content?.find((b: any) => b.type === "text");
      return await enforceHonestReply(textBlock?.text?.trim() || "", visionStructured, phone, "vision");
    }

    // No tool use — Claude couldn't find anything or image was unreadable
    const textBlock = data.content?.find((b: any) => b.type === "text");
    return textBlock?.text?.trim() || "I couldn't find any dates in that image — could you try sending the text instead? 😊";

  } catch (err: any) {
    console.error("Image handling error:", {
      message: err?.message,
      stack: err?.stack,
      errorString: JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})),
    });
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

// ── Pending note clarification resolver ───────────────────────────────────────
// If a previous image had unattributable notes, we stored them on the conversation
// and asked the parent which child. This resolves the parent's reply.

async function tryResolvePendingClarification(
  phone: string,
  message: string,
  context: MontyContext
): Promise<string | null> {
  const { data: convo } = await supabase
    .from("conversations")
    .select("id, context")
    .eq("phone_number", phone)
    .maybeSingle();

  const pending: Array<{ summary: string; date: string }> =
    convo?.context?.pending_notes || [];
  if (!convo || pending.length === 0) return null;

  // Match the parent's reply against children's first names (case-insensitive, word boundary)
  const lower = message.toLowerCase();
  const mentionedChildren: string[] = [];
  for (const c of context.children) {
    const re = new RegExp(`\\b${c.first_name.toLowerCase()}\\b`, "i");
    if (re.test(lower)) mentionedChildren.push(c.first_name);
  }

  // Also match "all" / "both" / "everyone" → all children
  if (mentionedChildren.length === 0 && /\b(all|both|everyone|all of them)\b/i.test(message)) {
    mentionedChildren.push(...context.children.map((c) => c.first_name));
  }

  if (mentionedChildren.length === 0) {
    // Couldn't identify a child — leave pending state, let normal flow handle it
    return null;
  }

  // Save each pending note for each matched child
  const savedSummaries: string[] = [];
  const clarifyResults: ToolResult[] = [];
  for (const note of pending) {
    let anyOk = false;
    for (const childName of mentionedChildren) {
      const r = await executeTool(
        "save_parent_note",
        { summary: note.summary, date: note.date, child_name: childName },
        context,
        phone
      );
      clarifyResults.push(r);
      if (r.ok) anyOk = true;
    }
    if (anyOk) savedSummaries.push(note.summary);
  }

  // Clear pending notes from conversation context
  await supabase
    .from("conversations")
    .update({ context: { ...(convo.context || {}), pending_notes: [] } })
    .eq("id", convo.id);

  if (savedSummaries.length === 0 || clarifyResults.some(isFailResult)) {
    return await replaceReply("(clarification confirmation not sent)", clarifyResults, phone, "clarification", "clarification_save_failed_replaced");
  }
  const childLabel = mentionedChildren.join(" and ");
  const summaryLabel = savedSummaries.length === 1
    ? savedSummaries[0]
    : `${savedSummaries.length} notes`;
  return `Perfect — saved ${summaryLabel} for ${childLabel}. I'll give you a nudge nearer the time 👍`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.text();
    const params = new URLSearchParams(body);

    // ── Twilio Signature Validation ──────────────────────────────────────
    const twilioWebhookUrl = Deno.env.get("TWILIO_WEBHOOK_URL");
    if (!twilioWebhookUrl) {
      console.error("TWILIO_WEBHOOK_URL is not configured — rejecting request");
      return new Response("Forbidden", { status: 403 });
    }
    const twilioSignature = req.headers.get("x-twilio-signature") || "";
    const formParams: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      formParams[key] = value;
    }
    const isValid = await validateTwilioSignature(
      TWILIO_AUTH_TOKEN,
      twilioSignature,
      twilioWebhookUrl,
      formParams
    );
    if (!isValid) {
      console.warn("Invalid Twilio signature — rejecting request");
      return new Response("Forbidden", { status: 403 });
    }

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
      const reply = `Hi! 👋 I'm Monty, a school reminder assistant for UK primary school parents. To get set up, head to heymonty.co.uk and create your account — it only takes a minute!`;
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
      // Check if there are pending notes awaiting child clarification
      const clarification = await tryResolvePendingClarification(
        from,
        incomingMessage,
        context
      );
      if (clarification) {
        reply = clarification;
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
    }

    // Save and send reply
    await saveMessage(conversationId, "outbound", reply);
    await sendWhatsApp(from, reply);

    console.log(`Replied to ${from}: "${reply.slice(0, 80)}…"`);

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { headers: { ...corsHeaders, "Content-Type": "text/xml" } }
    );
  } catch (error: any) {
    console.error("Webhook error:", {
      message: error?.message,
      stack: error?.stack,
      errorString: JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
    });
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { status: 200, headers: { "Content-Type": "text/xml" } }
    );
  }
});