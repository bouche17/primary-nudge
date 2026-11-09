// Parent-facing source answers. Pure formatting shared by chat context, deterministic replies and free tests.
import type { WhatsOnItem } from "./whatsOn.ts";

export const PROVENANCE_QUESTION = /\b(?:where\s+(?:has|did|does)|who\s+told\s+you|what(?:'s| is)\s+(?:the\s+)?source|how\s+do\s+you\s+know|where\s+did\s+you\s+(?:get|find)|where\s+(?:is|was)\s+(?:that|this)\s+from)\b/i;

const shortDate = (value: string) => new Date(value).toLocaleDateString("en-GB", {
  weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London",
});

export function yearGroupLabel(yearGroup?: string | null): string {
  const y = (yearGroup || "").trim();
  if (!y || /^(all|whole school|everyone)$/i.test(y)) return "the whole school";
  if (/^unknown$/i.test(y)) return "no confirmed year group";
  const parts = y.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 3 && parts[0] === "Reception" && parts[1] === "Year 1" && parts[2] === "Year 2") return "Reception–Year 2";
  return parts.join(", ").replace(/, ([^,]+)$/, " and $1");
}

export function itemProvenance(item: WhatsOnItem): string | null {
  if (item.source.table === "school_events") {
    const school = item.schoolName || "the school";
    const suffix = item.yearUnknown
      ? "The year group isn't confirmed, so it isn't included in automatic reminders."
      : `listed for ${yearGroupLabel(item.yearGroup)}.`;
    return `That's from ${school}'s online calendar (${shortDate(item.date + "T12:00:00Z")}), ${suffix}`;
  }
  if (item.source.table === "parent_notes") {
    if (!item.createdAt) return null;
    if (item.sourceType === "school_email") {
      return `From a ${item.schoolName || "school"} email on ${shortDate(item.createdAt)}.`;
    }
    return `You saved that on ${shortDate(item.createdAt)}.`;
  }
  return null;
}
