// One source of truth for "what's on" for a family. No AI, no writes.
// computeWhatsOn() is pure (testable without the database); loadFamilyData() does the reading.
// Morning/evening reminders read this when app_settings.whats_on_source = 'new' (send-reminders);
// they skip items flagged optIn. Year-group/opt-in rules live in schoolEventRules.ts (also used by the dashboard and chat).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isOptInEvent, markerContained, norm, sharesTopic, topicWords, yearGroupMatches } from "./schoolEventRules.ts";
export { ACTIVITY_WORDS, ALWAYS_INCLUDE_WORDS, eventYearGroups, isOptInEvent, markerContained, normaliseYearGroups, OPT_IN_WORDS, sharesTopic, yearGroupMatches } from "./schoolEventRules.ts";

export type WhatsOnKind = "weekly" | "fortnightly" | "one-off" | "school event" | "school reminder" | "lunch";
export interface WhatsOnItem {
  date: string;                 // YYYY-MM-DD, UK (Europe/London)
  childId: string | null;       // null = whole family
  childName: string | null;
  title: string;
  emoji: string;
  kind: WhatsOnKind;
  slot: "morning" | "evening" | "both";
  source: { table: string; id: string };
  optIn?: boolean;              // school event for an opt-in activity (club, tournament…) the parent hasn't saved: shown in lists, never in reminders
  details?: string[];           // school event only: extra detail from the parent's own item it replaced ("bring £2", "at 6pm")
  absorbed?: { table: string; id: string; title: string }[]; // parent's own items shown as this school event's line instead
}

