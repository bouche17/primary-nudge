// Pure chat rules shared by whatsapp-webhook and its free tests (no imports, no database).

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** After 15:30 UK, "this <today's weekday>" means next week's one (the school day is over). */
export const THIS_DAY_CUTOFF_MINUTES = 15 * 60 + 30;

export function ukNowParts(now: Date): { today: string; minutes: number } {
  const today = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const [h, m] = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).split(":").map(Number);
  return { today, minutes: (h % 24) * 60 + m };
}
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const mondayIndex = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;

/** The one date rule for save, update and delete.
 *  "<day>" / "this <day>": the next one from today; today itself only before 15:30 UK.
 *  "next <day>": that day in the coming calendar week (Mon–Sun). */
export function resolveWeekday(mod: "this" | "next" | "", day: string, todayIso: string, minutes: number): string {
  const target = WEEKDAY_NAMES.findIndex((d) => d.toLowerCase() === day.toLowerCase());
  if (target < 0) return todayIso;
  const dow = mondayIndex(todayIso);
  if (mod === "next") return addDaysIso(todayIso, 7 - dow + target);
  let diff = (target - dow + 7) % 7;
  if (diff === 0 && minutes >= THIS_DAY_CUTOFF_MINUTES) diff = 7;
  return addDaysIso(todayIso, diff);
}

const DAY_PHRASE = /\b(?:(this|next)\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?!s)/gi;
const EXPLICIT_DATE = /\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(tomorrow|today|tonight)\b/i;

/** The single date a message's day words point to ("Delete Jude's PE kit this Thursday"), or null when there's an
 *  explicit date, an "every <day>", or more than one date. */
export function resolveDayInText(text: string, todayIso: string, minutes: number): string | null {
  const t = String(text || "");
  if (EXPLICIT_DATE.test(t)) return null;
  const dates = new Set<string>();
  for (const m of t.matchAll(DAY_PHRASE)) {
    const before = t.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (/\b(every|each)\s+(other\s+)?$/i.test(before)) return null;
    dates.add(resolveWeekday((m[1]?.toLowerCase() as "this" | "next") || "", m[2], todayIso, minutes));
  }
  return dates.size === 1 ? [...dates][0] : null;
}

/** "Thu 5 Nov" (button labels). */
export function shortDayDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${d.getUTCDate()} ${d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
}

/** Words that never make two items "the same thing" on their own (a shared "kit" isn't PE kit = football kit). */
export const COMMON_ITEM_WORDS = new Set(["kit", "bag", "money", "day", "form", "letter", "reminder", "school", "bring", "need", "needed", "wear", "clothes"]);
export function hasMeaningfulShared(shared: string[]): boolean {
  return shared.some((w) => !COMMON_ITEM_WORDS.has(w) && !COMMON_ITEM_WORDS.has(w.replace(/s$/, "")));
}

/** Lower-cases the first letter only for an ordinary capitalised word ("Football kit" → "football kit");
 *  acronyms and codes keep the parent's casing ("PE kit", "Y3 trip", "ASC"). */
export function lowerFirstSafe(text: string): string {
  const t = String(text || "");
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}
