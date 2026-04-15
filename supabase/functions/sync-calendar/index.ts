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
function parseFullCalendarHtml(html: string): Array<{
  uid: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  yearGroup: string | null;
}> {
  // Extract the events array from fullCalendar({events:[...]})
  const match = html.match(/\.fullCalendar\(\s*\{[\s\S]*?events\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
  if (!match) {
    console.error("Could not find fullCalendar events array in HTML");
    return [];
  }

  let eventsRaw: any[];
  try {
    // The JS array may use single quotes or unquoted keys — normalise to valid JSON
    let arrStr = match[1];
    // Replace single quotes with double quotes
    arrStr = arrStr.replace(/'/g, '"');
    // Quote unquoted keys: word before colon
    arrStr = arrStr.replace(/(\{|,)\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
    eventsRaw = JSON.parse(arrStr);
  } catch (e) {
    console.error("Failed to parse fullCalendar events JSON:", e);
    return [];
  }

  console.log(`Extracted ${eventsRaw.length} events from fullCalendar JS`);

  return eventsRaw.map((e: any, i: number) => {
    // Map className to year group
    let yearGroup: string | null = null;
    const cls = e.className || "";
    if (cls) {
      // multi_3_4 → "Year 3, Year 4"
      const multiMatch = cls.match(/multi_(\d+(?:_\d+)*)/);
      if (multiMatch) {
        yearGroup = multiMatch[1].split("_").map((y: string) => `Year ${y}`).join(", ");
      } else {
        // custom5 → "Year 5"
        const singleMatch = cls.match(/custom(\d+)/);
        if (singleMatch) {
          yearGroup = `Year ${singleMatch[1]}`;
        }
      }
      // No className match = whole school (yearGroup stays null)
    }

    const allDay = !e.start?.includes("T");

    return {
      uid: `fullcal-${i}-${e.start || Date.now()}`,
      title: e.title || "Untitled",
      description: yearGroup ? `${yearGroup}` : "",
      location: "",
      startAt: e.start ? new Date(e.start).toISOString() : new Date().toISOString(),
      endAt: e.end ? new Date(e.end).toISOString() : null,
      allDay,
      yearGroup,
    };
  });
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
        }>;

        if (feed.feed_type === "scrape") {
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
