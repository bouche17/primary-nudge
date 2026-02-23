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

// Minimal iCal parser — extracts VEVENT blocks
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
    const allDay = dtstart.length === 8; // YYYYMMDD = all-day

    const parseDate = (d: string): string => {
      if (!d) return new Date().toISOString();
      if (d.length === 8) {
        return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`;
      }
      // 20260306T100000Z or 20260306T100000
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Fetch all calendar feeds
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
        console.log(`Syncing feed: ${feed.label} (${feed.feed_url})`);
        const res = await fetch(feed.feed_url);
        if (!res.ok) {
          console.error(`Failed to fetch feed ${feed.id}: ${res.status}`);
          continue;
        }

        const icalText = await res.text();
        const events = parseIcal(icalText);
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
