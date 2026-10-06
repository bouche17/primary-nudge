import { montyClaudeModel } from "../_shared/claudeModel.ts";
import { evaluateClaudeAlerts } from "../_shared/alerts.ts";
import { blockIfTestPhone, isTestPhone, validTestSecret, auditTestEntry } from "../_shared/testGuard.ts";
import { detectOptIntent, isOptedOut, optOut, optIn, OPT_REPLIES } from "../_shared/optOut.ts";
import { sendAlertWhatsApp } from "../_shared/alerts.ts";
import { AsyncLocalStorage } from "node:async_hooks";

// Per-request test context. Only ever set by the secret-gated test entry point,
// scoped to that request (AsyncLocalStorage), so real requests always use the real clock.
interface TestCtx { now: Date; toolCalls: Array<{ name: string; input: unknown; ok: boolean; action: string; text: string }> }
const testStore = new AsyncLocalStorage<TestCtx>();
const nowD = (): Date => new Date((testStore.getStore()?.now ?? new Date()).getTime());
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
  // Alert Matt on bursts from real parents (test numbers and test runs never count).
  if (!testStore.getStore()) {
    try { if (!(await isTestPhone(phone))) await evaluateClaudeAlerts(); } catch (e) { console.error("Alert check failed:", e); }
  }
}

const OUTAGE_TEXT = "Sorry, I'm having trouble right now and haven't saved that. Could you send it again in a little while? 🙏";
const OUTAGE_PHOTO = "Sorry, I'm having trouble reading photos right now and haven't saved anything from it. Could you send it again in a little while? 🙏";
/** Honest outage reply; the item is recorded so it can be retried or reviewed later. */
async function outageReply(phone: string, kind: "text" | "photo", content: string, error: string): Promise<string> {
  try {
    await supabase.from("failed_inbound").insert({ phone_number: phone, message_type: kind, content: content.slice(0, 4000), error: error.slice(0, 1000) });
  } catch (e) { console.error("Failed to record failed inbound:", e); }
  return kind === "photo" ? OUTAGE_PHOTO : OUTAGE_TEXT;
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
  at?: string; // ISO timestamp the message was sent
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
  const now = nowD();
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
  const ukTodayIso = nowD().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
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
  const nowDate = nowD();
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

## Stopping messages (never say you can't)
- Parents can stop ALL Monty messages at any time by replying STOP, and turn them back on by replying START. To delete their account and data they can reply "delete my data". If anyone asks how to stop messages, unsubscribe or delete their data, tell them exactly this. Never say you can't stop messages.

## Right now (authoritative — trust this over anything in the chat history)
- Current UK time: ${ukTime}
- Today: ${ukLong(nowDate)} (${todayIsoUK})
- Tomorrow: ${tomorrowD.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })} (${tomorrowD.toISOString().split("T")[0]})
- Next 7 days:
${next7}
Earlier messages in the chat history may refer to "tomorrow" or "this week" relative to an older date — always resolve relative dates using the anchors above, never from past messages.

## Only act on the parent's NEWEST message (critical)
- The chat history is CONTEXT ONLY. Every earlier request in it has ALREADY been handled. Never save, re-save, re-announce or reply about an earlier request again.
- Each earlier message is labelled with when it was sent, e.g. "[earlier message — sent Tue 30 Sep, 08:12]". A "tomorrow" in an old message means the day after THAT date, not after today. Never copy these labels into your reply.
- The parent's new message is the final one, marked "=== NEW MESSAGE ===". Only save things that message asks for (or that it answers, if you had just asked the parent a question).
- Your reply must only talk about what the new message asked. Don't mention other children or older items from history.
- If the new message asks for several things, call a save tool for EACH of them before replying. You can call tools over several steps — never write "let me save…" or "I'll now save…": do the save, then say what was saved.

## Always use children's names (HARD RULE)
You don't know any child's gender. Always refer to a child by first name — never "he", "she", "his", "her", "him", "they" or "their" for a child. If a parent writes "she needs…", work out which child from context, but your reply uses the name (e.g. "Rosa's swim bag", not "her swim bag"). Write item summaries the same way ("Jude needs the recorder", not "Jude needs her recorder").

## One-off or every week?
Pass the item to the save tool as the parent described it; the system decides one-off vs weekly and will ask the parent if it's unclear, or tell you if it's already on the list.

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
- If the tool result contains "POSSIBLE_DUPLICATE", ask the parent naturally whether it's the same thing (e.g. "Is that the same as the swimming you've already got on Tuesday?") — don't claim either way.
- If the result says it was not saved because of an error, say so warmly and specifically, e.g. "Sorry, I couldn't save Jude's PE kit just then — could you send it again?". Only confirm a save when the result says "Saved".

## NEVER show system wording to parents
Tool results contain internal markers (NOT SAVED, POSSIBLE_DUPLICATE, ALREADY_SAVED, PENDING, TIMING, WAITING_FOR_PARENT, error codes). These are for you only — never copy them, or any technical wording, into your reply. Always talk like a friend.

## When a save can't go ahead yet — ask, never refuse
- No child named and the family has 2+ children → don't guess: call ask_parent_to_confirm with the item(s) and ask "Is that for Harry, Jude or both?" (real names). One-child family → just use that child.
- "Both", "the kids", "all of them", "everyone" → save for every child, no question.
- Pronouns ("she needs…", "he's got…") → if the recent conversation makes one child clearly the one meant, call ask_parent_to_confirm proposing that child ("For Rosa?"); otherwise ask which child.
- Vague references ("same again next week", "the usual", "she needs her bag") → use the existing reminders, notes and recent conversation to work out the most likely meaning, then call ask_parent_to_confirm with the exact item(s) you'd save and a natural question like "Do you mean Rosa's swimming kit on Tuesday again?". Never save until the parent says yes.
- If a save result says the item isn't in the latest message: if it was an old request from history, drop it silently and just reply to what the parent actually said; if the latest message is just vague, use ask_parent_to_confirm instead. Never tell the parent something was refused.

## Upcoming school events (next 14 days)
${upcomingEventsSummary}

IMPORTANT: This events list is purely informational — it helps you answer questions like "what's coming up", but it does NOT mean a reminder will automatically be sent for any of these events. The real reminders are the "Personal reminders set up for their children", "School-wide recurring reminders", and "Things this parent has told you about" sections above. If a parent explicitly asks to be reminded about something that only appears in this events list (and isn't already covered by an existing personal reminder, school-wide reminder, or parent note with a matching date), you MUST call save_parent_note with the correct child_name and date to actually create a real reminder. Never tell a parent something is "already saved" or "already covered" just because it appears in this passive events list.

## Things this parent has told you about (upcoming)
${upcomingNotesSummary}

## When a parent asks you to set up or change a reminder
Use the save_child_reminder tool to save it. Always confirm back what you've saved in a friendly way.

## Reminder timing — always describe it accurately
When confirming a saved reminder, packed lunch or note, describe the timing accurately: packed lunches and notes always get a reminder the evening before AND the morning of. For save_child_reminder, describe it based on the reminder_time you set ("both" = evening before and morning of). Never say "I'll remind you in the morning" unless the reminder is genuinely morning-only.
Evening reminders go out at 6pm UK time the evening before; morning reminders at 7am UK time on the day. Save results include a TIMING line — repeat that timing exactly (or say nothing about timing if it tells you not to) and don't work it out yourself. Only ever mention upcoming reminders, positively. Never add lines about reminders that won't go out or have already gone ("tonight's reminder won't go out", "it's after 6pm so…").

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
    name: "ask_parent_to_confirm",
    description: "Use when you can't safely save yet: the child isn't clear (2+ children, none named), a pronoun needs confirming, or the message is vague ('same again next week', 'the usual'). Stores the exact item(s) you'd save so that when the parent replies 'yes', a child's name, or 'both', they're saved straight away without repeating details. Your reply must then be just the natural question.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The natural question you'll ask, e.g. 'Is that for Harry, Jude or both?' or 'Do you mean Rosa's swimming kit on Tuesday again?'" },
        proposed_children: { type: "array", items: { type: "string" }, description: "Child first names you're proposing (for 'yes'). Empty if you're asking which child." },
        items: {
          type: "array",
          description: "The save calls you'd make once confirmed (child_name may be left out if asking which child).",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: ["save_child_reminder", "save_parent_note", "save_weekly_lunch_plan"] },
              args: { type: "object", description: "Exactly the arguments for that save tool." },
            },
            required: ["tool", "args"],
          },
        },
      },
      required: ["question", "items"],
    },
  },
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
          description: "'replace' (default) = these are the full week's packed lunch days (e.g. answering the Sunday check-in). 'add' = add these extra packed lunch days to the existing plan. 'remove' = switch the days in school_dinner_days back to school dinners.",
        },
        school_dinner_days: {
          type: "array",
          items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
          description: "Only for mode 'remove': ONLY the day(s) switching to school dinners (e.g. 'school dinners tomorrow' on a Monday → ['Tuesday']). Never the days that stay packed lunch. Set packed_lunch_days to the same days.",
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
  label?: string;       // parent-facing description of the item
  when?: string;        // parent-facing upcoming reminder timing
}
const okResult = (action: ToolAction, summary: string, text: string = summary, failed = false): ToolResult =>
  ({ ok: true, action, summary, text, failed });
