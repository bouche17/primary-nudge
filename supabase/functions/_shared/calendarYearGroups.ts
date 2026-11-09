// SchoolSpider FullCalendar className → year_group. Pure and database-free so the free suite can test it.
// Generic decoding: customN = Year N (custom0 Reception, custom Year 1, customstaff all);
// multi_<tokens> split on "_" ("0" Reception, "" Year 1, "1"-"6" Year N, "staff" ignored unless alone).
// Blank or undecodable classes are "unknown" (never "all"); unknown events are never sent automatically.

const ORDER = ["Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6"];

/** Only where the generic decoder would disagree with a deliberate choice. null = skip the event. */
export const CLASS_NAME_OVERRIDES: Record<string, string | null> = {
  multi_0_staff: null, // staff-only entry duplicated onto Reception's view
};

const token = (t: string): string | "staff" | undefined => {
  if (t === "") return "Year 1";
  if (t === "0") return "Reception";
  if (/^[1-6]$/.test(t)) return `Year ${t}`;
  if (t === "staff") return "staff";
  return undefined;
};

/** Returns a comma list, "all", "unknown", or null (staff-only: skip the event). */
export function decodeClassName(cls: string | null | undefined): string | null {
  const c = (cls || "").trim();
  if (Object.prototype.hasOwnProperty.call(CLASS_NAME_OVERRIDES, c)) return CLASS_NAME_OVERRIDES[c];
  if (c === "customstaff") return "all";
  let tokens: string[];
  const custom = c.match(/^custom(\d?)$/);
  if (custom) tokens = [custom[1] === "1" ? "" : custom[1]];
  else if (c.startsWith("multi_")) tokens = c.slice(6).split("_");
  else return "unknown";
  const years = new Set<string>();
  let staff = false;
  for (const t of tokens) {
    const y = token(t);
    if (y === undefined) return "unknown";
    if (y === "staff") staff = true; else years.add(y);
  }
  if (!years.size) return staff ? null : "unknown";
  const list = ORDER.filter((y) => years.has(y));
  return list.length === ORDER.length ? "all" : list.join(",");
}
