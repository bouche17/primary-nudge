// Morning/evening reminder layout. Pure (no database), shared by send-reminders and the free tests.
// Free-form (parent's 24h window open): one "emoji Child: item" per line, grouped by child.
// Template (window closed): WhatsApp template variables can't hold newlines, so one line per family.

export interface FmtItem { childName: string; title: string; emoji: string; type: "reminder" | "event" | "note" | "announcement" }

const GENERIC = new Set(["", "✅", "📝"]);
const KEYWORD_EMOJI: [RegExp, string][] = [
  [/homework/i, "📚"], [/lunch/i, "🥪"], [/swim/i, "🏊"], [/\b(money|change|cash|coins?|pay(ment)?)\b|£/i, "🪙"], [/\bpe\b|\bkit\b/i, "👟"],
  [/reading|library|\bbook/i, "📖"], [/\btrip\b/i, "🚌"], [/non.?uniform|dress.?up|costume/i, "👕"],
  [/photo/i, "📸"], [/forest/i, "🌳"], [/football|netball|rugby|sport/i, "⚽"], [/disco|party/i, "🎉"],
];
const DEFAULT_EMOJI: Record<FmtItem["type"], string> = { note: "📝", event: "🏫", reminder: "✅", announcement: "✅" };

export function itemEmoji(i: FmtItem): string {
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

export const MAX_LINE = 70;
const URL_RE = /(?:\s+(?:at|here|via|see|on|from)[:]?)?\s*(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /(?:\s+(?:at|to|email|e-mail)[:]?)?\s*[\w.+-]+@[\w-]+\.[\w.-]+/gi;
const PHONE_RE = /(?:\s+(?:on|at|via|call|ring|tel|phone)[:.]?)?\s*\+?\(?\d[\d\s().-]{7,}\d/g;
/** Only real phone numbers (10+ digits) — never times like "10.30-11.30" or dates. */
const stripPhones = (s: string) => s.replace(PHONE_RE, (m) => ((m.match(/\d/g) ?? []).length >= 10 ? "" : m));

/** Short headline for the reminder line: no links/phones/emails; over MAX_LINE → first sentence, then first clause, then whole words + "…". */
export function headline(text: string): string {
  let t = stripPhones(text.replace(URL_RE, "").replace(EMAIL_RE, ""));
  const stripped = t !== text;
  t = t.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim().replace(/[\s,:;(-]+$/, "");
  if (stripped) {
    // A link/number was taken out: keep the first clause ("trip money due, pay at …" → "trip money due").
    const first = t.split(/\s*(?:[,;:]|\s[-–—]\s|\()\s*/)[0].trim();
    if (first.length >= 12) t = first;
    t = t.replace(/(?:\s+(?:or|and|on|at|via|to|call|ring|see|visit|here|details))+[\s,;:.-]*$/i, "").trim();
  }
  if (t.length <= MAX_LINE) return t;
  const sentence = t.split(/(?<=[.!?])\s+/)[0].replace(/[.!?]+$/, "");
  if (sentence.length <= MAX_LINE && sentence.length >= 12) return sentence;
  const clause = sentence.split(/\s*(?:[,;:]|\s[-–—]\s|\(|\s(?:and then|so that|because|which|please)\s)\s*/i)[0].trim();
  if (clause.length <= MAX_LINE && clause.length >= 12) return clause;
  const cut = sentence.slice(0, MAX_LINE - 1);
  const words = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,:;(-]+$/, "");
  return words + "…";
}

/** "Homework needed" → "homework due"; "Caspian needs change for Poppy Appeal" → "change for Poppy Appeal". */
export function tidyTitle(title: string, childName: string): string {
  let t = (title || "").replace(/[*_]/g, "").trim().replace(/[.!]+$/, "");
  if (childName && !/^(the children|everyone)$/i.test(childName)) {
    t = t.replace(new RegExp(`^${esc(childName)}('s)?\\s+(?:has got|has|needs to bring in|needs to bring|needs to take in|needs to take|needs|is having|is doing|will need|should bring|is)?\\s*`, "i"), "");
  }
  t = t.replace(/^(a|an)\s+/i, "");
  t = t.replace(/\b(needed|required|today|tomorrow|this morning|tomorrow morning)\b/gi, " ").replace(/\s+/g, " ").trim().replace(/[\s,:;-]+$/, "");
  if (!t) t = (title || "").trim();
  t = headline(t) || t;
  if (/^homework$/i.test(t)) t = "homework due";
  const [first, second] = t.split(" ");
  // Lower-case a sentence-case first word; keep acronyms (PE, Y3/4), known proper nouns (Halloween) and
  // two-word proper names (Forest School, Harry Potter). An acronym after it doesn't count ("Outdoor PE kit" → "outdoor PE kit").
  if (/^[A-Z][a-z']+$/.test(first) && !PROPER_FIRST.has(first.toLowerCase()) && !(second && /^[A-Z][a-z]/.test(second))) t = first.toLowerCase() + t.slice(first.length);
  return t;
}

function grouped(items: FmtItem[]): { child: string; entries: { emoji: string; text: string }[] }[] {
  const out: { child: string; entries: { emoji: string; text: string }[] }[] = [];
  for (const i of items) {
    const child = /^the children$/i.test(i.childName) || !i.childName ? "Everyone" : i.childName;
    let g = out.find((x) => x.child === child);
    if (!g) { g = { child, entries: [] }; out.push(g); }
    const text = tidyTitle(i.title, i.childName);
    if (g.entries.some((e) => e.text.toLowerCase() === text.toLowerCase())) continue;
    g.entries.push({ emoji: itemEmoji(i), text });
  }
  return out;
}

/** One line per item: "📚 Caspian: homework due". */
export function formatLines(items: FmtItem[]): string[] {
  return grouped(items).flatMap((g) => g.entries.map((e) => `${e.emoji} ${g.child}: ${e.text}`));
}

export const HEADERS = {
  morning: { top: "Good morning! ☀️ Here's what's on today:", end: "Have a great day!" },
  evening: { top: "Good evening! 🌙 A few things to get ready for tomorrow:", end: "Hope you have a lovely evening!" },
};

/** Full free-form message with real line breaks (only inside the parent's 24h window). */
export function formatFreeform(items: FmtItem[], period: "morning" | "evening"): string {
  const h = HEADERS[period];
  return [h.top, ...formatLines(items), h.end].join("\n");
}

/** Template variable {{1}}: single line, no newlines. "Caspian: 📚 homework due • 🥪 packed lunch; Ivy: 🏫 trip". */
export function formatTemplateVar(items: FmtItem[]): string {
  return grouped(items).map((g) => `${g.child}: ${g.entries.map((e) => `${e.emoji} ${e.text}`).join(" • ")}`).join("; ").replace(/[\r\n]+/g, " ");
}
