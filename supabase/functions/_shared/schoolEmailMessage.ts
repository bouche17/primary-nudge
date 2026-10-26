// School email → WhatsApp text. Pure (no AI, no database), shared by handle-school-email and the free tests.
// The result fills one template variable, so it must stay on one line.

export interface SchoolEmailInfo {
  message?: string | null;
  tldr?: string | null; what?: string | null; who?: string | null; when?: string | null;
  cost?: string | null; action?: string | null; links?: string[]; yearGroups?: string[];
  eventTitle?: string | null; eventDate?: string | null; optInGroup?: string | null;
}

export const hasValue = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return !!s && !["null", "undefined", "n/a", "na", "none", "not stated", "not specified", "unknown", "tbc", "-"].includes(s);
};

const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
export const isWholeSchool = (e: SchoolEmailInfo) => !e.yearGroups?.length || e.yearGroups.some((y) => /^all$/i.test(y));

/** Drop mailto/tel, anything already in the text, and duplicates. */
export function usefulLinks(links: string[] | undefined, text: string): string[] {
  const lower = text.toLowerCase(), seen = new Set<string>();
  return (links ?? []).map((l) => (l || "").trim()).filter((l) => {
    if (!l || /^(mailto:|tel:)/i.test(l)) return false;
    const k = l.toLowerCase(), bare = k.replace(/^[a-z]+:\/\//, "");
    if (lower.includes(k) || lower.includes(bare) || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const joinNames = (n: string[]) => n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
const joinOr = (n: string[]) => n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} or ${n[n.length - 1]}`;

/** "If Ava's in the Y3/4 girls' football team:" / "If Ava or Ben is taking part:" — for opt-in emails. */
export function conditionalLine(names: string[], group?: string | null): string {
  const who = joinOr(names);
  const verb = names.length === 1 && !/s$/i.test(names[0]) ? `${who}'s` : `${who} is`;
  const g = hasValue(group) ? oneLine(group).replace(/[.:;,\s]+$/, "") : "";
  if (!g) return `If ${verb} taking part:`;
  return `If ${verb} ${/^(in|on|part of|playing|taking|going|selected|chosen)\b/i.test(g) ? "" : "in "}${g}:`;
}

/** Natural message; "For Caspian: …" only when the email targets specific year groups;
 *  opt-in emails start "If Caspian's in …:" instead (children are never filtered by gender). */
export function buildSchoolMessage(e: SchoolEmailInfo, childNames: string[] = [], optIn = false): string {
  let body = hasValue(e.message) ? oneLine(e.message) : "";
  if (!body) {
    // Fallback from the fields: "{what} on {when}. {action}"
    const what = hasValue(e.what) ? e.what.trim() : hasValue(e.tldr) ? e.tldr.trim() : "News from school";
    const first = `${what}${hasValue(e.when) ? ` on ${e.when.trim()}` : ""}${hasValue(e.cost) ? ` (${e.cost.trim()})` : ""}`.replace(/[.\s]+$/, "") + ".";
    const action = hasValue(e.action) ? " " + e.action.trim().replace(/([^.!?])$/, "$1.") : "";
    body = oneLine(first.charAt(0).toUpperCase() + first.slice(1) + action);
  }
  const names = [...new Set(childNames.filter(Boolean))];
  if (optIn && names.length) body = `${conditionalLine(names, e.optInGroup)} ${body}`;
  else if (!isWholeSchool(e) && names.length) body = `For ${joinNames(names)}: ${body}`;
  const links = usefulLinks(e.links, body);
  return oneLine(links.length ? `${body} ${links.join(" ")}` : body);
}

/** The previous labelled format, kept only for before/after dry runs. */
export function buildOldSchoolMessage(e: SchoolEmailInfo): string {
  let m = `📋 TL;DR: ${e.tldr ?? ""}`;
  for (const [k, label] of [["what", "What"], ["who", "Who"], ["when", "When"], ["cost", "Cost"], ["action", "Action"]] as const)
    if (hasValue(e[k])) m += ` | ${label}: ${e[k]}`;
  const links = usefulLinks(e.links, m);
  return links.length ? `${m} ${links.join(" ")}` : m;
}