const failResult = (text: string, action: ToolAction = "not_saved"): ToolResult =>
  ({ ok: false, action, summary: text, text, failed: action === "not_saved" });
const isSuccessResult = (r: ToolResult) => r.ok;
const isFailResult = (r: ToolResult) => !!r.failed;

/** Reply built only from what the tools actually did — never claims unconfirmed success, never system words. */
function buildHonestReply(results: ToolResult[], pendingQuestion?: string | null): string {
  const saved = results.filter((r) => r.ok && r.action !== "no_change");
  const already = results.filter((r) => r.ok && r.action === "no_change");
  const failed = results.filter((r) => r.failed);
  const parts: string[] = [];
  if (saved.length) parts.push(confirmationLine(saved));
  if (already.length) parts.push(`That's already on the list: ${already.map((r) => r.label || "that").join(" and ")} 👍`);
  if (failed.length) parts.push(`Sorry, I couldn't save ${failed.map((r) => r.label || "that").join(" or ")} just then — could you send it again? 🙏`);
  if (pendingQuestion) parts.push(pendingQuestion);
  if (!parts.length) {
    if (results.some((r) => r.action === "pending")) return "Just to check before I save it — which child is that for? 😊";
    return "Sorry, I couldn't save that just then — could you send it again? 🙏";
  }
  return parts.join(" ");
}

/** "Got it, Jude's PE kit for Wednesday 7th is saved ✅" — one short line, built only from real save results. */
function confirmationLine(saved: ToolResult[]): string {
  const labels = [...new Set(saved.map((r) => r.label || "that"))];
  const list = labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `Got it, ${list} ${labels.length > 1 ? "are" : "is"} saved ✅`;
}