// ── Parent's own item + school event on the same topic → one line (the school's), with the parent's extra detail ──
const MONEY_RE = /(?:\b(bring|send in|send|pay)\s+)?£\s?\d+(?:\.\d{2})?/gi;
const TIME_RE = /(?:\b(at|from|by|until|till|leaving|leaves|starts?|finish(?:es)?|ends?)\s+)?\b\d{1,2}(?:[:.]\d{2})?\s?(?:am|pm)\b|\b(at|from|by|until|till|leaving|leaves)\s+\d{1,2}[:.]\d{2}\b/gi;
const BRING_RE = /\b(?:bring|wear|pack|take)\s+(?:in\s+)?(?:a |an |their |his |her |some )?[a-z][\w' -]{1,30}?(?=$|[,.;:()—–]|\s(?:and then|for|to|by|on|at|so)\s)/gi;
const KIT_RE = /\b(?:(?:pe|swimming|swim|football|forest school|sports?)\s+)?(?:kit|bag|costume|towel|goggles|wellies|waterproofs|packed lunch|snack|water bottle|drink)\b/gi;

/** Short pieces of the parent's text the school event's title doesn't already say: money, "bring …"/kit, times. */
export function extraDetails(parentText: string, eventTitle: string): string[] {
  const ev = ` ${norm(eventTitle)} `;
  const topics = [...topicWords(eventTitle)];
  const out: string[] = [];
  const add = (d: string) => {
    const x = d.replace(/\s+/g, " ").trim();
    if (!x || ev.includes(` ${norm(x)} `) || out.some((o) => norm(o) === norm(x) || norm(o).includes(norm(x)))) return;
    out.push(x);
  };
  for (const m of parentText.matchAll(MONEY_RE)) add(m[1] ? m[0] : m[0].replace(/^.*?(£)/, "$1"));
  const bring = [...parentText.matchAll(BRING_RE)].map((m) => m[0].replace(/\s+(?:needed|required)$/i, ""));
  const kit = [...parentText.matchAll(KIT_RE)].map((m) => topics.reduce((s, w) => s.replace(new RegExp(`^${w}\\s+`, "i"), ""), m[0].toLowerCase()));
  if (bring.length) bring.forEach(add);
  else if (kit.length) add("bring " + [...new Set(kit)].join(", ").replace(/, ([^,]+)$/, " & $1"));
  for (const m of parentText.matchAll(TIME_RE)) add(m[0]);
  return out;
}

export interface FamilyData {
  familyId: string;
  children: { id: string; first_name: string; school_id: string | null; year_group: string | null }[];
  childReminders: { id: string; child_id: string; title: string; emoji: string | null; day_of_week: string; reminder_time: string | null; active: boolean | null; recurrence_interval: number | null; anchor_date: string | null }[];
  lunchPlans: { id: string; child_id: string; week_start: string; packed_lunch_days: string[] }[];
  schoolReminders: { id: string; school_id: string | null; title: string; emoji: string | null; day_of_week: string | null; due_date: string | null; active: boolean | null }[];
  schoolEvents: { id: string; school_id: string | null; title: string; start_at: string; year_group: string | null }[];
  holidays: { school_id: string | null; start_date: string; end_date: string }[];
  notes: { id: string; summary: string | null; child_name: string | null; extracted_dates: unknown }[];
  exclusions: { child_id: string; keyword: string }[];
  skips?: { reminder_id: string; skip_date: string }[]; // one date of a weekly reminder cancelled ("just this week")
  allOptedOut?: boolean;        // every family number has sent STOP
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const noon = (d: string) => new Date(d + "T12:00:00Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const ukDate = (ts: string | Date) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const weekdayOf = (d: string) => WEEKDAYS[new Date(d + "T12:00:00Z").getUTCDay()];
const mondayOf = (d: string) => { const day = new Date(d + "T12:00:00Z").getUTCDay(); return iso(noon(d) - ((day + 6) % 7) * DAY_MS); };

/** Year prefix on event titles ("Y3/4 ", "Year 5: ", "KS2 ") — removed for matching and for the reminder line. */
export function stripYearPrefix(title: string): string {
  const re = /^\s*(?:(?:y(?:ea)?r?s?)\s*[\dR]+(?:\s*[,/&\-]\s*(?:y(?:ea)?r?s?\s*)?[\dR]+)*|ks\s*[1-4]|eyfs|reception|nursery)\b[\s:.\-–—]*/i;
  let t = title;
  for (let i = 0; i < 2; i++) { const n = t.replace(re, ""); if (n === t) break; t = n; }
  return t.trim() || title.trim();
}
const matchKey = (s: string) => norm(s).replace(/\b(at|the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();

export function isHoliday(h: FamilyData["holidays"], schoolId: string | null, date: string) {
  return h.some((x) => (x.school_id === null || x.school_id === schoolId) && x.start_date <= date && x.end_date >= date);
}

const KIND_ORDER: WhatsOnKind[] = ["school event", "one-off", "weekly", "fortnightly", "lunch", "school reminder"];
const SLOT_ORDER = { morning: 0, both: 1, evening: 2 };

export function computeWhatsOn(f: FamilyData, fromDate: string, toDate: string): WhatsOnItem[] {
  if (f.allOptedOut) return [];
  const items: WhatsOnItem[] = [];
  const kids = [...f.children].sort((a, b) => a.first_name.localeCompare(b.first_name));
  const byId = new Map(kids.map((k) => [k.id, k]));
  const schoolIds = [...new Set(kids.map((k) => k.school_id))];
  const excluded = (childId: string, title: string) => f.exclusions.some((e) => e.child_id === childId && norm(title).includes(norm(e.keyword)));

  for (let t = noon(fromDate); t <= noon(toDate); t += DAY_MS) {
    const date = iso(t), weekday = weekdayOf(date);

    for (const r of f.childReminders) {
      const kid = byId.get(r.child_id);
      if (!kid || r.active === false || r.day_of_week !== weekday) continue;
      const interval = r.recurrence_interval ?? 1;
      if (interval > 1 && r.anchor_date) {
        const weeks = Math.round((noon(date) - noon(r.anchor_date)) / (7 * DAY_MS));
        if (((weeks % interval) + interval) % interval !== 0) continue;
      }
      if (isHoliday(f.holidays, kid.school_id, date)) continue; // skipped, never moved
      if (f.skips?.some((x) => x.reminder_id === r.id && x.skip_date === date)) continue; // parent cancelled just this date
      const slot = r.reminder_time === "morning" || r.reminder_time === "evening" ? r.reminder_time : "both";
      items.push({ date, childId: kid.id, childName: kid.first_name, title: r.title, emoji: r.emoji || "✅", kind: interval > 1 ? "fortnightly" : "weekly", slot, source: { table: "child_reminders", id: r.id } });
    }

    const monday = mondayOf(date);
    for (const p of f.lunchPlans) {
      const kid = byId.get(p.child_id);
      if (!kid || p.week_start !== monday || !p.packed_lunch_days?.includes(weekday)) continue;
      if (isHoliday(f.holidays, kid.school_id, date)) continue;
      items.push({ date, childId: kid.id, childName: kid.first_name, title: "Packed lunch", emoji: "🥪", kind: "lunch", slot: "both", source: { table: "weekly_lunch_plans", id: p.id } });
    }

    // School reminders: one per family (no year/class targeting exists on these rows). Skipped only if
    // every school the family uses is on holiday that day.
    for (const r of f.schoolReminders) {
      if (r.active === false) continue;
      if (r.school_id !== null && !schoolIds.includes(r.school_id)) continue;
      if (!(r.due_date === date || (!r.due_date && r.day_of_week === weekday))) continue;
      const relevant = r.school_id === null ? schoolIds : [r.school_id];
      if (relevant.length && relevant.every((s) => isHoliday(f.holidays, s, date))) continue;
      items.push({ date, childId: null, childName: null, title: r.title, emoji: r.emoji || "✅", kind: "school reminder", slot: "both", source: { table: "school_reminders", id: r.id } });
    }

    for (const n of f.notes) {
      if (!n.summary) continue;
      const dates = Array.isArray(n.extracted_dates) ? (n.extracted_dates as { date?: string }[]) : [];
      if (!dates.some((d) => d?.date === date)) continue;
      const kid = n.child_name ? kids.find((k) => k.first_name.toLowerCase() === n.child_name!.trim().toLowerCase()) : undefined;
      items.push({ date, childId: kid?.id ?? null, childName: kid?.first_name ?? null, title: n.summary, emoji: "📝", kind: "one-off", slot: "both", source: { table: "parent_notes", id: n.id } });
    }

    // Parent's own items for each child today (notes + child reminders), for "show it once" with school events.
    const parentKeys = (childId: string) => new Set(items.filter((i) => i.date === date && i.childId === childId &&
      (i.source.table === "parent_notes" || i.source.table === "child_reminders")).map((i) => matchKey(i.title)));
    for (const e of f.schoolEvents) {
      if (ukDate(e.start_at) !== date) continue;
      for (const kid of kids) {
        if (e.school_id !== null && e.school_id !== kid.school_id) continue;
        if (!yearGroupMatches(e.year_group, kid.year_group, e.title)) continue;
        if (excluded(kid.id, e.title)) continue;
        // Parent saved it themselves (same title, or saved under the event's title): their item is the one shown.
        const mine = parentKeys(kid.id);
        if (mine.has(matchKey(e.title)) || mine.has(matchKey(stripYearPrefix(e.title)))) continue;
        const optIn = isOptInEvent(e.title, e.year_group, e.start_at);
        items.push({ date, childId: kid.id, childName: kid.first_name, title: e.title, emoji: "🏫", kind: "school event", slot: "both", source: { table: "school_events", id: e.id }, ...(optIn ? { optIn: true } : {}) });
      }
    }
  }

  // Identical items for the same child on the same day appear once (first by kind order wins; reminder-visible beats opt-in).
  const sorted = items.sort((a, b) =>
    a.date.localeCompare(b.date) || SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] ||
    (a.childName ?? "\uffff").localeCompare(b.childName ?? "\uffff") ||
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title) || a.source.id.localeCompare(b.source.id));
  const seen = new Set<string>();
  const unique = sorted.filter((i) => { const k = `${i.date}|${i.childId ?? "family"}|${norm(i.title)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // Same-day school events where one title's meaningful words are all in the other's ("School closes" vs
  // "October Half Term begins (school closes)"): keep the longer one. An opt-in item never hides a reminder-visible one.
  const events = unique.filter((i) => i.kind === "school event");
  const hidden = new Set<WhatsOnItem>();
  for (const a of events) {
    for (const b of events) {
      if (a === b || hidden.has(b) || a.date !== b.date || a.childId !== b.childId) continue;
      if (b.optIn && !a.optIn) continue;
      if (!markerContained(a.title, b.title)) continue;
      const bWins = b.title.length > a.title.length || (b.title.length === a.title.length && unique.indexOf(b) < unique.indexOf(a));
      if (bWins) { hidden.add(a); break; }
    }
  }
  const kept = unique.filter((i) => !hidden.has(i));
  // A parent's own note/child reminder sharing a topic word with a reminder-visible school event for the same child
  // that day ("Halloween disco" + "PTA KS2 Disco") → only the school line, carrying the parent's extra detail.
  const gone = new Set<WhatsOnItem>();
  for (const e of kept) {
    if (e.kind !== "school event" || e.optIn) continue;
    for (const p of kept) {
      if (gone.has(p) || p.date !== e.date || (p.source.table !== "parent_notes" && p.source.table !== "child_reminders")) continue;
      if (!(p.childId === e.childId || (p.childId === null && kids.length === 1))) continue;
      if (!sharesTopic(p.title, e.title)) continue;
      gone.add(p);
      (e.absorbed ??= []).push({ table: p.source.table, id: p.source.id, title: p.title });
      for (const d of extraDetails(p.title, e.title)) if (!(e.details ??= []).some((x) => norm(x) === norm(d))) e.details.push(d);
    }
    if (e.details && !e.details.length) delete e.details;
  }
  return kept.filter((i) => !gone.has(i));
}

/** Reads everything for the family of `userId` (the user plus every linked partner). */
export async function loadFamilyData(db: SupabaseClient, userId: string, fromDate: string, toDate: string): Promise<FamilyData> {
  const { data: famIds } = await db.rpc("get_family_user_ids", { _user_id: userId });
  const ids: string[] = ((famIds ?? []) as unknown[]).map((r: any) => (typeof r === "string" ? r : r.get_family_user_ids ?? r)).filter(Boolean);
  if (!ids.includes(userId)) ids.push(userId);
  return loadFamilyDataForUsers(db, ids, fromDate, toDate);
}

/** Same as loadFamilyData, for a family whose user ids are already known (send-reminders groups families itself). */
export async function loadFamilyDataForUsers(db: SupabaseClient, ids: string[], fromDate: string, toDate: string): Promise<FamilyData> {
  const familyId = [...ids].sort()[0];
  const [{ data: children }, { data: profs }] = await Promise.all([
    db.from("children").select("id, first_name, school_id, year_group").in("parent_id", ids),
    db.from("profiles").select("phone_number").in("user_id", ids),
  ]);
  const kids = children ?? [];
  const kidIds = kids.map((k) => k.id);
  const schoolIds = [...new Set(kids.map((k) => k.school_id).filter(Boolean))] as string[];
  const phones = (profs ?? []).map((p) => p.phone_number).filter(Boolean) as string[];
  const none = ["00000000-0000-0000-0000-000000000000"];
  const schoolOr = schoolIds.length ? `school_id.in.(${schoolIds.join(",")}),school_id.is.null` : "school_id.is.null";
  const fromTs = new Date(noon(fromDate) - 2 * DAY_MS).toISOString(), toTs = new Date(noon(toDate) + 2 * DAY_MS).toISOString();
  const [cr, lp, sr, se, hol, notes, exc, opted, skips] = await Promise.all([
    db.from("child_reminders").select("id, child_id, title, emoji, day_of_week, reminder_time, active, recurrence_interval, anchor_date").in("child_id", kidIds.length ? kidIds : none).eq("active", true),
    db.from("weekly_lunch_plans").select("id, child_id, week_start, packed_lunch_days").in("child_id", kidIds.length ? kidIds : none).gte("week_start", mondayOf(fromDate)).lte("week_start", toDate),
    db.from("school_reminders").select("id, school_id, title, emoji, day_of_week, due_date, active").eq("active", true).or(schoolOr),
    schoolIds.length ? db.from("school_events").select("id, school_id, title, start_at, year_group").in("school_id", schoolIds).gte("start_at", fromTs).lte("start_at", toTs) : Promise.resolve({ data: [] }),
    db.from("school_holidays").select("school_id, start_date, end_date").or(schoolOr).lte("start_date", toDate).gte("end_date", fromDate),
    phones.length ? db.from("parent_notes").select("id, summary, child_name, extracted_dates").in("phone_number", phones) : Promise.resolve({ data: [] }),
    db.from("event_exclusions").select("child_id, keyword").in("child_id", kidIds.length ? kidIds : none),
    phones.length ? db.from("opted_out_numbers").select("phone_number").in("phone_number", phones) : Promise.resolve({ data: [] }),
    kidIds.length ? db.from("child_reminder_skips").select("reminder_id, skip_date, child_reminders!inner(child_id)").in("child_reminders.child_id", kidIds).gte("skip_date", fromDate).lte("skip_date", toDate) : Promise.resolve({ data: [] }),
  ]);
  for (const r of [cr, lp, sr, se, hol, notes, exc, skips] as { error?: { message: string } | null }[]) {
    if (r.error) throw new Error(`what's on: read failed: ${r.error.message}`); // never build a partial list silently
  }
  return {
    familyId, children: kids, childReminders: (cr.data ?? []) as any, lunchPlans: (lp.data ?? []) as any, schoolReminders: (sr.data ?? []) as any,
    schoolEvents: (se.data ?? []) as any, holidays: (hol.data ?? []) as any, notes: (notes.data ?? []) as any, exclusions: (exc.data ?? []) as any,
    skips: ((skips.data ?? []) as any[]).map((x) => ({ reminder_id: x.reminder_id, skip_date: x.skip_date })),
    allOptedOut: phones.length > 0 && (opted.data ?? []).length === phones.length,
  };
}

export async function getWhatsOn(db: SupabaseClient, userId: string, fromDate: string, toDate: string) {
  const data = await loadFamilyData(db, userId, fromDate, toDate);
  return { familyId: data.familyId, items: computeWhatsOn(data, fromDate, toDate) };
}
