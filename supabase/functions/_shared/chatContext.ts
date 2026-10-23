// What Monty knows about a family before replying (whatsapp-webhook) — and the chat shadow comparison.
// Legacy loader = the old rules (sender's own notes, UTC dates, every school event at the school, no fortnight/holiday
// rules). With chat_source = 'new' the context also carries the shared getWhatsOn list (whole family, UK dates,
// partner notes, due-dated school reminders, opt-in events flagged), which replaces the old upcoming sections.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeWhatsOn, loadFamilyData, ukDate, type WhatsOnItem } from "./whatsOn.ts";
import { whatsOnDays, type DayList } from "./reminderFormat.ts";

export interface Child { id: string; first_name: string; year_group: string; school_name: string; school_id: string }

export interface MontyContext {
  parentId: string;
  children: Child[];
  childReminders: Array<{ child_name: string; title: string; emoji: string; day_of_week: string }>;
  upcomingEvents: Array<{ title: string; start_at: string; school_name: string }>;
  upcomingNotes: Array<{ summary: string; child_name: string | null; extracted_dates: string[] }>;
  lunchPlans: Array<{ child_name: string; week_start: string; packed_lunch_days: string[] }>;
  lunchWeeks: string[];
  schoolReminders: Array<{ title: string; emoji: string; day_of_week: string }>;
  isOnboarding: boolean;
  onboardingStatus: string;
  chatSource?: "legacy" | "new";
  whatsOn?: { from: string; to: string; items: WhatsOnItem[]; days: DayList[] }; // chat_source = 'new' only
}

const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);

/** The old context loader, unchanged in behaviour. */
export async function loadLegacyChatContext(db: SupabaseClient, phone: string, now: Date): Promise<MontyContext | null> {
  const { data: profile } = await db.from("profiles").select("user_id").eq("phone_number", phone).maybeSingle();
  if (!profile) return null;
  const parentId = profile.user_id;

  const { data: linkedRows } = await db.from("linked_accounts").select("primary_user_id, linked_user_id")
    .eq("status", "accepted").or(`primary_user_id.eq.${parentId},linked_user_id.eq.${parentId}`);
  const familyUserIds = new Set<string>([parentId]);
  for (const row of linkedRows || []) { familyUserIds.add(row.primary_user_id); familyUserIds.add(row.linked_user_id); }

  const { data: children } = await db.from("children").select("id, first_name, year_group, school_id, schools(name)").in("parent_id", Array.from(familyUserIds));
  const enrichedChildren: Child[] = (children || []).map((c: any) => ({ id: c.id, first_name: c.first_name, year_group: c.year_group, school_id: c.school_id, school_name: c.schools?.name || "school" }));
  const schoolIds = enrichedChildren.map((c) => c.school_id);
  const childIds = enrichedChildren.map((c) => c.id);

  const { data: childRemindersRaw } = childIds.length > 0
    ? await db.from("child_reminders").select("child_id, title, emoji, day_of_week, children(first_name)").in("child_id", childIds).eq("active", true)
    : { data: [] };
  const childReminders = (childRemindersRaw || []).map((r: any) => ({ child_name: r.children?.first_name || "Unknown", title: r.title, emoji: r.emoji, day_of_week: r.day_of_week }));

  const twoWeeksAhead = new Date(now);
  twoWeeksAhead.setDate(twoWeeksAhead.getDate() + 14);
  const { data: events } = schoolIds.length > 0
    ? await db.from("school_events").select("title, start_at, school_id, schools(name)").in("school_id", schoolIds)
      .gte("start_at", now.toISOString()).lte("start_at", twoWeeksAhead.toISOString()).order("start_at", { ascending: true }).limit(20)
    : { data: [] };
  const upcomingEvents = (events || []).map((e: any) => ({ title: e.title, start_at: e.start_at, school_name: e.schools?.name || "" }));

  const { data: notesRaw } = await db.from("parent_notes").select("summary, child_name, extracted_dates, created_at")
    .eq("phone_number", phone).order("created_at", { ascending: false }).limit(20);
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
      summary: n.summary, child_name: n.child_name || null,
      extracted_dates: (Array.isArray(n.extracted_dates) ? n.extracted_dates : []).map((d: any) => (typeof d === "string" ? d : d?.date)).filter((d: any) => typeof d === "string"),
    }));

  const { data: schoolReminders } = schoolIds.length > 0
    ? await db.from("school_reminders").select("title, emoji, day_of_week").eq("active", true)
      .or(`school_id.in.(${schoolIds.join(",")}),school_id.is.null`).not("day_of_week", "is", null)
    : { data: [] };

  const { data: onboardingState } = await db.from("onboarding_state").select("status").eq("phone_number", phone).maybeSingle();
  const onboardingStatus = onboardingState?.status || "complete";
  const isOnboarding = onboardingStatus === "new" || onboardingStatus === "collecting";

  const ukTodayIso = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const ukNoon = new Date(ukTodayIso + "T12:00:00Z");
  const dow = ukNoon.getUTCDay();
  const thisMon = new Date(ukNoon);
  thisMon.setUTCDate(ukNoon.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  const nextMon = new Date(thisMon);
  nextMon.setUTCDate(thisMon.getUTCDate() + 7);
  const lunchWeeks = [thisMon.toISOString().split("T")[0], nextMon.toISOString().split("T")[0]];
  const { data: lunchRaw } = childIds.length > 0
    ? await db.from("weekly_lunch_plans").select("child_id, week_start, packed_lunch_days").in("child_id", childIds).in("week_start", lunchWeeks)
    : { data: [] };
  const lunchPlans = (lunchRaw || []).map((p: any) => ({
    child_name: enrichedChildren.find((c) => c.id === p.child_id)?.first_name || "", week_start: p.week_start, packed_lunch_days: (p.packed_lunch_days || []) as string[],
  }));

  return { parentId, children: enrichedChildren, childReminders, upcomingEvents, upcomingNotes, lunchPlans, lunchWeeks, schoolReminders: (schoolReminders || []) as any, isOnboarding, onboardingStatus };
}

