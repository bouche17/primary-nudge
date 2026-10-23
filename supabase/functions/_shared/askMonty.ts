// "Ask Monty" wording: look-up answers, edit/delete questions and confirmations. Pure (no database, no AI),
// shared by whatsapp-webhook and the free tests. Every reply here is built from real results, never from the AI's text.
import { tidyTitle, type DayList } from "./reminderFormat.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const parts = (d: string) => { const x = new Date(d + "T12:00:00Z"); return { wd: WEEKDAYS[x.getUTCDay()], day: x.getUTCDate(), month: MONTHS[x.getUTCMonth()] }; };
export const weekdayOf = (d: string) => parts(d).wd;
/** "Tuesday 3rd" */
export const dayShort = (d: string) => { const p = parts(d); return `${p.wd} ${ordinal(p.day)}`; };
/** "Tuesday 3rd November" */
export const dayLong = (d: string) => { const p = parts(d); return `${p.wd} ${ordinal(p.day)} ${p.month}`; };

/** "today (Friday 23rd October)", "tomorrow (…)", "on Tuesday 3rd November", "between Monday 26th October and Sunday 1st November". */
export function rangePhrase(from: string, to: string, today: string): string {
  if (from === to) {
    if (from === today) return `today (${dayLong(from)})`;
    if (from === addDays(today, 1)) return `tomorrow (${dayLong(from)})`;
    return `on ${dayLong(from)}`;
  }
  return `between ${dayLong(from)} and ${dayLong(to)}`;
}

/** Parent wants to change/cancel something ("cancel", "delete", "stopped", "move", "hide"…). */
export const EDIT_INTENT = /\b(cancel+(ed)?|delete|remove|get rid of|scrap|drop|stop(ped)?|no longer|not doing|isn'?t doing|hide|move|change|rename|switch|off this week|not on this week|isn'?t on)\b/i;
/** A reply claiming a change was made. Only allowed when it's the code-built confirmation of a real change. */
export const EDIT_CLAIM = /\b(i'?ve|i have|done|all done|that'?s)\b[^.!?\n]{0,60}\b(cancel+ed|removed|deleted|stopped|moved|changed|hidden|updated|switched off|paused|turned off|taken off)\b/i;