/** Every reply replacement goes through here so it's always audited. */
async function replaceReply(
  original: string, results: ToolResult[], phone: string, path: string, decision: string, pendingQuestion?: string | null,
): Promise<string> {
  const honest = buildHonestReply(results, pendingQuestion);
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

/** Exact, code-computed reminder timing for a dated item, so the reply never guesses. */
function reminderTimingFor(dateIso: string): string {
  const p = upcomingReminderPhrase(dateIso);
  return p ? `TIMING (say only this about timing): "${p}"` : "TIMING: don't mention reminder timing at all.";
}

/** Timing of the first upcoming reminder for a weekly item, computed in code. */
function nextWeeklyTiming(day: string, when: string): string {
  const ukToday = nowD().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const base = new Date(`${ukToday}T12:00:00Z`);
  for (let i = 0; i < 8; i++) {
    const d = new Date(base); d.setUTCDate(base.getUTCDate() + i);
    if (d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }) !== day) continue;
    const t = reminderTimingFor(d.toISOString().slice(0, 10));
    if (t.includes("don't mention")) continue; // look at next week's occurrence
    if (when === "morning") return `TIMING: the first reminder is at 7am on ${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}, then every week.`;
    return t.replace("TIMING (say only this about timing):", "TIMING (first occurrence, then every week — say only this about timing):");
  }
  return "";
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
    // Same activity = same item tokens ("PE kit" == "PE kit needed"), not just an identical title.
    const { data: childRows, error: lookupErr } = await supabase
      .from("child_reminders")
      .select("id, day_of_week, title")
      .eq("child_id", child.id);
    const existingRows = (childRows ?? []).filter((r: any) =>
      r.title === toolArgs.title || matchItem(r.title, String(toolArgs.title), context.children.map((c) => c.first_name)) === "exact");
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
      `${verb} reminder for ${toolArgs.child_name}: ${toolArgs.title} on ${toolArgs.day_of_week}` +
        (toolArgs.recurrence_interval === 2 ? "" : `. ${nextWeeklyTiming(toolArgs.day_of_week, toolArgs.reminder_time)}`),
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
      parts.push(`Saved note: ${toolArgs.summary} on ${toolArgs.date}${names.length > 0 ? ` for ${names.join(" and ")}` : ""}. ${reminderTimingFor(toolArgs.date)}`);
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
      }).format(nowD());
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
    let given = normDays(toolArgs.packed_lunch_days);
    if (mode === "remove") {
      if (Array.isArray(toolArgs.school_dinner_days)) given = normDays(toolArgs.school_dinner_days);
      // The days being switched to school dinners must be the ones the parent named.
      const g = ((context as any).__grounding || "").toLowerCase();
      if (g) {
        const ukToday = nowD().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
        const dayOf = (offset: number) => { const d = new Date(`${ukToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }); };
        const named = new Set(DAY_ORDER.filter((d) => new RegExp(`\\b${d.toLowerCase()}`).test(g)));
        if (/\btomorrow\b/.test(g)) named.add(dayOf(1));
        if (/\btoday\b/.test(g)) named.add(dayOf(0));
        if (named.size && !given.every((d) => named.has(d))) {
          return failResult(`NOT SAVED: for mode 'remove', school_dinner_days must be only the day(s) switching to school dinners (${[...named].join(", ")}), not the days that stay packed lunch. Call again with school_dinner_days set to those days.`);
        }
      }
    }

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
    (context as any).__lastLunchDays = days;

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

// ── History framing: old messages are dated context, the new one is marked ──
function historyLabel(at?: string): string {
  if (!at) return "[earlier message]";
  const d = new Date(at);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  return `[earlier message — sent ${day}, ${time}]`;
}
function buildClaudeMessages(history: ConversationMessage[], incoming: string): any[] {
  const msgs: any[] = history.map((m) => ({ role: m.role, content: `${historyLabel(m.at)} ${m.content}` }));
  const nowLabel = historyLabel(nowD().toISOString()).replace("earlier message — sent", "sent now");
  const current = `=== NEW MESSAGE === ${nowLabel}\nEverything above is earlier history that has already been handled. Act ONLY on this message:\n\n${incoming}`;
  // Claude requires alternating roles; merge if the last history item is also from the user.
  if (msgs.length && msgs[msgs.length - 1].role === "user") {
    msgs[msgs.length - 1] = { role: "user", content: `${msgs[msgs.length - 1].content}\n\n${current}` };
  } else msgs.push({ role: "user", content: current });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

// ── Grounding: every save must come from the parent's latest message ──
const SAVE_TOOLS = new Set(["save_child_reminder", "save_parent_note", "save_weekly_lunch_plan"]);
function stemWords(text: string): string[] {
  return (text || "").toLowerCase().replace(/'s\b/g, "").split(/[^a-z]+/).filter((w) => w.length >= 2);
}
/** Returns null if grounded, else the reason it isn't. */
function checkGrounding(toolName: string, args: any, grounding: string, childNames: string[]): string | null {
  const g = stemWords(grounding);
  const gSet = new Set(g);
  const names = childNames.map((n) => n.toLowerCase());
  const child = (args?.child_name || "").toString().toLowerCase();
  const namesInMsg = names.filter((n) => gSet.has(n));
  if (child && namesInMsg.length > 0 && !namesInMsg.includes(child)) {
    return `child "${args.child_name}" isn't mentioned (message mentions ${namesInMsg.join(", ")})`;
  }
  if (toolName === "save_weekly_lunch_plan") {
    return /\b(lunch|lunches|dinner|dinners|packed)\b/i.test(grounding) ? null : "no lunch/dinner mentioned";
  }
  const item = toolName === "save_parent_note" ? args?.summary : args?.title;
  const keys = [...itemTokens(item || "", childNames)];
  if (keys.length === 0) return null;
  const hit = keys.some((k) => g.some((w) => {
    const a = w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    if (a === k) return true;
    const n = Math.min(a.length, k.length);
    return n >= 4 && a.slice(0, 4) === k.slice(0, 4);
  }));
  return hit ? null : `none of "${keys.join(", ")}" appear in the parent's latest message`;
}

const FUTURE_ACTION = /\b(let me|i'?ll|i will|i'?m going to|going to|now)\s+(just\s+)?(save|add|set|note|pop|put|log|update|sort|get (that|it|this))\b|\b(now|currently)\s+saving\b|\bsaving (that|it|this|now)\b/i;

async function enforceTurnHonesty(reply: string, results: ToolResult[], phone: string, path: string): Promise<string> {
  if (reply && FUTURE_ACTION.test(reply)) {
    if (results.length === 0) {
      await logDedupDecision({ phone, childName: null, tool: `reply_guard_${path}`, newItem: "(no tool calls)", decision: "future_action_claim_blocked", match: { table: "model_reply", id: "no match", text: reply.slice(0, 2000) } });
      return "Sorry — I haven't saved anything yet. Could you send that to me again? 🙏";
    }
    return await replaceReply(reply, results, phone, path, "future_action_claim_blocked");
  }
  return await enforceHonestReply(reply, results, phone, path);
}

// ── Parent-facing wording helpers (no system words ever reach a parent) ──
const SYSTEM_WORDS = /NOT SAVED|POSSIBLE_DUPLICATE|ALREADY_SAVED|PENDING|TIMING|WAITING_FOR_PARENT|ASK_WHICH_CHILD|CONFIRM_STORED|\bungrounded\b|tool_result|recurrence_interval|anchor_date|child_name/i;
const PLURAL_CHILDREN = /\b(both|both kids|the kids|all the kids|my kids|the children|all of them|all three|everyone|each of them)\b/i;
const fmtLongDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const fmtDayOrdinal = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`); const n = d.getUTCDate();
  const suf = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })} ${n}${suf}`;
};
const fmtShortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/** "I'll remind you at 6pm on Tuesday and 7am on Wednesday." — only upcoming reminders, never negatives. */
function upcomingReminderPhrase(dateIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso || "")) return "";
  const ukToday = nowD().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const ukHour = Number(nowD().toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }));
  const eve = new Date(`${dateIso}T12:00:00Z`); eve.setUTCDate(eve.getUTCDate() - 1);
  const eveIso = eve.toISOString().slice(0, 10);
  const evePassed = eveIso < ukToday || (eveIso === ukToday && ukHour >= 18);
  const mornPassed = dateIso < ukToday || (dateIso === ukToday && ukHour >= 7);
  if (mornPassed) return "";
  const dayWord = (iso: string) => iso === ukToday ? "today" : (() => { const t = new Date(`${ukToday}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10) === iso ? "tomorrow" : `on ${fmtShortDay(iso)}`; })();
  if (evePassed) return `I'll remind you at 7am ${dayWord(dateIso)}.`;
  return `I'll remind you at 6pm ${dayWord(eveIso)} and 7am ${dayWord(dateIso)}.`;
}

/** Short parent-facing description of what a save call was for. */
function tidyItem(text: string, child: string): string {
  let t = String(text || "").trim().replace(/\s+needed$/i, "");
  const m = t.match(/^(\w+)\s+(?:needs|has got|has|needs to bring)\s+(?:his|her|their|a|an|the)?\s*(.+)$/i);
  if (m && (!child || m[1].toLowerCase() === child.toLowerCase())) t = `${m[1]}'s ${m[2]}`;
  else if (child && !new RegExp(`\\b${child}\\b`, "i").test(t)) t = `${child}'s ${/^[A-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1)}`;
  return t;
}
function friendlyLabel(tool: string, args: any): string {
  const child = args?.child_name ? String(args.child_name) : "";
  if (tool === "save_parent_note") {
    const s = tidyItem(String(args?.summary || "that"), child);
    return `${s}${/^\d{4}-\d{2}-\d{2}$/.test(args?.date || "") ? ` for ${fmtDayOrdinal(args.date)}` : ""}`;
  }
  if (tool === "save_child_reminder") {
    const every = args?.recurrence_interval === 2 ? "every other" : "every";
    return `${tidyItem(String(args?.title || "reminder"), child)} ${every} ${args?.day_of_week || ""}`.trim();
  }
  if (tool === "save_weekly_lunch_plan") {
    const days: string[] = Array.isArray(args?.packed_lunch_days) ? args.packed_lunch_days : [];
    if (args?.mode === "remove") return `${child ? child + "'s " : ""}school dinners on ${days.join(" and ")}`;
    return days.length ? `${child ? child + "'s " : ""}packed lunch on ${days.join(" and ")}` : `school dinners all week for ${child}`;
  }
  return "that";
}

function whichChildQuestion(names: string[], proposed: string[] | null, label: string): string {
  if (proposed && proposed.length) return `Just to check — is ${label ? `the ${label.replace(/^.*?'s /, "")}` : "that"} for ${proposed.join(" and ")}? 😊`;
  const list = names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `Is that for ${list}${names.length >= 2 ? " or both" : ""}? 😊`.replace(" or both?", names.length > 2 ? " or all of them?" : " or both?");
}

// ── One-off vs recurring: decided in code, asked when unclear ──
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RECURRING_WORDS = /\b(every|each|weekly|fortnightly|every other|every week|moved|moving|now on|from now on|always|regularly)\b|\b(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i;
const ONE_OFF_WORDS = /\b(just|only|once|one-?off|one off)\b|\b(this|next) (coming )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const BRING_WORDS = /\b(needs?|bring|take|pack)\b/i;
const GENERIC_ITEM = new Set(["kit", "bag", "stuff", "thing", "things", "clothes", "needed", "club", "lesson", "lessons"]);

const ukTodayIso = () => nowD().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const weekdayOf = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
function nextDateFor(day: string): string {
  const t = new Date(`${ukTodayIso()}T12:00:00Z`);
  for (let i = 0; i < 7; i++) { const d = new Date(t); d.setUTCDate(t.getUTCDate() + i); if (weekdayOf(d.toISOString().slice(0, 10)) === day) return d.toISOString().slice(0, 10); }
  return ukTodayIso();
}
function dayWordFor(iso: string): string {
  const today = ukTodayIso();
  const tm = new Date(`${today}T12:00:00Z`); tm.setUTCDate(tm.getUTCDate() + 1);
  if (iso === today) return "today";
  if (iso === tm.toISOString().slice(0, 10)) return "tomorrow";
  return `on ${fmtLongDate(iso)}`;
}
function activityTokens(text: string, childNames: string[]): string[] {
  return [...itemTokens(text, childNames)].filter((t) => !GENERIC_ITEM.has(t) && !["his", "her", "their", "him", "she", "he", "they"].includes(t));
}
function sameActivity(a: string, b: string, childNames: string[]): boolean {
  const x = activityTokens(a, childNames), y = activityTokens(b, childNames);
  return x.some((p) => y.some((q) => p === q || (p.length >= 4 && q.length >= 4 && p.slice(0, 4) === q.slice(0, 4))));
}
/** "Jude needs his swim bag" → "Swim bag" */
function itemTitle(tool: string, args: any): string {
  if (tool === "save_child_reminder") return String(args.title || "Reminder");
  let s = String(args.summary || "").trim();
  s = s.replace(/^\w+\s+(needs to bring|needs|has got|has|is having|is)\s+/i, "").replace(/^(his|her|their|a|an|the)\s+/i, "");
  s = s.replace(/\s+(tomorrow|today|on \w+day.*|this \w+day.*|next \w+day.*)$/i, "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Reminder";
}

/** The part of the message about this item ("…every Monday, and Jude needs the recorder this Friday"). */
function clauseFor(sourceText: string, itemText: string, childName: string, childNames: string[]): string {
  const parts = sourceText.split(/[,.;!?\n]+|\band\b|\balso\b|\bplus\b/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return sourceText;
  const hits = parts.filter((x) => sameActivity(x, itemText, childNames));
  const byChild = childName ? parts.filter((x) => new RegExp(`\\b${childName}\\b`, "i").test(x)) : [];
  const pick = hits.length ? hits : byChild;
  return pick.length ? pick.join(" ") : sourceText;
}

type SaveDecision =
  | { kind: "reject"; result: ToolResult }
  | { kind: "save"; tool: string; args: any }
  | { kind: "existing"; result: ToolResult }
  | { kind: "ask"; items: Array<{ tool: string; args: any }>; question: string };

async function decideSave(tool: string, args: any, sourceText: string, context: MontyContext, freqOverride?: "once" | "weekly" | null): Promise<SaveDecision> {
  if (tool === "save_weekly_lunch_plan" || args?.recurrence_interval === 2) return { kind: "save", tool, args };
  const childNames = context.children.map((c) => c.first_name);
  const childName = args?.child_name ? String(args.child_name) : "";
  const child = context.children.find((c) => c.first_name.toLowerCase() === childName.toLowerCase());
  let date: string | null = null, day: string | null = null;
  if (tool === "save_parent_note") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args?.date || "")) return { kind: "save", tool, args };
    date = args.date; day = weekdayOf(date!);
  } else {
    if (!WEEKDAYS.includes(args?.day_of_week)) return { kind: "save", tool, args };
    day = args.day_of_week; date = nextDateFor(day!);
  }
  const title = itemTitle(tool, args);
  const itemText = tool === "save_parent_note" ? String(args.summary || title) : title;

  // a) Already covered by an active weekly reminder for this child on that weekday?
  if (child) {
    const { data: rems } = await supabase.from("child_reminders").select("id, title, recurrence_interval")
      .eq("child_id", child.id).eq("day_of_week", day).eq("active", true);
    const hit = (rems ?? []).find((r: any) => sameActivity(r.title, itemText, childNames));
    if (hit) {
      const label = friendlyLabel("save_child_reminder", { child_name: child.first_name, title: hit.title, day_of_week: day, recurrence_interval: hit.recurrence_interval });
      await logDedupDecision({ phone: "", childName: child.first_name, tool, date, newItem: itemText, decision: "covered_by_weekly_reminder", match: { table: "child_reminders", id: hit.id, text: hit.title } });
      return { kind: "existing", result: { ok: true, action: "no_change", label, summary: label,
        text: `ALREADY_SAVED: this is already on the list as a weekly reminder — ${label}. Nothing new saved. Tell the parent: "That's already on the list: ${label} 👍"` } };
    }
  }
  const asNote = { tool: "save_parent_note", args: { summary: tool === "save_parent_note" ? args.summary : `${childName ? childName + " needs " : ""}${/^[A-Z]{2}/.test(title) ? title : title.charAt(0).toLowerCase() + title.slice(1)}`, date, ...(childName ? { child_name: childName } : {}) } };
  const asWeekly = { tool: "save_child_reminder", args: { child_name: childName, title, emoji: args.emoji || "📌", day_of_week: day, reminder_time: args.reminder_time || "both", recurrence_interval: 1 } };
  if (freqOverride === "weekly" && childName) return { kind: "save", ...asWeekly };
  if (freqOverride === "once") return { kind: "save", ...asNote };
  const clause = clauseFor(sourceText, itemText, childName, childNames);
  if (/\b(every other|fortnight(ly)?|alternate)\b/i.test(clause)) {
    return { kind: "reject", result: failResult("NOT SAVED: this is fortnightly. Ask the parent when the next one is, then save with recurrence_interval=2 and that anchor_date.", "no_change") };
  }
  const recurring = RECURRING_WORDS.test(clause);
  const oneOff = ONE_OFF_WORDS.test(clause);
  if (recurring && !oneOff) return childName ? { kind: "save", ...asWeekly } : { kind: "save", tool, args };
  if (oneOff) return { kind: "save", ...asNote };
  // d) Unclear. A dated event that isn't something to bring (e.g. a dentist appointment) is a one-off note.
  if (tool === "save_parent_note" && !BRING_WORDS.test(clause)) return { kind: "save", tool, args };
  if (!childName) return { kind: "save", tool, args };
  return { kind: "ask", items: [asNote, asWeekly], question: `${tidyItem(title, childName)} — just ${dayWordFor(date!)}, or every ${day}? 😊` };
}

/** "just on Thursday 8 October or every Thursday" when one-off vs weekly would need asking; null otherwise. */
function frequencyQuestionPart(tool: string, args: any, sourceText: string, childNames: string[]): string | null {
  if (tool === "save_weekly_lunch_plan" || args?.recurrence_interval === 2) return null;
  let date: string | null = null, day: string | null = null;
  if (tool === "save_parent_note") { if (!/^\d{4}-\d{2}-\d{2}$/.test(args?.date || "")) return null; date = args.date; day = weekdayOf(date!); }
  else { if (!WEEKDAYS.includes(args?.day_of_week)) return null; day = args.day_of_week; date = nextDateFor(day!); }
  const itemText = tool === "save_parent_note" ? String(args.summary || "") : String(args.title || "");
  const clause = clauseFor(sourceText, itemText, "", childNames);
  if (/\b(every other|fortnight(ly)?|alternate)\b/i.test(clause) || RECURRING_WORDS.test(clause) || ONE_OFF_WORDS.test(clause)) return null;
  if (tool === "save_parent_note" && !BRING_WORDS.test(clause)) return null;
  return `just ${dayWordFor(date!)} or every ${day}`;
}
function combinedQuestion(names: string[], freqPart: string): string {
  const list = names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return `Is that for ${list}, and ${freqPart}? 😊`;
}
const ONCE_REPLY = /\b(just|only|once|one-?off|this one|that day|this week|tomorrow|today)\b/i;
const WEEKLY_REPLY = /\b(every|weekly|each|always|regular(ly)?)\b|\bevery week\b/i;
function freqFromReply(message: string): "once" | "weekly" | null {
  const w = WEEKLY_REPLY.test(message), o = ONCE_REPLY.test(message.replace(/\bevery week\b/i, ""));
  if (w && !o) return "weekly";
  if (o && !w) return "once";
  return null;
}

// ── Children are always named, never "he/she/his/her" ──
const CHILD_PRONOUN = /\b(he|she|his|her|him|hers|himself|herself)\b/i;
function nameNotPronoun(text: string, childNames: string[]): string {
  if (!text || !CHILD_PRONOUN.test(text)) return text;
  const named = childNames.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(text));
  if (named.length !== 1) return named.length > 1 ? text.replace(/\b(his|her)\b/gi, "the") : text;
  const n = named[0];
  return text
    .replace(new RegExp(`\\b(${n})(\\s+\\w+(?:\\s+\\w+)?\\s+)(his|her)\\b`, "gi"), (_m, a, mid) => `${a}${mid}the`)
    .replace(/\b(his|her)\b/gi, `${n}'s`)
    .replace(/\b(he|she)\b/gi, n)
    .replace(/\b(him|himself|herself|hers)\b/gi, n);
}

// ── Pending actions for text messages (stored on the conversation, 24h expiry) ──
interface PendingAction {
  kind: "which_child" | "confirm" | "frequency" | "move";
  ask_frequency?: boolean;             // which-child question also asked one-off vs weekly
  freq?: "once" | "weekly";            // frequency already answered (child still missing)
  move?: { to: string; options: Array<{ id: string; child: string; title: string; day: string }> };
  source_text?: string; // the parent's original message, for the one-off/weekly decision
  items: Array<{ tool: string; args: any }>;
  proposed: string[] | null; // proposed child names (for "yes")
  question: string;
  created_at: string;
}
async function getConversationRow(phone: string) {
  const { data } = await supabase.from("conversations").select("id, context").eq("phone_number", phone).maybeSingle();
  return data as { id: string; context: any } | null;
}
async function setPendingAction(phone: string, p: PendingAction | null) {
  const row = await getConversationRow(phone);
  if (!row) return;
  await supabase.from("conversations").update({ context: { ...(row.context || {}), pending_action: p } }).eq("id", row.id);
}

async function tryResolvePendingAction(phone: string, message: string, context: MontyContext): Promise<string | null> {
  const row = await getConversationRow(phone);
  const p: PendingAction | null = row?.context?.pending_action ?? null;
  if (!row || !p) return null;
  if (nowD().getTime() - new Date(p.created_at).getTime() > 24 * 3600_000) { await setPendingAction(phone, null); return null; }
  if (p.kind === "move") return await resolveMovePending(phone, p, message);

  if (p.kind === "frequency") {
    const once = /\b(just|only|once|one-?off|this one|that day|tomorrow|today)\b/i.test(message);
    const weekly = /\b(every|weekly|each|week|always|regular(ly)?)\b/i.test(message);
    if (!once && !weekly) {
      if (/^\s*(yes|yep|yeah|ok|okay|sure)\b/i.test(message) && message.trim().split(/\s+/).length <= 3) return nameNotPronoun(p.question, context.children.map((c) => c.first_name)); // still ambiguous: ask again
      await setPendingAction(phone, null);
      await logDedupDecision({ phone, childName: null, tool: "pending_action", newItem: JSON.stringify(p.items).slice(0, 500), decision: "pending_dropped_topic_change", match: { table: "inbound_message", id: "no match", text: message.slice(0, 300) } });
      return null;
    }
    await setPendingAction(phone, null);
    const picks = p.items.filter((i) => i.tool === (once ? "save_parent_note" : "save_child_reminder"));
    const rs: ToolResult[] = [];
    for (const pick of picks.length ? picks : [p.items[0]]) rs.push(await runSave(pick.tool, pick.args, context, phone));
    return nameNotPronoun(buildHonestReply(rs), context.children.map((c) => c.first_name));
  }

  const words = message.trim().split(/\s+/).length;
  const short = words <= 7;
  const names = context.children.map((c) => c.first_name).filter((n) => new RegExp(`\\b${n}\\b`, "i").test(message));
  const plural = PLURAL_CHILDREN.test(message);
  const yes = /^\s*(yes|yep|yeah|yea|yup|yes please|correct|that'?s right|exactly|sure|ok|okay|please|go on|right|y)\b/i.test(message);
  let targets: string[] | null = null;
  if (short && names.length && !/^\s*(no|nope|nah)\b/i.test(message)) targets = names;
  else if (short && names.length) targets = names; // "no, Harry" → Harry
  else if (short && plural) targets = context.children.map((c) => c.first_name);
  else if (short && yes) targets = p.proposed ?? (p.kind === "confirm" ? [] : null);

  const replyFreq = p.ask_frequency ? freqFromReply(message) : null;
  const freq = replyFreq ?? p.freq ?? null;
  // Only the frequency answered (no child yet) → keep it, ask just for the child.
  if (targets === null && p.ask_frequency && replyFreq && short) {
    const q = whichChildQuestion(context.children.map((c) => c.first_name), null, "");
    await setPendingAction(phone, { ...p, freq: replyFreq, question: q, created_at: p.created_at });
    return q;
  }
  // Anything else (a "no", or a change of topic) → drop the pending item, don't re-ask.
  await setPendingAction(phone, null);
  if (targets === null) {
    (context as any).__droppedPending = true;
    await logDedupDecision({ phone, childName: null, tool: "pending_action", newItem: JSON.stringify(p.items).slice(0, 500), decision: "pending_dropped_topic_change", match: { table: "inbound_message", id: "no match", text: message.slice(0, 300) } });
    return null;
  }

  const results: ToolResult[] = [];
  // One save per distinct item per chosen child (the model may list the same item once per child).
  const seen = new Set<string>();
  const items = p.items.filter((it) => {
    const { child_name: _c, ...rest } = it.args || {};
    const k = `${it.tool}|${JSON.stringify(rest)}`;
    if (targets!.length && seen.has(k)) return false;
    seen.add(k); return true;
  });
  const asks: Array<{ child: string | null; d: Extract<SaveDecision, { kind: "ask" }> }> = [];
  for (const item of items) {
    const childList = targets.length ? targets : [item.args?.child_name ?? null];
    for (const child of childList) {
      const args = { ...item.args, ...(child ? { child_name: child } : {}) };
      if (item.tool === "save_parent_note" && !child) delete args.child_name;
      const d = await decideSave(item.tool, args, p.source_text || "", context, freq);
      if (d.kind === "existing") { results.push(d.result); continue; }
      if (d.kind === "reject") continue;
      if (d.kind === "ask") { asks.push({ child, d }); continue; }
      const r = await runSave(d.tool, d.args, context, phone);
      results.push(r);
    }
  }
  if (asks.length) {
    // Child now known, but one-off vs weekly isn't: ask once, for every child chosen.
    let question = asks[0].d.question;
    if (asks.length > 1) {
      const kids = asks.map((a) => a.child).filter(Boolean) as string[];
      question = question.replace(/^.*? — /, `${itemTitle(asks[0].d.items[1].tool, asks[0].d.items[1].args)} for ${kids.join(" and ")} — `);
    }
    await setPendingAction(phone, { kind: "frequency", items: asks.flatMap((a) => a.d.items), proposed: null, question, created_at: nowD().toISOString(), source_text: p.source_text });
    const done = results.length ? buildHonestReply(results) + " " : "";
    return nameNotPronoun(done + question, context.children.map((c) => c.first_name));
  }
  return nameNotPronoun(buildHonestReply(results), context.children.map((c) => c.first_name));
}

/** Single place every save goes through (forced DB failure switch for tests lives here). */
async function runSave(tool: string, args: any, context: MontyContext, phone: string): Promise<ToolResult> {
  const names = context.children.map((c) => c.first_name);
  if (typeof args?.summary === "string") args = { ...args, summary: nameNotPronoun(args.summary, names) };
  if (typeof args?.title === "string") args = { ...args, title: args.title.replace(/^(his|her|their)\s+/i, "") };
  const label = friendlyLabel(tool, args);
  let r: ToolResult;
  if ((testStore.getStore() as any)?.failDb === true && SAVE_TOOLS.has(tool)) {
    r = failResult(`NOT SAVED: database error (forced test failure) for ${label}. Tell the parent warmly you couldn't save ${label} just then and ask them to send it again.`);
  } else {
    r = await executeTool(tool, args, context, phone);
  }
  r.label = label;
  if (tool === "save_parent_note") r.when = upcomingReminderPhrase(args?.date);
  testStore.getStore()?.toolCalls.push({ name: tool, input: args, ok: r.ok, action: r.action, text: r.text });
  return r;
}

// ── AI reply generator ────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 5;

async function callClaude(body: Record<string, unknown>) {
  const t0 = Date.now();
  if ((testStore.getStore() as any)?.failClaude === true) {
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. (forced test failure)" } }), { status: 400 });
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  console.log(`[Claude] ${body.model} ${r.status} in ${ms}ms`);
  const st: any = testStore.getStore();
  if (st && r.ok) {
    try { const j = await r.clone().json(); const u = j.usage; st.usage = st.usage || { input: 0, output: 0, calls: 0, ms: 0 }; st.usage.ms = (st.usage.ms || 0) + ms; st.usage.model = body.model; if (j.stop_reason === "max_tokens") st.usage.truncated = (st.usage.truncated || 0) + 1; st.usage.input += u?.input_tokens || 0; st.usage.output += u?.output_tokens || 0; st.usage.calls++; } catch { /* ignore */ }
  }
  return r;
}

async function generateReply(
  incomingMessage: string,
  history: ConversationMessage[],
  context: MontyContext,
  phone: string
): Promise<string> {
  const systemPrompt = buildSystemPrompt(context);
  const model = montyClaudeModel();
  const messages = buildClaudeMessages(history, incomingMessage);

  // Grounding text: the new message, plus Monty's last reply only if it asked a question
  // (so "Jude" answering "which child?" still counts).
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  let grounding = incomingMessage;
  if (lastAssistant && /\?/.test(lastAssistant.content)) grounding += "\n" + lastAssistant.content;
  const childNames = context.children.map((c) => c.first_name);
  (context as any).__grounding = grounding;

  const res = await callClaude({ model, max_tokens: 500, system: systemPrompt, messages, tools });
  const rawText1 = await res.text();
  console.log("[Claude] Raw response text (round 1):", rawText1);
  if (!res.ok) {
    await logClaudeFailure(phone, res.status, rawText1, "Claude API - initial reply");
    return await outageReply(phone, "text", incomingMessage, `${res.status} ${rawText1.slice(0, 500)}`);
  }
  let data = JSON.parse(rawText1);

  // Guard: no "already saved" without a database check — force a tool call.
  if (data.stop_reason !== "tool_use") {
    const firstText = data.content?.find((b: any) => b.type === "text")?.text || "";
    if (ALREADY_CLAIM.test(firstText)) {
      await logDedupDecision({
        phone, childName: null, tool: "reply_guard", newItem: incomingMessage.slice(0, 300),
        decision: "unverified_claim_blocked", match: { table: "model_reply", id: "no match", text: firstText.slice(0, 300) },
      });
      const retry = await callClaude({
        model, max_tokens: 500, messages, tools, tool_choice: { type: "any" },
        system: systemPrompt + "\n\nSYSTEM CHECK: You must not claim anything is already saved without calling a save tool. Call the correct save tool now for what the parent just asked in the NEW MESSAGE; the tool checks the database for duplicates.",
      });
      if (!retry.ok) {
        const rt = await retry.text();
        await logClaudeFailure(phone, retry.status, rt, "Claude API - already-claim retry");
        return await outageReply(phone, "text", incomingMessage, `${retry.status} ${rt.slice(0, 500)}`);
      }
      data = await retry.json();
    }
  }

  const structuredResults: ToolResult[] = [];
  const convo = [...messages];
  const multiChild = context.children.length >= 2;
  const pluralMsg = PLURAL_CHILDREN.test(incomingMessage);
  const namesInGrounding = childNames.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(grounding));
  let pending: PendingAction | null = null;
  const addPending = (kind: PendingAction["kind"], items: PendingAction["items"], proposed: string[] | null, question: string) => {
    if (!pending) pending = { kind, items: [], proposed, question, created_at: nowD().toISOString(), source_text: incomingMessage };
    pending.items.push(...items);
    if (kind === "confirm" && pending.kind !== "frequency") pending.kind = "confirm";
    if (proposed?.length) pending.proposed = proposed;
    pending.question = question || pending.question;
  };
  let round = 1;
  while (data.stop_reason === "tool_use") {
    const toolResults: any[] = [];
    for (const block of data.content.filter((b: any) => b.type === "tool_use")) {
      let result: ToolResult;
      const input = block.input ?? {};
      if (block.name === "ask_parent_to_confirm") {
        const items = (Array.isArray(input.items) ? input.items : []).filter((i: any) => SAVE_TOOLS.has(i?.tool) && i.args && typeof i.args === "object");
        let proposed = Array.isArray(input.proposed_children) ? input.proposed_children.filter((n: string) => childNames.includes(n)) : [];
        if (childNames.length > 1 && proposed.length === childNames.length) proposed = []; // "Harry, Jude or both?" isn't a proposal
        if (items.length) {
          const fq = proposed.length || childNames.length < 2 ? null : frequencyQuestionPart(items[0].tool, items[0].args, incomingMessage, childNames);
          addPending(proposed.length ? "confirm" : "which_child", items, proposed.length ? proposed : null, fq ? combinedQuestion(childNames, fq) : String(input.question || ""));
          if (fq) pending!.ask_frequency = true;
        }
        result = { ok: false, action: "pending", summary: "", text: items.length
          ? "CONFIRM_STORED: nothing saved yet. Reply with just your natural question to the parent; their answer will save it."
          : "Nothing stored — include the item(s) you'd save." };
        testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: false, action: "pending", text: result.text });
      } else if (SAVE_TOOLS.has(block.name)) {
        const why = checkGrounding(block.name, input, grounding, childNames);
        const child = input.child_name ? String(input.child_name) : "";
        const needsChild = multiChild && !pluralMsg && (!child || !namesInGrounding.some((n) => n.toLowerCase() === child.toLowerCase()));
        if (why) {
          result = { ok: false, action: "not_saved", failed: false, summary: "",
            text: `NOT SAVED: not in the parent's latest message (${why}). If this is an old request from the history, drop it silently and don't mention it. If the latest message is just vague and you think this is what they mean, call ask_parent_to_confirm instead.` };
          await logDedupDecision({
            phone, childName: input.child_name ?? null, tool: block.name, date: input.date ?? null,
            newItem: JSON.stringify(input).slice(0, 500), decision: "ungrounded_save_blocked",
            match: { table: "inbound_message", id: "no match", text: incomingMessage.slice(0, 500) },
          });
          testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: false, action: "ungrounded_blocked", text: result.text });
        } else if (needsChild) {
          const proposed = child && childNames.includes(child) ? [child] : null;
          const args = { ...input }; if (!proposed) delete args.child_name;
          const fq = proposed ? null : frequencyQuestionPart(block.name, args, incomingMessage, childNames);
          const q = fq ? combinedQuestion(childNames, fq) : whichChildQuestion(childNames, proposed, friendlyLabel(block.name, args));
          addPending(proposed ? "confirm" : "which_child", [{ tool: block.name, args }], proposed, q);
          if (fq) pending!.ask_frequency = true;
          result = { ok: false, action: "pending", summary: "",
            text: `WAITING_FOR_PARENT: not saved yet — the child isn't clear. Stored for confirmation. Reply with just this question: "${q}"` };
          await logDedupDecision({ phone, childName: child || null, tool: block.name, newItem: JSON.stringify(input).slice(0, 500), decision: "child_unclear_asked", match: { table: "inbound_message", id: "no match", text: incomingMessage.slice(0, 500) } });
          testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: false, action: "child_unclear_asked", text: result.text });
        } else {
          if (multiChild && pluralMsg && block.name === "save_parent_note" && !child) delete input.child_name;
          const d = await decideSave(block.name, input, incomingMessage, context);
          if (d.kind === "reject") {
            result = d.result;
            testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: false, action: "rejected", text: result.text });
          } else if (d.kind === "existing") {
            result = d.result; structuredResults.push(result);
            testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: true, action: "covered_by_weekly_reminder", text: result.text });
          } else if (d.kind === "ask") {
            addPending("frequency", d.items, null, d.question);
            pending!.kind = "frequency";
            result = { ok: false, action: "pending", summary: "",
              text: `WAITING_FOR_PARENT: not saved yet — it's not clear if this is a one-off or every week. Reply with just this question: "${d.question}"` };
            testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: false, action: "frequency_asked", text: result.text });
          } else {
            result = await runSave(d.tool, d.args, context, phone);
            structuredResults.push(result);
          }
        }
      } else {
        result = await executeTool(block.name, input, context, phone);
        structuredResults.push(result);
        testStore.getStore()?.toolCalls.push({ name: block.name, input, ok: result.ok, action: result.action, text: result.text });
      }
      console.log(`Tool ${block.name} →`, JSON.stringify(result));
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result.text });
    }
    convo.push({ role: "assistant", content: data.content }, { role: "user", content: toolResults });

    if (round >= MAX_TOOL_ROUNDS) {
      if (pending) await setPendingAction(phone, pending);
      return await replaceReply("", structuredResults, phone, "text", "max_tool_rounds_replaced", (pending as PendingAction | null)?.question);
    }
    round++;
    const failNext = (testStore.getStore() as any)?.failFollowup === true;
    const next = failNext ? new Response("forced follow-up failure (test)", { status: 500 }) :
      await callClaude({ model, max_tokens: 500, system: systemPrompt, messages: convo, tools });
    const raw = await next.text();
    console.log(`[Claude] Raw response text (round ${round}):`, raw);
    if (!next.ok) {
      await logClaudeFailure(phone, next.status, raw, "Claude API - tool follow-up");
      if (pending) await setPendingAction(phone, pending);
      return await replaceReply("", structuredResults, phone, "text", "followup_failed_replaced", (pending as PendingAction | null)?.question);
    }
    try { data = JSON.parse(raw); } catch { return await replaceReply("", structuredResults, phone, "text", "followup_unparseable_replaced"); }
  }

  const text = data.content?.find((b: any) => b.type === "text")?.text?.trim() || "";
  const p = pending as PendingAction | null;
  if (p) {
    await setPendingAction(phone, p);
    // The reply must ask the question; it may only confirm things that really saved.
    let reply = text;
    if (p.kind === "frequency" || p.ask_frequency) {
      // One-off vs weekly (and, when combined, which child) is always asked in the same clear words.
      return await replaceReply(text, structuredResults, phone, "text", "frequency_question", p.question);
    }
    if (CHILD_PRONOUN.test(reply) && p.proposed?.length) {
      // Never ask "is she Rosa?" — ask about the item, by name.
      reply = whichChildQuestion(childNames, p.proposed, friendlyLabel(p.items[0].tool, { ...p.items[0].args, child_name: p.proposed[0] }));
      p.question = reply; await setPendingAction(phone, p);
      return reply;
    }
    if (!reply || !reply.includes("?") || SYSTEM_WORDS.test(reply) || FUTURE_ACTION.test(reply) ||
        (!structuredResults.some((r) => r.ok) && SUCCESS_CLAIM.test(reply))) {
      reply = await replaceReply(text, structuredResults, phone, "text", "pending_question_rebuilt", p.question || whichChildQuestion(childNames, p.proposed, ""));
    }
    return reply;
  }
  let reply: string;
  if (structuredResults.length === 0 && round === 1) {
    reply = text && FUTURE_ACTION.test(text) ? await enforceTurnHonesty(text, [], phone, "text")
      : text || await outageReply(phone, "text", incomingMessage, "empty AI reply");
  } else {
    reply = await enforceTurnHonesty(text, structuredResults, phone, "text");
  }
  if (SYSTEM_WORDS.test(reply)) reply = await replaceReply(reply, structuredResults, phone, "text", "system_words_blocked");
  // A failed save must be named specifically (e.g. "Jude's PE kit"), never a vague "that".
  const vagueFailure = structuredResults.filter((r) => r.failed && r.label).some((r) =>
    ![...itemTokens(r.label!, [])].some((t) => reply.toLowerCase().includes(t.slice(0, 4))));
  if (vagueFailure) reply = await replaceReply(reply, structuredResults, phone, "text", "vague_failure_rebuilt");
  // "Already on the list" must be said plainly, naming the existing reminder.
  if (structuredResults.some((r) => r.action === "no_change" && r.label) && !/already/i.test(reply)) {
    reply = await replaceReply(reply, structuredResults, phone, "text", "already_on_list_rebuilt");
  }
  // Parent moved on from our question → don't ask it again in this reply.
  if ((context as any).__droppedPending && !pending) {
    const kept = (reply.match(/[^.!?\n]+[.!?]*\s*/g) || [] as string[]).filter((x: string) =>
      !(/\?/.test(x) && /\b(is that|was that|which|who)\b/i.test(x) && childNames.filter((n) => x.includes(n)).length >= 1));
    if (kept.length) reply = kept.join("").trim();
  }
  // Short confirmations: any successful save → one code-built line (+ one answer sentence only if the parent asked a question).
  const saves = structuredResults.filter((r) => r.ok && r.action !== "no_change");
  if (saves.length && saves.every((r) => r.label)) {
    let extra = "";
    if (/\?/.test(incomingMessage)) {
      const sentence = ((text.match(/[^.!?\n]+[.!?]?/g) || []) as string[]).map((x) => x.trim())
        .find((x) => x.length > 3 && !SUCCESS_CLAIM.test(x) && !/remind you|✅/i.test(x) && !SYSTEM_WORDS.test(x));
      if (sentence && sentence.length <= 140) extra = " " + sentence;
    }
    reply = buildHonestReply(structuredResults) + extra;
  }
  return reply;
}

