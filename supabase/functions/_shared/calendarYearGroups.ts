// Dean Valley FullCalendar parsing and year targeting. Pure and database-free so the free suite can test it.
// The /events "Whole School" page is an aggregate of every year. An event is therefore whole-school only when
// it appears in all seven year views; a subset of views is authoritative, and no views means "unknown".

export const YEAR_VIEW_NAMES = ["Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6"] as const;
export type YearViewName = typeof YEAR_VIEW_NAMES[number];
export type YearViews = Record<YearViewName, RawCalendarEvent[]>;

export interface RawCalendarEvent {
  title?: string;
  start?: string;
  end?: string;
  url?: string;
  className?: string;
}

// Used only when one or more year views cannot be fetched/parsed. Blank and unmapped classes are never everyone.
export const CLASS_NAME_MAP: Record<string, string | null> = {
  "": "unknown",
  custom0: "Reception",
  custom: "Year 1",
  custom2: "Year 2",
  custom3: "Year 3",
  custom4: "Year 4",
  custom5: "Year 5",
  custom6: "Year 6",
  customstaff: "all",
  multi_3_4: "Year 3,Year 4",
  multi_5_6: "Year 5,Year 6",
  multi_3_4_5: "Year 3,Year 4,Year 5",
  multi_4_5_6: "Year 4,Year 5,Year 6",
  multi_3_4_5_6: "Year 3,Year 4,Year 5,Year 6",
  multi_0__2: "Reception,Year 1,Year 2",
  multi__2: "Year 1,Year 2",
  multi__2_3_4_5_6: "Year 1,Year 2,Year 3,Year 4,Year 5,Year 6",
  multi_4_5_3: "Year 3,Year 4,Year 5",
  multi_4_5: "Year 4,Year 5",
  multi_6_5: "Year 5,Year 6",
  multi_2_3: "Year 2,Year 3",
  multi_2_3_4: "Year 2,Year 3,Year 4",
  multi_3_4_5_6_2: "Year 2,Year 3,Year 4,Year 5,Year 6",
  multi_5_6_2: "Year 2,Year 5,Year 6",
  multi_0_6: "Reception,Year 6",
  multi_0_2_: "Reception,Year 1,Year 2",
  multi_0__2_4_5_6: "Reception,Year 1,Year 2,Year 4,Year 5,Year 6",
  multi_0__2_3: "Reception,Year 1,Year 2,Year 3",
  multi_0_3_2: "Reception,Year 2,Year 3",
  multi_0_staff: null,
};

export interface ParsedCalendarEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  yearGroup: string;
  className: string;
  targetingSource: "year_views" | "className";
}

export interface CalendarDebugEvent { title: string; className: string; mapped: string | "SKIPPED" }

export function extractFullCalendarEvents(html: string): RawCalendarEvent[] {
  const matches = [...html.matchAll(/events\s*:\s*(\[[\s\S]*?\])\s*[,}]/g)];
  let arrStr = "";
  for (const m of matches) {
    if (m[1].trim() !== "[]") { arrStr = m[1]; break; }
  }
  if (!arrStr) throw new Error("Could not find non-empty fullCalendar events array");
  const parsed = JSON.parse(arrStr);
  if (!Array.isArray(parsed)) throw new Error("FullCalendar events value is not an array");
  return parsed as RawCalendarEvent[];
}

/** Exact school-owned year-view links, discovered from the events page rather than hard-coded. */
export function discoverYearViewLinks(html: string, feedUrl: string): Partial<Record<YearViewName, string>> {
  const out: Partial<Record<YearViewName, string>> = {};
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if ((YEAR_VIEW_NAMES as readonly string[]).includes(label)) out[label as YearViewName] = new URL(m[1], feedUrl).toString();
  }
  return out;
}

const eventKey = (e: RawCalendarEvent) => `${(e.title || "Untitled").trim().replace(/\s+/g, " ").toLowerCase()}|${e.start || ""}`;

/** Match title + start time across the school's own views. No year views matched = unknown, never all. */
export function yearGroupsFromViews(event: RawCalendarEvent, views: YearViews): string {
  const key = eventKey(event);
  const found = YEAR_VIEW_NAMES.filter((name) => views[name].some((e) => eventKey(e) === key));
  if (found.length === YEAR_VIEW_NAMES.length) return "all";
  return found.length ? found.join(",") : "unknown";
}

export function fallbackYearGroup(className: string): string | null {
  return Object.prototype.hasOwnProperty.call(CLASS_NAME_MAP, className) ? CLASS_NAME_MAP[className] : "unknown";
}

export function parseFullCalendarHtml(html: string, views?: YearViews): { events: ParsedCalendarEvent[]; debug: CalendarDebugEvent[] } {
  const raw = extractFullCalendarEvents(html);
  const results: ParsedCalendarEvent[] = [];
  const debug: CalendarDebugEvent[] = [];
  const keywordRegex = /inset|opens|closed|holiday|term/i;

  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    const cls = e.className || "";
    const fallback = fallbackYearGroup(cls);
    // Staff-only entries stay excluded in either mode.
    if (fallback === null) continue;
    const mapped = views ? yearGroupsFromViews(e, views) : fallback;
    const title = e.title || "Untitled";
    if (keywordRegex.test(title) || mapped === "unknown") debug.push({ title, className: cls, mapped });
    const hasTime = !!e.start?.includes(" ") && !e.start.endsWith("00:00:00");
    results.push({
      uid: `fullcal-${i}-${e.start || Date.now()}`,
      title,
      description: "",
      location: "",
      startAt: e.start ? new Date(e.start.replace(" ", "T") + "Z").toISOString() : new Date().toISOString(),
      endAt: e.end ? new Date(e.end.replace(" ", "T") + "Z").toISOString() : null,
      allDay: !hasTime,
      yearGroup: mapped,
      className: cls,
      targetingSource: views ? "year_views" : "className",
    });
  }
  return { events: results, debug };
}

export function unmappedClassNames(events: RawCalendarEvent[]): string[] {
  return [...new Set(events.map((e) => e.className || "").filter((c) => !Object.prototype.hasOwnProperty.call(CLASS_NAME_MAP, c)))].sort();
}
