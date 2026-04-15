import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── iCal parser ──────────────────────────────────────────────
function parseIcal(ical: string) {
  const events: Array<{
    uid: string;
    title: string;
    description: string;
    location: string;
    startAt: string;
    endAt: string | null;
    allDay: boolean;
  }> = [];

  const blocks = ical.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split("END:VEVENT")[0];
    const get = (key: string): string => {
      const match = block.match(new RegExp(`^${key}[^:]*:(.*)$`, "m"));
      return match ? match[1].trim().replace(/\\n/g, "\n").replace(/\\,/g, ",") : "";
    };

    const dtstart = get("DTSTART");
    const dtend = get("DTEND");
    const allDay = dtstart.length === 8;

    const parseDate = (d: string): string => {
      if (!d) return new Date().toISOString();
      if (d.length === 8) {
        return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`;
      }
      const clean = d.replace(/Z$/, "");
      return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`;
    };

    events.push({
      uid: get("UID") || `generated-${i}-${Date.now()}`,
      title: get("SUMMARY"),
      description: get("DESCRIPTION"),
      location: get("LOCATION"),
      startAt: parseDate(dtstart),
      endAt: dtend ? parseDate(dtend) : null,
      allDay,
    });
  }
  return events;
}

// ── FullCalendar JS array extractor ──────────────────────────

// Explicit className → year_group mapping from the Dean Valley site
const CLASS_NAME_MAP: Record<string, string | null> = {
  "": "all",
  "custom0": "Reception",
  "custom": "Year 1",
  "custom2": "Year 2",
  "custom3": "Year 3",
  "custom4": "Year 4",
  "custom5": "Year 5",
  "custom6": "Year 6",
  "customstaff": null, // skip staff events
  "multi_3_4": "Year 3,Year 4",
  "multi_5_6": "Year 5,Year 6",
  "multi_3_4_5": "Year 3,Year 4,Year 5",
  "multi_4_5_6": "Year 4,Year 5,Year 6",
  "multi_3_4_5_6": "Year 3,Year 4,Year 5,Year 6",
  "multi_0__2": "Reception,Year 1,Year 2",
  "multi__2": "Year 1,Year 2",
  "multi__2_3_4_5_6": "Year 1,Year 2,Year 3,Year 4,Year 5,Year 6",
  "multi_4_5_3": "Year 3,Year 4,Year 5",
  "multi_4_5": "Year 4,Year 5",
  "multi_6_5": "Year 5,Year 6",
  "multi_2_3": "Year 2,Year 3",
  "multi_2_3_4": "Year 2,Year 3,Year 4",
  "multi_3_4_5_6_2": "Year 2,Year 3,Year 4,Year 5,Year 6",
  "multi_5_6_2": "Year 2,Year 5,Year 6",
  "multi_0_6": "Reception,Year 6",
  "multi_0_2_": "Reception,Year 1,Year 2",
  "multi_0__2_4_5_6": "Reception,Year 1,Year 2,Year 4,Year 5,Year 6",
  "multi_0__2_3": "Reception,Year 1,Year 2,Year 3",
  "multi_0_3_2": "Reception,Year 2,Year 3",
  "multi_0_staff": null, // skip staff events
};

interface FullCalEvent {
  uid: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  yearGroup: string;
}

function parseFullCalendarHtml(html: string): FullCalEvent[] {
  // Find the NON-empty events array — the page has an empty one first, then the real data
  const matches = [...html.matchAll(/events\s*:\s*(\[[\s\S]*?\])\s*[,}]/g)];
  let arrStr = "";
  for (const m of matches) {
    if (m[1].trim() !== "[]") {
      arrStr = m[1];
      break;
    }
  }
  if (!arrStr) {
    console.error("Could not find non-empty fullCalendar events array in HTML");
    return [];
  }

  let eventsRaw: any[];
  try {
    eventsRaw = JSON.parse(arrStr);
  } catch (e) {
    console.error("Failed to parse fullCalendar events JSON:", e);
    return [];
  }

  console.log(`Extracted ${eventsRaw.length} raw events from fullCalendar JS`);

  const results: FullCalEvent[] = [];
  for (let i = 0; i < eventsRaw.length; i++) {
    const e = eventsRaw[i];
    const cls = e.className || "";
    const mapped = CLASS_NAME_MAP.hasOwnProperty(cls) ? CLASS_NAME_MAP[cls] : "all";

    // null means skip (staff events)
    if (mapped === null) continue;

    const hasTime = e.start?.includes(" ") && !e.start?.endsWith("00:00:00");

    results.push({
      uid: `fullcal-${i}-${e.start || Date.now()}`,
      title: e.title || "Untitled",
      description: "",
      location: "",
      startAt: e.start ? new Date(e.start.replace(" ", "T") + "Z").toISOString() : new Date().toISOString(),
      endAt: e.end ? new Date(e.end.replace(" ", "T") + "Z").toISOString() : null,
      allDay: !hasTime,
      yearGroup: mapped,
    });
  }

  console.log(`After filtering staff events: ${results.length} events`);
  return results;
}