// ── Moving a weekly reminder to another day (decided in code, same row updated) ──
const MOVE_WORDS = /\b(moved|moving|changed|changing|switched|switching)\b|\bnow\s+(on\s+)?(a\s+)?(mon|tues|wednes|thurs|fri|satur|sun)days?\b/i;
const DAY_RE = /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi;
const dayName = (w: string) => WEEKDAYS.find((d) => d.toLowerCase().startsWith(w.toLowerCase().replace(/days?$/, ""))) ?? null;
const MOVE_FILLER = new Set(["moved", "moving", "changed", "changing", "switched", "switching", "now", "instead", "from", "day", "days", "has", "have", "been", "go", "goe", "will", "be", "it", "its", "that"]);

async function updateReminderDay(id: string, to: string): Promise<boolean> {
  if ((testStore.getStore() as any)?.failDb === true) return false;
  const { error } = await supabase.from("child_reminders").update({ day_of_week: to, active: true }).eq("id", id);
  return !error;
}
function moveLabel(o: { child: string; title: string }, to: string, childNames: string[]) {
  return `${tidyItem(o.title, o.child)} has moved to every ${to}`;
}

async function tryMoveReminder(phone: string, message: string, context: MontyContext): Promise<string | null> {
  if (!MOVE_WORDS.test(message) || /\b(lunch|lunches|dinner|dinners)\b/i.test(message)) return null;
  if (/\b(this week|just this|only this|this time|one-?off|next week only|for one week)\b/i.test(message)) return null; // a one-off change, not a permanent move
  const days = [...message.matchAll(DAY_RE)].map((m) => dayName(m[0])).filter(Boolean) as string[];
  if (!days.length) return null;
  const toMatch = message.match(/\b(?:to|now(?:\s+on)?|on)\s+(?:a\s+)?((?:mon|tues|wednes|thurs|fri|satur|sun)days?)\b(?![^.]*\bto\b)/i);
  const fromMatch = message.match(/\bfrom\s+((?:mon|tues|wednes|thurs|fri|satur|sun)days?)\b/i);
  const to = toMatch ? dayName(toMatch[1])! : days[days.length - 1];
  const from = fromMatch ? dayName(fromMatch[1]) : (days.length >= 2 ? days.find((d) => d !== to) ?? null : null);
  const childNames = context.children.map((c) => c.first_name);
  const named = context.children.filter((c) => new RegExp(`\\b${c.first_name}\\b`, "i").test(message));
  const kids = named.length ? named : context.children;
  const activity = activityTokens(message, childNames).filter((t) => !MOVE_FILLER.has(t) && !dayName(t));
  if (!activity.length) return null;
  const kidIds = kids.map((k) => k.id);
  if (!kidIds.length) return null;
  const { data: rems } = await supabase.from("child_reminders").select("id, child_id, title, day_of_week, recurrence_interval")
    .in("child_id", kidIds).eq("active", true);
  const nameOf = (id: string) => context.children.find((c) => c.id === id)?.first_name ?? "";
  let options = (rems ?? []).filter((r: any) => sameActivity(r.title, activity.join(" "), childNames))
    .map((r: any) => ({ id: r.id, child: nameOf(r.child_id), title: r.title, day: r.day_of_week }));
  if (from) { const f = options.filter((o) => o.day === from); if (f.length) options = f; }
  options = options.filter((o) => o.day !== to || options.length === 1);
  await logDedupDecision({ phone, childName: named[0]?.first_name ?? null, tool: "move_reminder", newItem: message.slice(0, 300),
    decision: options.length === 1 ? "move_matched" : options.length ? "move_ambiguous_asked" : "move_no_match_asked",
    match: { table: "child_reminders", id: options.map((o) => o.id).join(",") || "no match", text: options.map((o) => `${o.child} ${o.title} ${o.day}`).join("; ") } });
  if (options.length === 1) {
    const o = options[0];
    if (o.day === to) return `That's already on the list: ${tidyItem(o.title, o.child)} every ${to} 👍`;
    const ok = await updateReminderDay(o.id, to);
    testStore.getStore()?.toolCalls.push({ name: "move_reminder", input: { id: o.id, from: o.day, to }, ok, action: ok ? "updated" : "not_saved", text: "" });
    if (!ok) return `Sorry, I couldn't move ${tidyItem(o.title, o.child)} to ${to} just then — could you send it again? 🙏`;
    return `Got it, ${moveLabel(o, to, childNames)} ✅`;
  }
  if (options.length > 1) {
    const labels = options.map((o) => `${tidyItem(o.title, o.child)} on ${o.day}`);
    const q = `Which one should move to ${to} — ${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}? 😊`;
    await setPendingAction(phone, { kind: "move", items: [], proposed: null, question: q, created_at: nowD().toISOString(), source_text: message, move: { to, options } });
    return q;
  }
  // No matching weekly reminder: offer to add it as a new weekly one.
  if (named.length !== 1) return null; // let the normal flow work out the child
  const child = named[0].first_name;
  const title = activity.join(" ").replace(/^\w/, (c) => c.toUpperCase());
  const q = `I can't find a weekly ${title} reminder for ${child} — shall I add ${tidyItem(title, child)} every ${to}? 😊`;
  await setPendingAction(phone, { kind: "confirm", items: [{ tool: "save_child_reminder", args: { child_name: child, title, emoji: "📌", day_of_week: to, reminder_time: "both", recurrence_interval: 1 } }],
    proposed: [child], question: q, created_at: nowD().toISOString(), source_text: `${message} every ${to}` });
  return q;
}

