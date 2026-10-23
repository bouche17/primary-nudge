// How a school is shown to parents and Matt: name + street/town + postcode. Pure (no imports):
// the sign-up pages, the dashboard, Monty's chat and the sign-up alerts all use it.
export interface SchoolLike {
  name: string;
  address?: string | null;
  town?: string | null;
  postcode?: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Street and locality parts of the stored address, without repeats, the school's own name or the postcode. */
export function addressParts(s: SchoolLike): string[] {
  const out: string[] = [];
  const pc = compact(s.postcode || "");
  for (const raw of (s.address || "").split(",")) {
    const p = raw.trim();
    if (!p) continue;
    const n = norm(p);
    if (/\b(school|primary|academy|infants?|juniors?)\b/i.test(p)) continue;
    if (pc && compact(p).includes(pc)) {
      const stripped = p.replace(new RegExp(s.postcode!.replace(/\s+/g, "\\s*"), "i"), "").trim();
      if (stripped && !out.some((o) => norm(o) === norm(stripped))) out.push(stripped);
      continue;
    }
    if (out.some((o) => norm(o) === n || n.startsWith(norm(o) + " "))) continue;
    out.push(p);
  }
  return out;
}

/** "Marlborough Road, Sale, M33 3AF" */
export function schoolPlace(s: SchoolLike): string {
  const parts = addressParts(s);
  const town = (s.town || "").trim();
  if (town && !parts.some((p) => norm(p) === norm(town) || norm(p).endsWith(" " + norm(town)))) parts.push(town);
  if (s.postcode) parts.push(s.postcode.trim().toUpperCase());
  return parts.join(", ");
}

/** "Sale, M33 3AF" (town + postcode only), falling back to the last address part. */
export function schoolTownPostcode(s: SchoolLike): string {
  const parts = addressParts(s);
  const town = (s.town || "").trim() || parts[parts.length - 1] || "";
  return [town, (s.postcode || "").trim().toUpperCase()].filter(Boolean).join(", ");
}

/** One line for confirmations, chat and alerts: "St Joseph's Catholic Primary School, Marlborough Road, Sale M33 3AF". */
export function schoolOneLine(s: SchoolLike): string {
  const place = schoolPlace(s);
  const pc = (s.postcode || "").trim().toUpperCase();
  const tidy = pc && place.endsWith(", " + pc) ? place.slice(0, -(pc.length + 2)) + " " + pc : place;
  return tidy ? `${s.name.trim()}, ${tidy}` : s.name.trim();
}

/** Names that appear more than once in a result list (normalised). */
export function repeatedNames(list: SchoolLike[]): Set<string> {
  const seen = new Map<string, number>();
  for (const s of list) seen.set(norm(s.name), (seen.get(norm(s.name)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

/** A search result line. When several results share a name, the town/postcode comes first so they're easy to tell apart. */
export function schoolResultLabel(s: SchoolLike, repeated: Set<string>): { primary: string; secondary: string } {
  if (repeated.has(norm(s.name))) {
    const street = addressParts(s)[0];
    return { primary: schoolTownPostcode(s), secondary: street ? `${s.name.trim()} – ${street}` : s.name.trim() };
  }
  return { primary: s.name.trim(), secondary: schoolPlace(s) };
}

/** Plain-text search line for chat: "St Joseph's … – Etchells Street, St Petersgate, Stockport, SK1 1EF". */
export function schoolChatOption(s: SchoolLike): string {
  const place = schoolPlace(s);
  return place ? `${s.name.trim()} – ${place}` : s.name.trim();
}

// ── Chat: "you've got the wrong school" ──
// Whole-intent phrases only, so "the bus stop moved" or "she doesn't go there on Fridays" (clubs) don't trigger it.
const WRONG_SCHOOL_RE: RegExp[] = [
  /\bwrong school\b/i,
  /\b(i'?m|im|i am|we'?re|we are|she'?s|he'?s|they'?re|she is|he is|they are)\s+not\s+(with|at|from|in|part of)\s+(that|this|the|your)\s+school\b/i,
  /\b(that'?s|that is|this is|it'?s|it is)\s+not\s+(my|our|the right|the correct|his|her|their|[a-z]+'s)\s+(child'?s\s+|kids?'?\s+)?school\b/i,
  /\bnot\s+(my|our)\s+(child'?s\s+|kids?'?\s+|son'?s\s+|daughter'?s\s+)?school\b/i,
  /\b(doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not)\s+(go|goes|going)?\s*(to|at|in)\s+(that|this)\s+school\b/i,
  /\b(we|i|she|he|they)\s+(never|don'?t|do not|doesn'?t|does not)\s+(go|went|attend)\s+(there|to that school|to this school)\b/i,
  /\b(left|moved|changed)\s+(that|this)\s+school\b|\b(changed|moved)\s+schools?\b/i,
];
export function isWrongSchoolMessage(message: string): boolean {
  const m = (message || "").trim();
  if (!m) return false;
  const words = m.split(/\s+/).length;
  if (WRONG_SCHOOL_RE.slice(0, 5).some((r) => r.test(m))) return true;
  // "she doesn't go there" style needs a short message or the word school.
  return (words <= 8 || /\bschool\b/i.test(m)) && WRONG_SCHOOL_RE.slice(5).some((r) => r.test(m));
}

const SEARCH_FILLER = new Set(["i", "im", "my", "our", "we", "she", "he", "they", "her", "his", "their", "goes", "go", "going", "attends", "attend",
  "to", "at", "in", "is", "its", "it", "the", "called", "one", "ones", "oh", "sorry", "actually", "near", "by", "please", "thanks", "thank", "you",
  "hi", "hello", "and", "now", "currently", "school's", "s", "a", "an", "that", "this", "which", "ok", "okay", "yes", "no", "not", "with"]);
/** Search words for the school table, from a parent's free-text answer (child names and filler removed). */
export function schoolSearchQuery(message: string, childNames: string[] = []): string {
  const names = new Set(childNames.map((n) => n.toLowerCase()));
  const cleaned = (message || "").replace(/\bc\.?\s*of\s*e\.?\b|\bcofe\b/gi, " ").replace(/['’`]/g, "");
  const pcs: string[] = [...(cleaned.match(/\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/g) ?? [])];
  let rest = cleaned;
  for (const p of pcs) rest = rest.replace(p, " ");
  const words = rest.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SEARCH_FILLER.has(w) && !names.has(w));
  return [...pcs.map((p) => p.replace(/\s+/g, "").toUpperCase()), ...words].join(" ").trim();
}
/** The message reads like a school answer (school words or a postcode), even if nothing was found. */
export function looksLikeSchoolAnswer(message: string): boolean {
  return /\b(school|primary|academy|infants?|juniors?|c\s*of\s*e|cofe|catholic|church|rc|st|saint|community|county|first school)\b/i.test(message)
    || /\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b/.test(message);
}
