// Pure helpers for school emails with several dated items (no imports besides the shared rules; free-tested).
import { isPrivateEvent, yearGroupMatches } from "./schoolEventRules.ts";

export interface EmailEvent { title: string; date: string; time?: string | null; bring?: string | null; yearGroups: string[]; optIn?: boolean }
export interface Kid { first_name: string; year_group: string | null }

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" && v.trim() && !/^(null|n\/a|none|unknown)$/i.test(v.trim()) ? v.trim() : null);

/** Every dated item from an extraction: `events` if present, else the legacy single eventTitle/eventDate.
 *  Private events dropped, duplicates removed, sorted by date then time. */
export function normaliseEvents(ex: any, fallback?: { title?: string | null; date?: string | null; yearGroups?: string[] | null }): EmailEvent[] {
  const baseYears: string[] = Array.isArray(ex?.yearGroups) && ex.yearGroups.length ? ex.yearGroups.filter((y: unknown) => typeof y === "string") : fallback?.yearGroups?.length ? fallback.yearGroups : ["all"];
  const raw: any[] = Array.isArray(ex?.events) && ex.events.length ? ex.events.filter((e: unknown) => e && typeof e === "object")
    : [{ title: ex?.eventTitle ?? fallback?.title, date: ex?.eventDate ?? fallback?.date }];
  const out: EmailEvent[] = [];
  for (const e of raw) {
   try {
    const title = str(e?.title), date = str(e?.date);
    if (!title || !date || !ISO.test(date) || isPrivateEvent(title)) continue;
    const years = Array.isArray(e?.yearGroups) && e.yearGroups.length ? e.yearGroups.filter((y: unknown) => typeof y === "string" && y.trim()).map(String) : baseYears.map(String);
    if (!years.length) years.push("all");
    const ev: EmailEvent = { title, date, time: str(e?.time), bring: str(e?.bring), yearGroups: years, optIn: e?.optIn === true };
    if (!out.some((o) => o.date === ev.date && o.title.toLowerCase() === ev.title.toLowerCase())) out.push(ev);
   } catch { /* bad event: drop it, keep the rest */ }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.time ?? "").localeCompare(String(b.time ?? "")));
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 27 Nov" */
export function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
/** "own clothes day" — lower-case first letter unless it's an acronym/year label. */
export const tidyTitle = (t: string) => {
  const x = t.trim().replace(/[.!]+$/, "");
  return /^([A-Z]{2}|Y\d|Year\s)/.test(x) ? x : x.charAt(0).toLowerCase() + x.slice(1);
};
const bringShort = (b: string) => b.replace(/^(please\s+)?(bring|bringing)\s+/i, "").replace(/^(a|an|some)\s+/i, "").trim();

/** "Fri 27 Nov: own clothes day, bring a chocolate item" / "Fri 4 Dec, 5–7pm: PTA Christmas Fair" */
export function eventLine(e: EmailEvent): string {
  const bring = e.bring ? `, bring ${/^(a|an|some|your|their)\b/i.test(e.bring) ? e.bring : `a ${e.bring}`}`.replace(/bring bring/i, "bring") : "";
  return `${shortDate(e.date)}${e.time ? `, ${e.time}` : ""}: ${tidyTitle(e.title)}${bring}`;
}

/** "Shall I save all 3?\n• …" */
export function multiSaveQuestion(events: EmailEvent[]): string {
  return `Shall I save all ${events.length}?\n${events.map((e) => `• ${eventLine(e)}`).join("\n")}`;
}
/** "Which one shall I save?\n1. …" (the Choose step). */
export function chooseQuestion(events: EmailEvent[]): string {
  return `Which one shall I save?\n${events.map((e, i) => `${i + 1}. ${eventLine(e)}`).join("\n")}`;
}

/** Children an item is for: whole school → every child; year-specific → the children in those years.
 *  null = genuinely unclear (no child in those years). */
export function eligibleFor(e: EmailEvent, kids: Kid[]): string[] | null {
  if (!kids.length) return null;
  if (!e.yearGroups.length || e.yearGroups.some((y) => /^all$/i.test(y))) return kids.map((k) => k.first_name);
  const m = kids.filter((k) => e.yearGroups.some((y) => yearGroupMatches(y, k.year_group ?? "", e.title))).map((k) => k.first_name);
  return m.length ? m : null;
}