async function resolveMovePending(phone: string, p: PendingAction, message: string): Promise<string | null> {
  const opts = p.move!.options;
  const dayHits = [...message.matchAll(DAY_RE)].map((m) => dayName(m[0]));
  let pick = opts.filter((o) => dayHits.includes(o.day));
  if (pick.length !== 1) pick = opts.filter((o) => sameActivity(o.title, message, []) && new RegExp(`\\b${o.child}\\b`, "i").test(message));
  await setPendingAction(phone, null);
  if (pick.length !== 1) return null;
  const o = pick[0];
  const ok = await updateReminderDay(o.id, p.move!.to);
  testStore.getStore()?.toolCalls.push({ name: "move_reminder", input: { id: o.id, from: o.day, to: p.move!.to }, ok, action: ok ? "updated" : "not_saved", text: "" });
  return ok ? `Got it, ${moveLabel(o, p.move!.to, [])} ✅` : `Sorry, I couldn't move ${tidyItem(o.title, o.child)} just then — could you send it again? 🙏`;
}

// ── Text message flow (shared by the real webhook and the test entry point) ──
async function handleTextMessage(from: string, incomingMessage: string, context: MontyContext, conversationId: string): Promise<string> {
  // 1) Image notes awaiting "which child?"
  const clarification = await tryResolvePendingClarification(from, incomingMessage, context);
  if (clarification) return clarification;
  // 2) Text items awaiting "which child?" / "do you mean…?"
  const resolved = await tryResolvePendingAction(from, incomingMessage, context);
  if (resolved) return resolved;
  // 3) "X has moved to Wednesday" → move the existing weekly reminder in code
  const moved = await tryMoveReminder(from, incomingMessage, context);
  if (moved) return nameNotPronoun(moved, context.children.map((c) => c.first_name));

  let processedMessage = incomingMessage;
  if (context.children.length > 0) {
    const matchedChildren = detectYearGroupChildren(incomingMessage, context.children);
    if (matchedChildren.length > 0) {
      const childList = matchedChildren.join(" and ");
      processedMessage = `${incomingMessage}\n\n[System note: Based on year groups mentioned, this is relevant to: ${childList}. Please save notes with child_name set accordingly.]`;
    }
  }
  const history = await getRecentHistory(conversationId, 11);
  // The inbound message was already stored — don't also show it as "earlier history".
  const last = history[history.length - 1];
  if (last && last.role === "user" && last.content === incomingMessage) history.pop();
  const reply = await generateReply(processedMessage, history.slice(-10), context, from);
  return nameNotPronoun(reply, context.children.map((c) => c.first_name));
}