// ── HTML scraper + AI extraction ─────────────────────────────
async function scrapeAndExtract(url: string): Promise<Array<{
  uid: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
}>> {
  console.log(`Fetching HTML from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  let html = await res.text();

  // Trim to reduce token usage — keep only the <body> or first 30k chars
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) html = bodyMatch[1];
  if (html.length > 30000) html = html.slice(0, 30000);

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

  const currentYear = new Date().getFullYear();

  const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content: `You are an expert at extracting school calendar events from HTML. The current year is ${currentYear}. Extract ALL events you can find. For each event return title, date (ISO 8601), end_date (ISO 8601 or null), location (or empty string), description (or empty string), and all_day (boolean). If only a date with no time is given, set all_day to true and use T00:00:00Z. If a year is not specified, assume ${currentYear} for future months and ${currentYear + 1} if the month has already passed.`,
        },
        {
          role: "user",
          content: `Extract school events from this HTML:\n\n${html}`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "extract_events",
            description: "Return extracted school calendar events",
            parameters: {
              type: "object",
              properties: {
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      date: { type: "string", description: "ISO 8601 start date" },
                      end_date: { type: "string", description: "ISO 8601 end date or null" },
                      location: { type: "string" },
                      description: { type: "string" },
                      all_day: { type: "boolean" },
                    },
                    required: ["title", "date", "all_day"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["events"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "extract_events" } },
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error("AI gateway error:", aiRes.status, errText);
    throw new Error(`AI extraction failed: ${aiRes.status}`);
  }

  const aiData = await aiRes.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    console.error("No tool call in AI response:", JSON.stringify(aiData));
    throw new Error("AI did not return structured events");
  }

  const parsed = JSON.parse(toolCall.function.arguments);
  const extracted = parsed.events || [];
  console.log(`AI extracted ${extracted.length} events`);

  return extracted.map((e: any, i: number) => ({
    uid: `scraped-${i}-${Date.now()}`,
    title: e.title || "Untitled",
    description: e.description || "",
    location: e.location || "",
    startAt: e.date,
    endAt: e.end_date || null,
    allDay: e.all_day ?? true,
  }));
}

// ── Main handler ─────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { data: feeds, error: feedErr } = await supabase
      .from("school_calendar_feeds")
      .select("*");

    if (feedErr) throw feedErr;
    if (!feeds || feeds.length === 0) {
      return new Response(
        JSON.stringify({ message: "No calendar feeds configured" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalSynced = 0;

    for (const feed of feeds) {
      try {
        console.log(`Syncing feed: ${feed.label} (${feed.feed_url}) [${feed.feed_type}]`);

        let events: Array<{
          uid: string;
          title: string;
          description: string;
          location: string;
          startAt: string;
          endAt: string | null;
          allDay: boolean;
          yearGroup?: string;
        }>;

        if (feed.feed_type === "fullcalendar") {
          const res = await fetch(feed.feed_url);
          if (!res.ok) {
            console.error(`Failed to fetch feed ${feed.id}: ${res.status}`);
            continue;
          }
          const html = await res.text();
          events = parseFullCalendarHtml(html);
        } else if (feed.feed_type === "scrape") {
          events = await scrapeAndExtract(feed.feed_url);
        } else {
          // Default: iCal
          const res = await fetch(feed.feed_url);
          if (!res.ok) {
            console.error(`Failed to fetch feed ${feed.id}: ${res.status}`);
            continue;
          }
          const icalText = await res.text();
          events = parseIcal(icalText);
        }

        console.log(`Parsed ${events.length} events from feed ${feed.id}`);

        // Delete existing events for this feed and re-insert
        await supabase
          .from("school_events")
          .delete()
          .eq("feed_id", feed.id);

        if (events.length > 0) {
          const rows = events.map((e) => ({
            school_id: feed.school_id,
            feed_id: feed.id,
            title: e.title,
            description: e.description || null,
            location: e.location || null,
            start_at: e.startAt,
            end_at: e.endAt,
            all_day: e.allDay,
            uid: e.uid,
            year_group: e.yearGroup || "all",
          }));

          const { error: insertErr } = await supabase
            .from("school_events")
            .insert(rows);

          if (insertErr) {
            console.error(`Insert error for feed ${feed.id}:`, insertErr);
          } else {
            totalSynced += events.length;
          }
        }

        // Update last synced timestamp
        await supabase
          .from("school_calendar_feeds")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", feed.id);
      } catch (err) {
        console.error(`Error processing feed ${feed.id}:`, err);
      }
    }

    return new Response(
      JSON.stringify({ message: `Synced ${totalSynced} events from ${feeds.length} feeds` }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