const STOP = new Set(["the", "and", "also", "too", "save", "add", "day", "days", "please", "them", "they", "for", "that", "this", "those",
  "these", "with", "from", "school", "both", "all", "can", "you", "what", "need", "bring", "one", "ones", "just", "fri", "friday", "event", "events", "pta"]);
const toks = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).map((w) => w.replace(/s$/, "")).filter((w) => w.length >= 3 && !STOP.has(w)));
/** Items whose title shares a topic word with the parent's message ("and also the own clothes days", "save the fair too"). */
export function matchEventsByTopic(message: string, events: EmailEvent[]): EmailEvent[] {
  const m = toks(message);
  return events.filter((e) => [...toks(e.title)].some((t) => m.has(t)));
}

export interface SavedItem { child: string; title: string; date: string; bring?: string | null; time?: string | null }
/** "for Jude", "for both Jude and Harry", "for everyone" */
export function forWhom(children: string[], family: string[]): string {
  const c = [...new Set(children)];
  const all = family.length > 1 && family.every((f) => c.includes(f));
  if (all && family.length > 2) return "for everyone";
  const list = c.length <= 1 ? c.join("") : `${c.slice(0, -1).join(", ")} and ${c[c.length - 1]}`;
  return all ? `for both ${list}` : `for ${list}`;
}
/** Grouped confirmation: item once, children named once.
 *  "Saved for both Jude and Harry ✅ Own clothes day: Fri 27 Nov (chocolate item) and Fri 4 Dec (bottle)." */
export function groupedConfirmation(saved: SavedItem[], family: string[]): string {
  const groups = new Map<string, { title: string; kids: Set<string>; dates: Map<string, string> }>();
  for (const s of saved) {
    const key = s.title.toLowerCase();
    if (!groups.has(key)) groups.set(key, { title: s.title, kids: new Set(), dates: new Map() });
    const g = groups.get(key)!;
    g.kids.add(s.child);
    const extra = s.bring ? bringShort(s.bring) : "";
    g.dates.set(`${s.date}|${extra}`, `${shortDate(s.date)}${extra ? ` (${extra})` : ""}`);
  }
  const and = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  const gs = [...groups.values()];
  const sameKids = gs.every((g) => [...g.kids].sort().join() === [...gs[0].kids].sort().join());
  const cap = (t: string) => { const x = tidyTitle(t); return x.charAt(0).toUpperCase() + x.slice(1); };
  const part = (g: typeof gs[0]) => `${cap(g.title)}: ${and([...g.dates.entries()].sort().map(([, v]) => v))}`;
  if (sameKids) return `Saved ${forWhom([...gs[0].kids], family)} ✅ ${gs.map(part).join("; ")}.`;
  return `Saved ✅ ${gs.map((g) => `${part(g)} ${forWhom([...g.kids], family)}`).join("; ")}.`;
}

/** Several save labels ("Jude's own clothes day for Friday 27th", "Harry's …") grouped by item, children named once.
 *  null when a label doesn't follow "<Child>'s <item> for|every|on <when>". */
export function groupLabels(labels: string[], family: string[]): string | null {
  const groups = new Map<string, { item: string; kids: Set<string>; whens: string[] }>();
  for (const l of labels) {
    const m = l.match(/^([A-Z][\w-]*)'s (.+?) ((?:for|every other|every|on) .+)$/);
    if (!m) return null;
    const key = m[2].toLowerCase();
    if (!groups.has(key)) groups.set(key, { item: m[2], kids: new Set(), whens: [] });
    const g = groups.get(key)!;
    g.kids.add(m[1]);
    const w = m[3].replace(/^(for|on) /, "");
    if (!g.whens.includes(w)) g.whens.push(w);
  }
  const gs = [...groups.values()];
  const and = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const same = gs.every((g) => [...g.kids].sort().join() === [...gs[0].kids].sort().join());
  if (same) return `Saved ${forWhom([...gs[0].kids], family)} ✅ ${gs.map((g) => `${cap(g.item)}: ${and(g.whens)}`).join("; ")}.`;
  return `Saved ✅ ${gs.map((g) => `${cap(g.item)}: ${and(g.whens)} ${forWhom([...g.kids], family)}`).join("; ")}.`;
}