// ── Opt-out / opt-in, decided in code BEFORE the AI ─────────────────────────
// Returns the reply (sent even though the number is opted out) or null to carry on normally.
async function handleOptIntent(phone: string, message: string, alertSend?: (t: string) => Promise<{ ok: boolean; channel: string }>, isTest = false): Promise<string | null> {
  const intent = detectOptIntent(message);
  if (intent === "start") { await optIn(phone); return OPT_REPLIES.start; }
  if (intent === "stop") { await optOut(phone, "stop"); return OPT_REPLIES.stop; }
  if (intent === "delete") {
    await optOut(phone, "delete");
    const text = `Monty alert: deletion request. ${phone} asked Monty to delete their account and data ("${message.slice(0, 80)}"). Their messages are already stopped. Use Delete parent on /admin/tests to preview and delete everything.`;
    const { data: row } = await supabase.from("ops_alerts").insert({ alert_type: "deletion_request", affected_parents: 1, failure_count: 0, message: text, likely_fix: "Run Delete parent for this number", is_test: isTest }).select("id").single();
    const res = await (alertSend ?? sendAlertWhatsApp)(text).catch(() => ({ ok: false, channel: "error" }));
    if (row) await supabase.from("ops_alerts").update({ delivered: res.ok, channel: res.channel }).eq("id", row.id);
    return OPT_REPLIES.delete;
  }
  if (await isOptedOut(phone)) return OPT_REPLIES.paused; // opted out: no AI, no saves, just how to resume
  return null;
}