/** The shared list for the family of `userId`: today (UK) + 13 days. */
export async function loadChatWhatsOn(db: SupabaseClient, userId: string, now: Date) {
  const from = ukDate(now), to = addDays(from, 13);
  const data = await loadFamilyData(db, userId, from, to);
  const items = computeWhatsOn(data, from, to);
  return { from, to, items, days: whatsOnDays(items, data.children.map((c) => c.first_name)) };
}

/** Chat-prompt section for the shared list: one heading per date, reminder wording, opt-in and school items tagged. */
export function whatsOnPromptSection(w: NonNullable<MontyContext["whatsOn"]>): string {
  if (!w.days.length) return "Nothing at all in the next 14 days.";
  return w.days.map((d) => {
    const head = new Date(d.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    const lines = d.lines.map((l) => `• ${l.line}${l.optIn ? " [optional club/activity from the school calendar — NOT in reminders unless the parent saves it]" : l.tag === "school" ? " [from school]" : ""}`);
    return `${head} (${d.date}):\n${lines.join("\n")}`;
  }).join("\n");
}

// ── Chat shadow: the old context's upcoming items expanded to dates (what Monty "saw" for each day) ──
export type DatedItem = { date: string; child: string | null; title: string; kind: string };
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function legacyUpcoming(ctx: MontyContext, from: string, days: number): DatedItem[] {
  const out: DatedItem[] = [];
  const single = ctx.children.length === 1 ? ctx.children[0].first_name : null;
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i), wd = WEEKDAYS[new Date(date + "T12:00:00Z").getUTCDay()];
    for (const r of ctx.childReminders) if (r.day_of_week === wd) out.push({ date, child: r.child_name, title: r.title, kind: "weekly" });
    for (const r of ctx.schoolReminders) if (r.day_of_week === wd) out.push({ date, child: single, title: r.title, kind: "school reminder" });
    for (const p of ctx.lunchPlans) {
      const mon = addDays(date, -((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7));
      if (p.week_start === mon && p.packed_lunch_days.includes(wd)) out.push({ date, child: p.child_name, title: "Packed lunch", kind: "lunch" });
    }
    for (const e of ctx.upcomingEvents) if (e.start_at.slice(0, 10) === date) out.push({ date, child: null, title: e.title, kind: "school event" }); // old: UTC date, no year filter
    for (const n of ctx.upcomingNotes) if (n.extracted_dates.includes(date)) out.push({ date, child: n.child_name ?? single, title: n.summary, kind: "one-off" });
  }
  return out;
}
