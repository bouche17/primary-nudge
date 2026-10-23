// Morning/evening reminder layout. Pure (no database), shared by send-reminders and the free tests.
// Free-form (parent's 24h window open): one "emoji Child: item" per line, grouped by child.
// Template (window closed): WhatsApp template variables can't hold newlines, so one line per family.
// A school event that reaches several children of the family is one line: "Everyone: …" when it reaches every child,
// else "Freddie & Tommy: …". "Everyone" lines come first, then shared lines, then each child's own lines.
import { stripYearPrefix, type WhatsOnItem } from "./whatsOn.ts";

export interface FmtItem {
  childName: string; title: string; emoji: string; type: "reminder" | "event" | "note" | "announcement";
  date?: string;     // YYYY-MM-DD the item is for: relative words ("tomorrow") are turned into the real day from it
  shareKey?: string; // same key + same text for several children → one line for them
  meta?: ItemMeta;   // carried through to the line (dashboard/chat lists); never changes the wording
}
export interface ItemMeta { optIn?: boolean; kind?: string; sources: { table: string; id: string }[] }

const GENERIC = new Set(["", "✅", "📝"]);
const KEYWORD_EMOJI: [RegExp, string][] = [
  [/homework/i, "📚"], [/lunch/i, "🥪"], [/swim/i, "🏊"], [/\b(money|change|cash|coins?|pay(ment)?)\b|£/i, "🪙"], [/\bpe\b|\bkit\b/i, "👟"],
  [/reading|library|\bbook/i, "📖"], [/\btrip\b/i, "🚌"], [/non.?uniform|dress.?up|costume/i, "👕"],
  [/photo/i, "📸"], [/forest/i, "🌳"], [/football|netball|rugby|sport/i, "⚽"], [/disco|party/i, "🎉"],
];
const DEFAULT_EMOJI: Record<FmtItem["type"], string> = { note: "📝", event: "🏫", reminder: "✅", announcement: "✅" };