// ── Test entry point ──────────────────────────────────────────────────────────
async function handleTestEntry(req: Request, rawBody: string): Promise<Response> {
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  let b: any = {};
  try { b = JSON.parse(rawBody || "{}"); } catch { /* empty */ }
  const phone = typeof b.phone === "string" ? b.phone : "";
  const scenario = typeof b.scenario === "string" ? b.scenario.slice(0, 200) : null;
  if (!(await validTestSecret(req.headers.get("x-monty-test-secret")))) {
    await auditTestEntry({ entry_point: "whatsapp-webhook", phone_number: phone ? `…${phone.slice(-4)}` : null, scenario, allowed: false, reason: "bad secret" });
    return j({ error: "unauthorised" }, 401);
  }
  if (!(await isTestPhone(phone))) {
    await auditTestEntry({ entry_point: "whatsapp-webhook", phone_number: `…${phone.slice(-4)}`, scenario, allowed: false, reason: "not a test number" });
    return j({ error: "phone is not on the test allowlist" }, 403);
  }
  const dryRun = b.dry_run !== false; // defaults true; this path never calls Twilio either way
  await auditTestEntry({ entry_point: "whatsapp-webhook", phone_number: phone, scenario, allowed: true, reason: dryRun ? "dry_run" : "dry_run(forced)" });
  const now = typeof b.now === "string" && !isNaN(Date.parse(b.now)) ? new Date(b.now) : new Date();
  const store: any = { now, toolCalls: [], failFollowup: b.fail_followup === true, failDb: b.fail_db === true, failClaude: b.fail_claude === true };
  return await testStore.run(store, async () => {
    const message0 = String(b.message || "");
    const alertSends: string[] = [];
    const optReply = await handleOptIntent(phone, message0, async (t) => { alertSends.push(t); return { ok: true, channel: "stub" }; }, true);
    if (optReply) {
      const cid = await getOrCreateConversation(phone);
      await saveMessage(cid, "inbound", message0); await saveMessage(cid, "outbound", optReply);
      return j({ reply: optReply, tool_calls: [], opt: true, alert_sends: alertSends, usage: { input: 0, output: 0, calls: 0 }, now: now.toISOString(), dry_run: true, twilio_called: false });
    }
    const context = await loadParentContext(phone);
    if (!context) return j({ error: "no test family for this phone" }, 400);
    const message = String(b.message || "");
    const conversationId = await getOrCreateConversation(phone); // test number's own conversation only
    await saveMessage(conversationId, "inbound", message);
    const reply = context.onboardingStatus === "new" ? await handleNewParent(phone, context)
      : await handleTextMessage(phone, message, context, conversationId);
    await saveMessage(conversationId, "outbound", reply);
    return j({ reply, tool_calls: store.toolCalls, usage: store.usage ?? { input: 0, output: 0, calls: 0 }, now: now.toISOString(), dry_run: true, twilio_called: false });
  });
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
    .select("direction, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (messages || [])
    .reverse()
    .map((m: any) => ({
      role: m.direction === "inbound" ? "user" : "assistant",
      content: m.content,
      at: m.created_at,
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
    created_at: nowD().toISOString(),
  });
}

// ── WhatsApp sender ───────────────────────────────────────────────────────────

async function sendWhatsApp(to: string, body: string, optReply = false): Promise<boolean> {
  if (await blockIfTestPhone(to, "whatsapp-webhook", { allowOptedOut: optReply })) return true;
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
  if (await blockIfTestPhone(to, "whatsapp-webhook-template")) return true;
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
      return await outageReply(phone, "photo", mediaUrl, "image download failed");
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
    const nowDate = nowD();
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

    const visionModel = montyClaudeModel();
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
      return await outageReply(phone, "photo", mediaUrl, `${response.status} ${rawVisionText.slice(0, 500)}`);
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
      const visionFollowModel = montyClaudeModel();
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
    return await outageReply(phone, "photo", mediaUrl, String(err?.message || err));
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

    // ── Locked test entry point (never Twilio, test numbers only, audited) ──
    if (req.headers.has("x-monty-test-secret")) {
      return await handleTestEntry(req, body);
    }

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

    // Opt-out / opt-in handled in code before anything else (UK GDPR/PECR, WhatsApp policy).
    const optReply = await handleOptIntent(from, incomingMessage);
    if (optReply) {
      const cid = await getOrCreateConversation(from);
      await saveMessage(cid, "inbound", incomingMessage || "[image]");
      await saveMessage(cid, "outbound", optReply);
      await sendWhatsApp(from, optReply, true);
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, { headers: { ...corsHeaders, "Content-Type": "text/xml" } });
    }

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
      reply = await handleTextMessage(from, incomingMessage, context, conversationId);
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