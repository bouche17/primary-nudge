// School-event rules shared by reminders (whatsOn.ts), the dashboard and the chat duplicate check.
// Pure, no imports: the web app imports this file directly, so keep it free of Deno/npm specifics.

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** "Y1", "Year 1", "1" → "1"; "Reception"/"R"/"YR" → "R"; "all"/blank → null (everyone). Lists split on , / & "and". */
export function normaliseYearGroups(v: string | null | undefined): Set<string> | null {
  if (!v || !v.trim() || /^\s*(all|whole school|everyone)\s*$/i.test(v)) return null;
  const out = new Set<string>();
  for (const part of v.split(/,|\/|&|\band\b/i)) {
    const p = part.trim();
    if (!p) continue;
    if (/^(all|whole school)$/i.test(p)) return null;
    if (/^(reception|r|yr|year\s*r)$/i.test(p)) { out.add("R"); continue; }
    const m = p.match(/^(?:y(?:ear)?\s*)?(\d{1,2})$/i);
    if (m) out.add(String(Number(m[1])));
    else out.add(norm(p));
  }
  return out.size ? out : null;
}

/** The event's year groups. A stored "all"/blank is narrowed by a key stage in the title
 *  (KS1 → R,1,2; KS2 → 3–6; EYFS/Nursery → R). A stored year group is never widened. */
export function eventYearGroups(stored: string | null | undefined, title?: string | null): Set<string> | null {
  const base = normaliseYearGroups(stored);
  if (base || !title) return base;
  const t = ` ${norm(title)} `;
  const out = new Set<string>();
  if (/ (ks ?1|key stage 1|keystage 1) /.test(t)) ["R", "1", "2"].forEach((y) => out.add(y));
  if (/ (ks ?2|key stage 2|keystage 2) /.test(t)) ["3", "4", "5", "6"].forEach((y) => out.add(y));
  if (/ (eyfs|nursery) /.test(t)) out.add("R");
  return out.size ? out : null;
}

/** Does the event reach a child in `childYear`? Pass the title so a key-stage title narrows an "all" event. */
export function yearGroupMatches(eventYears: string | null, childYear: string | null, title?: string | null): boolean {
  const ev = eventYearGroups(eventYears, title);
  if (!ev) return true;
  const kid = normaliseYearGroups(childYear);
  if (!kid) return false;
  for (const k of kid) if (ev.has(k)) return true;
  return false;
}

// ── Opt-in school events (Matt's rule): left out of reminders unless the parent saved them. Edit the lists here. ──
export const OPT_IN_WORDS = [
  "club", "clubs", "asc", "after school club", "breakfast club", "tournament", "tournaments", "match", "matches", "fixture", "fixtures",
  "squad", "team", "teams", "trials", "trial", "auditions", "audition", "lessons", "lesson", "tuition", "party", "parties",
  "sign up", "signup", "sign ups", "taster", "tasters",
];
/** After-school sport and activity sessions count as clubs. */
export const ACTIVITY_WORDS = [
  "football", "netball", "rugby", "tag rugby", "hockey", "cricket", "basketball", "athletics", "cross country", "gymnastics",
  "multi skills", "multiskills", "dance", "choir", "orchestra", "band", "coding", "chess", "drama club", "art club", "cooking club",
].map(norm);
/** A year-group event starting at/after OPT_IN_AFTER (UK) is opt-in unless its title has one of these. */
export const ALWAYS_INCLUDE_WORDS = [
  "trip", "trips", "parents evening", "parent evening", "performance", "performances", "play", "plays", "assembly", "assemblies",
  "concert", "concerts", "disco", "discos", "fair", "fairs", "photos", "photo", "photographs", "swimming", "workshop", "workshops",
  "meeting", "meetings",
].map(norm);
export const OPT_IN_AFTER = { hour: 15, minute: 15 };

function ukMinutes(ts: string | Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return n("hour") * 60 + n("minute");
}

/** Opt-in = an OPT_IN_WORDS or ACTIVITY_WORDS phrase (whole words), or a year-group event from 15:15 UK without an
 *  always-include word. "Party" doesn't count for a whole-school disco. */
export function isOptInEvent(title: string, yearGroup: string | null, startAt?: string | Date | null): boolean {
  const t = ` ${norm(title)} `;
  const has = (list: string[]) => list.filter((w) => t.includes(` ${w} `));
  const wholeSchool = eventYearGroups(yearGroup, title) === null;
  const hits = has(OPT_IN_WORDS);
  if (hits.length && !(wholeSchool && / disco /.test(t) && hits.every((w) => w === "party" || w === "parties"))) return true;
  if (has(ACTIVITY_WORDS).length) return true;
  if (!wholeSchool && startAt && ukMinutes(startAt) >= OPT_IN_AFTER.hour * 60 + OPT_IN_AFTER.minute && !has(ALWAYS_INCLUDE_WORDS).length) return true;
  return false;
}

// ── Same-day calendar markers ("School closes" + "October Half Term begins (school closes)") ──
const MARKER_STOP = new Set(["the", "a", "an", "of", "and", "at", "for", "to", "on", "in", "begins", "begin", "starts", "start", "ends", "end", "finishes", "finish"]);
/** Meaningful words of a title: brackets/punctuation ignored, "reopens" = "opens", simple plurals folded. */
export function markerWords(title: string): Set<string> {
  return new Set(norm(title).split(" ").filter((w) => w && !MARKER_STOP.has(w))
    .map((w) => w.replace(/^re(?=open)/, ""))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));
}
/** True when every meaningful word of `a` is in `b` (so `b` says everything `a` does). */
export function markerContained(a: string, b: string): boolean {
  const wa = markerWords(a), wb = markerWords(b);
  return wa.size > 0 && [...wa].every((w) => wb.has(w));
}