export function itemEmoji(i: Pick<FmtItem, "title" | "emoji" | "type">): string {
  if (/swim/i.test(i.title)) return "🏊"; // always, whatever emoji the item was saved with
  const e = (i.emoji || "").trim();
  if (!GENERIC.has(e)) return e;
  if (/packed lunch/i.test(i.title)) return "🥪";
  for (const [re, em] of KEYWORD_EMOJI) if (re.test(i.title)) return em;
  return e || DEFAULT_EMOJI[i.type] || "✅";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** First words that are always proper nouns, so never lower-cased. */
const PROPER_FIRST = new Set(["halloween", "christmas", "easter", "diwali", "eid", "hanukkah", "remembrance", "poppy", "children", "comic", "red", "world",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december", "mr", "mrs", "miss", "ms", "dr"]);

// ── Relative day words → the real day, worked out from the item's own date ──
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;
const dayOf = (date: string, add = 0) => WEEKDAYS[new Date(new Date(date + "T12:00:00Z").getTime() + add * DAY_MS).getUTCDay()];
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
/** Words before a same-day word that make it a deadline/time ("lock today", "by 3pm today", "closes today"). */
const DEADLINE_CUE = /(?:\b(?:by|before|until|till|due|deadline|locks?|locked|closes?|closing|closed|ends?|finish(?:es)?|opens?|reopens?|starts?|on|from|at)|\d\s?(?:am|pm)|\d[:.]\d{2})\s*$/i;

/** "selections lock tomorrow" on a Wednesday item → "selections lock Thursday". Same-day words after a deadline cue
 *  become the day; otherwise they're dropped (the message header already says the day). Without a date, nothing changes.
 *  A dated note's "tomorrow"/"next week" stays as written: it was written relative to the day it was sent, not the item's date. */
export function resolveRelativeDays(text: string, date?: string, type?: FmtItem["type"]): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return text;
  const fromWriting = type === "note";
  let t = text;
  if (!fromWriting) {
    t = t.replace(/\btomorrow(\s+(?:morning|afternoon|evening|night))?\b/gi, (_m, part) => dayOf(date, 1) + (part ? part.toLowerCase() : ""));
    t = t.replace(/\bnext week\b(?!'s|’s)/gi, () => {
      const dow = new Date(date + "T12:00:00Z").getUTCDay(), add = ((8 - dow) % 7) || 7;
      return `the week of Monday ${ordinal(new Date(new Date(date + "T12:00:00Z").getTime() + add * DAY_MS).getUTCDate())}`;
    });
  }
  t = t.replace(/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, (_m, d) => d[0].toUpperCase() + d.slice(1).toLowerCase());
  t = t.replace(/\b(today|tonight|this (?:morning|afternoon|evening))\b/gi, (m, _w, off: number, all: string) => {
    // "today"/"this morning" with no deadline before them just repeat the header's day; "tonight"/"this evening" keep the time of day.
    if (/^(today|this morning)$/i.test(m) && !DEADLINE_CUE.test(all.slice(0, off))) return " ";
    const w = m.toLowerCase();
    return dayOf(date) + (w === "tonight" ? " evening" : w.startsWith("this ") ? " " + w.slice(5) : "");
  });
  return t.replace(/\s+([,.;:!?)])/g, "$1").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim().replace(/[\s,:;—–-]+$/, "");
}

export const MAX_LINE = 70;
/** A line that had to keep a deadline may run this much longer rather than lose it. */
const DEADLINE_SLACK = 20;
const URL_RE = /(?:\s+(?:at|here|via|see|on|from)[:]?)?\s*(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /(?:\s+(?:at|to|email|e-mail)[:]?)?\s*[\w.+-]+@[\w-]+\.[\w.-]+/gi;
const PHONE_RE = /(?:\s+(?:on|at|via|call|ring|tel|phone)[:.]?)?\s*\+?\(?\d[\d\s().-]{7,}\d/g;
/** Only real phone numbers (10+ digits) — never times like "10.30-11.30" or dates. */
const stripPhones = (s: string) => s.replace(PHONE_RE, (m) => ((m.match(/\d/g) ?? []).length >= 10 ? "" : m));
const CLAUSE_SPLIT = /\s*(?:[,;:]|\s[-–—]\s|\()\s*/;
const DAY_WORD = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow";
/** A deadline phrase: cue word … day/date/time ("lock Thursday", "by 3pm Monday", "due Friday 13th November"). */
const DEADLINE_RE = new RegExp(
  `\\b(?:by|before|until|till|due|deadline|locks?|locked|closes?|closing|ends?|opens?|reopens?)\\b[^,;:.!?()—–]{0,30}?\\b(?:${DAY_WORD}|\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}(?:[:.]\\d{2})?\\s?(?:am|pm))\\b(?:\\s+(?:${DAY_WORD}))?(?:\\s+(?:morning|afternoon|evening|\\d{1,2}(?:st|nd|rd|th)(?:\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))?))?`,
  "gi");

function clean(text: string): { t: string; stripped: boolean } {
  let t = stripPhones(text.replace(URL_RE, "").replace(EMAIL_RE, ""));
  const stripped = t !== text;
  t = t.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim().replace(/[\s,:;(-]+$/, "");
  return { t, stripped };
}

function cutWords(s: string, max: number): string {
  const cut = s.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,:;(—–-]+$/, "");
}

function shortHeadline(text: string): string {
  let { t, stripped } = clean(text);
  if (stripped) {
    // A link/number was taken out: keep the first clause ("trip money due, pay at …" → "trip money due").
    const first = t.split(CLAUSE_SPLIT)[0].trim();
    if (first.length >= 12) t = first;
    t = t.replace(/(?:\s+(?:or|and|on|at|via|to|call|ring|see|visit|here|details))+[\s,;:.-]*$/i, "").trim();
  }
  if (t.length <= MAX_LINE) return t;
  const sentence = t.split(/(?<=[.!?])\s+/)[0].replace(/[.!?]+$/, "");
  if (sentence.length <= MAX_LINE && sentence.length >= 12) return sentence;
  const clause = sentence.split(/\s*(?:[,;:]|\s[-–—]\s|\(|\s(?:and then|so that|because|which|please)\s)\s*/i)[0].trim();
  if (clause.length <= MAX_LINE && clause.length >= 12) return clause;
  return cutWords(sentence, MAX_LINE) + "…";
}

/** Short headline for the reminder line: no links/phones/emails; over MAX_LINE → first sentence, then first clause, then
 *  whole words + "…". A deadline ("selections lock Thursday", "by 3pm Monday") is never cut off: it's put back on the end. */
export function headline(text: string): string {
  const h = shortHeadline(text);
  const { t } = clean(text);
  const dl = [...t.matchAll(DEADLINE_RE)].pop()?.[0];
  if (!dl || h.toLowerCase().includes(dl.toLowerCase())) return h;
  const clause = t.split(CLAUSE_SPLIT).find((c) => c.toLowerCase().includes(dl.toLowerCase()));
  const ownClause = !!clause && clause.length <= 32 && !h.toLowerCase().includes(clause.toLowerCase());
  const tail = ownClause ? clause!.trim() : dl;
  let head = h.replace(/…$/, "");
  const budget = MAX_LINE + DEADLINE_SLACK - tail.length - 3;
  const cut = head.length > budget;
  if (cut) head = cutWords(head, budget);
  return ownClause && !cut ? `${head} — ${tail}` : `${head}… ${tail}`;
}

/** "Homework needed" → "homework due"; "Caspian needs change for Poppy Appeal" → "change for Poppy Appeal". */
export function tidyTitle(title: string, childName: string, date?: string, type?: FmtItem["type"]): string {
  let t = resolveRelativeDays((title || "").replace(/[*_]/g, "").trim().replace(/[.!]+$/, ""), date, type);
  if (childName && !/^(the children|everyone)$/i.test(childName)) {
    t = t.replace(new RegExp(`^${esc(childName)}('s)?\\s+(?:has got|has|needs to bring in|needs to bring|needs to take in|needs to take|needs|is having|is doing|will need|should bring|is)?\\s*`, "i"), "");
  }
  t = t.replace(/^(a|an)\s+/i, "");
  // "needed"/"required" are frame words, unless a day follows ("book bag needed Wednesday" keeps its deadline).
  t = t.replace(new RegExp(`\\b(needed|required)\\b(?!\\s+(?:on\\s+|by\\s+)?(?:${DAY_WORD}|the week))`, "gi"), " ");
  t = t.replace(/\s+([,.;:!?)])/g, "$1").replace(/\s+/g, " ").trim().replace(/[\s,:;—–-]+$/, "");
  if (!t) t = (title || "").trim();
  // A short label before a colon isn't the item: "Final reminder: meals lock Friday" → "meals lock Friday".
  t = t.replace(/^(?:final reminder|reminder|deadline|important|urgent|please note|note|update)\s*[:—–-]\s*(?=\S{2})/i, "");
  // Calendar markers read naturally: "October Half Term begins (school closes)" → "school closes for half term".
  t = t.replace(/^(?:\w+\s+)?half[\s-]?term\s+(?:begins|starts)\b.*$/i, "school closes for half term")
    .replace(/^(?:\w+\s+)?half[\s-]?term\s+(?:ends|finishes)\b.*$/i, "school reopens after half term");
  t = headline(t) || t;
  if (/^homework$/i.test(t)) t = "homework due";
  const [first, second] = t.split(" ");
  // Lower-case a sentence-case first word; keep acronyms (PE, Y3/4), known proper nouns (Halloween) and
  // two-word proper names (Forest School, Harry Potter). An acronym after it doesn't count ("Outdoor PE kit" → "outdoor PE kit").
  if (/^[A-Z][a-z']+[,;:]?$/.test(first) && !PROPER_FIRST.has(first.toLowerCase()) && !(second && /^[A-Z][a-z]/.test(second))) t = first.toLowerCase() + t.slice(first.length);
  return t;
}

/** Reminder line for a getWhatsOn item: school events lose their year prefix, get an emoji by topic, carry the parent's
 *  extra detail (as much as fits) and a share key so several children's copies become one line. */
export function fmtFromWhatsOn(w: WhatsOnItem, childName: string): FmtItem {
  const meta: ItemMeta = { kind: w.kind, sources: [w.source, ...(w.absorbed ?? []).map((a) => ({ table: a.table, id: a.id }))], ...(w.optIn ? { optIn: true } : {}) };
  if (w.kind !== "school event") {
    const type: FmtItem["type"] = w.source.table === "parent_notes" ? "note" : w.source.table === "school_reminders" ? "announcement" : "reminder";
    return { childName, title: w.title, emoji: w.emoji, type, date: w.date, meta };
  }
  const base = stripYearPrefix(w.title);
  let title = base;
  for (const d of w.details ?? []) if (`${title}, ${d}`.length <= MAX_LINE) title = `${title}, ${d}`;
  return { childName, title, emoji: itemEmoji({ title: base, emoji: "", type: "event" }), type: "event", date: w.date, shareKey: `event:${w.source.id}:${w.date}`, meta };
}

const joinNames = (n: string[]) => (n.length <= 2 ? n.join(" & ") : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`);

type Entry = { emoji: string; text: string; metas: ItemMeta[] };
function grouped(items: FmtItem[], family?: string[]): { child: string; entries: Entry[] }[] {
  // 1) One row per item; rows with the same share key and text merge their children.
  const rows: { children: string[]; emoji: string; text: string; key?: string; metas: ItemMeta[] }[] = [];
  for (const i of items) {
    const child = /^the children$/i.test(i.childName) || !i.childName ? "Everyone" : i.childName;
    const text = tidyTitle(i.title, i.childName, i.date, i.type);
    const same = i.shareKey && rows.find((r) => r.key === i.shareKey && r.text.toLowerCase() === text.toLowerCase());
    if (same) { if (!same.children.includes(child)) same.children.push(child); if (i.meta) same.metas.push(i.meta); continue; }
    rows.push({ children: [child], emoji: itemEmoji(i), text, key: i.shareKey, metas: i.meta ? [i.meta] : [] });
  }
  // 2) Label: every child of the family → "Everyone"; several → "A & B" (family order); one → the name.
  const order = (n: string) => { const k = family?.indexOf(n) ?? -1; return k < 0 ? 999 : k; };
  const label = (cs: string[]) => {
    if (cs.includes("Everyone")) return "Everyone";
    if (cs.length > 1 && family && family.length > 1 && family.every((f) => cs.includes(f))) return "Everyone";
    return joinNames([...cs].sort((a, b) => order(a) - order(b)));
  };
  const out: { child: string; size: number; entries: Entry[] }[] = [];
  for (const r of rows) {
    const child = label(r.children);
    let g = out.find((x) => x.child === child);
    if (!g) { g = { child, size: child === "Everyone" ? 0 : r.children.length > 1 ? 1 : 2, entries: [] }; out.push(g); }
    const dup = g.entries.find((e) => e.text.toLowerCase() === r.text.toLowerCase());
    if (dup) { dup.metas.push(...r.metas); continue; }
    g.entries.push({ emoji: r.emoji, text: r.text, metas: r.metas });
  }
  // 3) "Everyone" first, then shared lines, then each child's own (stable within each).
  return out.map((g, i) => ({ g, i })).sort((a, b) => a.g.size - b.g.size || a.i - b.i).map(({ g }) => ({ child: g.child, entries: g.entries }));
}

/** One line per item: "📚 Caspian: homework due". Pass the family's child names so shared lines can say "Everyone". */
export function formatLines(items: FmtItem[], family?: string[]): string[] {
  return grouped(items, family).flatMap((g) => g.entries.map((e) => `${e.emoji} ${g.child}: ${e.text}`));
}

// ── Lists for browsing (dashboard "upcoming", chat lookups): same wording as reminders, opt-in items kept and flagged ──
export interface DayLine {
  child: string; emoji: string; text: string; line: string;  // line = "🏫 Everyone: Halloween disco" (reminder wording)
  optIn: boolean;                                             // every item on the line is an opt-in school activity
  tag: "school" | "saved" | "weekly" | "lunch";
  sources: { table: string; id: string }[];                   // rows behind the line (incl. parent items folded into a school line)
}
export interface DayList { date: string; lines: DayLine[] }

/** getWhatsOn items → one list per date in reminder wording. `family` = the family's child first names. */
export function whatsOnDays(items: WhatsOnItem[], family: string[]): DayList[] {
  const onlyChild = family.length === 1 ? family[0] : null;
  const dates = [...new Set(items.map((i) => i.date))].sort();
  return dates.map((date) => {
    const fi = items.filter((i) => i.date === date).map((w) => fmtFromWhatsOn(w, w.childName ?? onlyChild ?? "the children"));
    const lines = grouped(fi, family).flatMap((g) => g.entries.map((e): DayLine => {
      const tables = new Set(e.metas.flatMap((m) => m.sources.map((s) => s.table)));
      const tag: DayLine["tag"] = tables.has("school_events") || tables.has("school_reminders") ? "school" : tables.has("weekly_lunch_plans") ? "lunch" : tables.has("child_reminders") ? "weekly" : "saved";
      const seen = new Set<string>();
      const sources = e.metas.flatMap((m) => m.sources).filter((s) => { const k = `${s.table}:${s.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
      return { child: g.child, emoji: e.emoji, text: e.text, line: `${e.emoji} ${g.child}: ${e.text}`, optIn: e.metas.length > 0 && e.metas.every((m) => m.optIn), tag, sources };
    }));
    return { date, lines };
  });
}

export const HEADERS = {
  morning: { top: "Good morning! ☀️ Here's what's on today:", end: "Have a great day!" },
  evening: { top: "Good evening! 🌙 A few things to get ready for tomorrow:", end: "Hope you have a lovely evening!" },
};

/** Full free-form message with real line breaks (only inside the parent's 24h window). */
export function formatFreeform(items: FmtItem[], period: "morning" | "evening", family?: string[]): string {
  const h = HEADERS[period];
  return [h.top, ...formatLines(items, family), h.end].join("\n");
}

/** Template variable {{1}}: single line, no newlines. "Everyone: 🏫 school reopens after half term; Caspian: 📚 homework due • 🥪 packed lunch". */
export function formatTemplateVar(items: FmtItem[], family?: string[]): string {
  return grouped(items, family).map((g) => `${g.child}: ${g.entries.map((e) => `${e.emoji} ${e.text}`).join(" • ")}`).join("; ").replace(/[\r\n]+/g, " ");
}
