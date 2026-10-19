// Morning/evening reminder layout. Pure (no database), shared by send-reminders and the free tests.
// Free-form (parent's 24h window open): one "emoji Child: item" per line, grouped by child.
// Template (window closed): WhatsApp template variables can't hold newlines, so one line per family.

export interface FmtItem { childName: string; title: string; emoji: string; type: "reminder" | "event" | "note" | "announcement" }

const GENERIC = new Set(["", "✅", "📝"]);
const KEYWORD_EMOJI: [RegExp, string][] = [
  [/homework/i, "📚"], [/lunch/i, "🥪"], [/\b(money|change|cash|coins?|pay(ment)?)\b|£/i, "🪙"], [/\bpe\b|\bkit\b/i, "👟"],
  [/swim/i, "🏊"], [/reading|library|\bbook/i, "📖"], [/\btrip\b/i, "🚌"], [/non.?uniform|dress.?up|costume/i, "👕"],
  [/photo/i, "📸"], [/forest/i, "🌳"], [/football|netball|rugby|sport/i, "⚽"], [/disco|party/i, "🎉"],
];
const DEFAULT_EMOJI: Record<FmtItem["type"], string> = { note: "📝", event: "🏫", reminder: "✅", announcement: "✅" };

export function itemEmoji(i: FmtItem): string {
  const e = (i.emoji || "").trim();
  if (!GENERIC.has(e)) return e;
  if (/packed lunch/i.test(i.title)) return "🥪";
  for (const [re, em] of KEYWORD_EMOJI) if (re.test(i.title)) return em;
  return e || DEFAULT_EMOJI[i.type] || "✅";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Homework needed" → "homework due"; "Caspian needs change for Poppy Appeal" → "change for Poppy Appeal". */
export function tidyTitle(title: string, childName: string): string {
  let t = (title || "").replace(/[*_]/g, "").trim().replace(/[.!]+$/, "");
  if (childName && !/^(the children|everyone)$/i.test(childName)) {
    t = t.replace(new RegExp(`^${esc(childName)}('s)?\\s+(?:has got|has|needs to bring|needs to take|needs|is having|is doing|will need|should bring|is)?\\s*`, "i"), "");
  }
  t = t.replace(/^(a|an)\s+/i, "");
  t = t.replace(/\b(needed|required|today|tomorrow|this morning|tomorrow morning)\b/gi, " ").replace(/\s+/g, " ").trim().replace(/[\s,:;-]+$/, "");
  if (!t) t = (title || "").trim();
  if (/^homework$/i.test(t)) t = "homework due";
  const [first, second] = t.split(" ");
  // Lower-case a sentence-case first word; keep acronyms (PE, Y3/4) and multi-word proper names (Forest School).
  if (/^[A-Z][a-z']+$/.test(first) && !(second && /^[A-Z]/.test(second))) t = first.toLowerCase() + t.slice(first.length);
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