const STOP = new Set(["the", "a", "an", "on", "at", "for", "of", "to", "in", "and", "is", "are", "next", "this", "week", "s", "any", "anything", "there"]);
const tokens = (s: string, childNames: string[]) => {
  const names = new Set(childNames.map((n) => n.toLowerCase()));
  return (s || "").toLowerCase().replace(/'s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w) && !names.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
};
/** Does an item title answer a look-up for `query` ("forest school", "football")? Every query word must appear
 *  (4-letter prefix match, so "swim" finds "swimming"). */
export function matchesQuery(title: string, query: string, childNames: string[] = []): boolean {
  const q = tokens(query, childNames);
  if (!q.length) return true;
  const t = tokens(title, childNames);
  return q.every((w) => t.some((x) => x === w || (Math.min(x.length, w.length) >= 4 && x.slice(0, 4) === w.slice(0, 4))));
}

export interface LookupView { from: string; to: string; today: string; child?: string | null; item?: string | null; days: DayList[] }

/** Answer to "what's on…?" built only from the lookup result. `edit` = the parent was trying to change something. */
export function lookupReply(v: LookupView, edit = false): string {
  const when = rangePhrase(v.from, v.to, v.today);
  const who = v.child ? ` for ${v.child}` : "";
  const total = v.days.reduce((n, d) => n + d.lines.length, 0);
  if (!total) {
    if (edit) return `I can't find ${v.item ? `"${v.item}"` : "that"}${who} ${when}, so I haven't changed anything.`;
    return v.item ? `There's nothing saved for ${v.item}${who} ${when}.` : `There's nothing saved${who} ${when} 👍`;
  }
  const fmt = (l: DayList["lines"][number]) => `${l.line}${l.optIn ? " (optional)" : ""}`;
  // A look-up for one thing ("when's the next Forest School?") names the thing, not the whole search window.
  const head = edit ? `I found ${total === 1 ? "this" : "these"}${who} ${when} — which one do you mean?`
    : v.item && v.from !== v.to ? `Here's what I've got for ${v.item}${who}:` : `Here's what's on${who} ${when}:`;
  if (v.days.length === 1 && v.from === v.to) return [head, ...v.days[0].lines.map(fmt)].join("\n");
  return [head, ...v.days.flatMap((d) => [`${dayShort(d.date)}:`, ...d.lines.map(fmt)])].join("\n");
}

// ── Edit / delete wording ──
export type EditOp =
  | { op: "skip_date"; reminder_id: string; date: string }
  | { op: "deactivate"; reminder_id: string }
  | { op: "reminder_update"; reminder_id: string; day_of_week?: string; reminder_time?: "morning" | "evening" | "both"; title?: string }
  | { op: "reminder_to_oneoff"; reminder_id: string; date: string }
  | { op: "note_remove_date"; note_id: string; date: string }
  | { op: "note_move_date"; note_id: string; from: string; to: string }
  | { op: "note_retitle"; note_id: string; title: string }
  | { op: "note_to_weekly"; note_id: string; date: string; child_id: string }
  | { op: "lunch_remove_day"; plan_id: string; date: string }
  | { op: "lunch_move_day"; plan_id: string; from: string; to: string }
  | { op: "hide"; child_ids: string[]; keyword: string };
export interface EditPlan { op: EditOp; child: string; title: string; needsConfirm: boolean }

const TIME_WORD = { morning: "morning only", evening: "evening only", both: "the evening before and the morning of" };
const possessive = (child: string, title: string) => `${child}'s ${tidyTitle(title, child)}`;

/** One short Yes / No question before a delete or an all-future change. */
export function confirmQuestion(p: EditPlan): string {
  const it = possessive(p.child, p.title), o = p.op;
  switch (o.op) {
    case "skip_date": return `Cancel ${it} just this ${dayShort(o.date)}? Yes / No`;
    case "deactivate": return `Stop ${it} for good (no more reminders for it)? Yes / No`;
    case "reminder_update":
      if (o.day_of_week) return `Move ${it} to ${o.day_of_week}s from now on? Yes / No`;
      if (o.reminder_time) return `Change ${it} to ${TIME_WORD[o.reminder_time]} from now on? Yes / No`;
      return `Rename ${it} to "${o.title}" from now on? Yes / No`;
    case "reminder_to_oneoff": return `Make ${it} just ${dayShort(o.date)}, not every week? Yes / No`;
    case "note_remove_date": return `Remove ${it} on ${dayShort(o.date)}? Yes / No`;
    case "note_to_weekly": return `Make ${it} every ${weekdayOf(o.date)} from now on? Yes / No`;
    case "lunch_remove_day": return `Remove ${p.child}'s packed lunch on ${dayShort(o.date)}? Yes / No`;
    case "hide": return `That's from the school, so I can't change or delete it — but I can hide "${p.title}" for ${p.child}. Shall I? Yes / No`;
    default: return `Change ${it}? Yes / No`;
  }
}

/** Code-built confirmation after the change really happened. */
export function doneLine(p: EditPlan): string {
  const it = possessive(p.child, p.title), o = p.op;
  switch (o.op) {
    case "skip_date": return `Done, ${it} is off for ${dayShort(o.date)} ✅`;
    case "deactivate": return `Done, ${it} is stopped — no more reminders for it ✅`;
    case "reminder_update":
      if (o.day_of_week) return `Done, ${it} is now on ${o.day_of_week}s ✅`;
      if (o.reminder_time) return `Done, ${it} is now ${TIME_WORD[o.reminder_time]} ✅`;
      return `Done, ${p.child}'s reminder is now "${o.title}" ✅`;
    case "reminder_to_oneoff": return `Done, ${it} is now just ${dayShort(o.date)} ✅`;
    case "note_remove_date": return `Done, ${it} on ${dayShort(o.date)} is removed ✅`;
    case "note_move_date": return `Done, ${it} has moved to ${dayShort(o.to)} ✅`;
    case "note_retitle": return `Done, ${p.child}'s note is now "${o.title}" ✅`;
    case "note_to_weekly": return `Done, ${it} is now every ${weekdayOf(o.date)} ✅`;
    case "lunch_remove_day": return `Done, ${p.child}'s packed lunch on ${dayShort(o.date)} is removed ✅`;
    case "lunch_move_day": return `Done, ${p.child}'s packed lunch has moved to ${dayShort(o.to)} ✅`;
    case "hide": return `Done, I've hidden "${p.title}" for ${p.child} ✅`;
  }
}

export function failLine(p: EditPlan): string {
  return `Sorry, I couldn't change ${possessive(p.child, p.title)} just then, so it's still as it was. Could you try again in a moment? 🙏`;
}
export const keptLine = (p: EditPlan) => `OK, I've left ${p.op.op === "hide" ? `"${p.title}"` : possessive(p.child, p.title)} as it is 👍`;
export const NOT_FOUND_REPLY = "I can't find that, so I haven't changed anything. Could you tell me which item you mean?";
