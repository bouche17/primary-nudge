// newsletter-checker/index.ts
// Runs every Monday at 8am UTC (9am BST)
// Checks the Dean Valley newsletters page for a new edition
// If found, messages all parents with a link
// pg_cron: 0 8 * * 1

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;

const NEWSLETTERS_PAGE = "https://www.deanvalley.cheshire.sch.uk/page/newsletters/133398";
const SCHOOL_ID = "c0517733-e4a6-45f4-9fd1-9056aba084e6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── WhatsApp sender ───────────────────────────────────────────────────────────

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("Body", text);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );

  if (!res.ok) console.error("Twilio error:", await res.text());
  return res.ok;
}

// ── Newsletter scraper ────────────────────────────────────────────────────────
// Fetches the Dean Valley newsletters page and extracts the latest edition
// Returns { title, url, date } or null if unable to parse

interface Newsletter {
  title: string;
  url: string;
  dateStr: string; // e.g. "9th March 2026"
}

async function fetchLatestNewsletter(): Promise<Newsletter | null> {
  try {
    const res = await fetch(NEWSLETTERS_PAGE, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      }
    });
    if (!res.ok) {
      console.error("Failed to fetch newsletters page:", res.status);
      return null;
    }

    const html = await res.text();

    // The newsletters page lists editions as:
    // <date text>
    // <a href="https://sway.cloud.microsoft/...">Dean Valley Times DD.MM.YY</a>
    // We extract the first (most recent) Sway link and the date text above it

    // Match all Sway links with their anchor text
    const linkPattern = /href="(https:\/\/sway\.cloud\.microsoft\/[^"]+)"[^>]*>([^<]+Dean Valley Times[^<]*)<\/a>/gi;
    const matches = [...html.matchAll(linkPattern)];

    if (matches.length === 0) {
      console.log("No newsletter links found on page");
      return null;
    }

    // First match is the most recent
    const [, url, title] = matches[0];

    // Extract the date text that appears just before the link
    // Look for a date pattern like "9th March 2026" or "12th February 2026"
    const datePattern = /(\d{1,2}(?:st|nd|rd|th)\s+\w+\s+\d{4})\s*\n?\s*<[^>]*href="[^"]*sway[^"]*"/i;
    const dateMatch = html.match(datePattern);
    const dateStr = dateMatch ? dateMatch[1] : title;

    return {
      title: title.trim(),
      url: url.trim(),
      dateStr: dateStr.trim(),
    };
  } catch (err) {
    console.error("Error fetching newsletter:", err);
    return null;
  }
}

// ── Already notified check ────────────────────────────────────────────────────
// We store the last notified newsletter URL in a simple key-value style
// using the school_calendar_feeds table's notes field, or a dedicated check

async function getLastNotifiedUrl(): Promise<string | null> {
  const { data } = await supabase
    .from("newsletter_log")
    .select("newsletter_url")
    .eq("school_id", SCHOOL_ID)
    .order("notified_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.newsletter_url ?? null;
}

async function logNotification(url: string, title: string): Promise<void> {
  await supabase.from("newsletter_log").insert({
    school_id: SCHOOL_ID,
    newsletter_url: url,
    newsletter_title: title,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. Fetch latest newsletter
    const latest = await fetchLatestNewsletter();
    if (!latest) {
      return new Response(
        JSON.stringify({ message: "Could not fetch newsletter" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Latest newsletter found:", latest.title, latest.url);

    // 2. Check if we've already notified about this one
    const lastUrl = await getLastNotifiedUrl();
    if (lastUrl === latest.url) {
      console.log("Already notified about this newsletter — skipping");
      return new Response(
        JSON.stringify({ message: "No new newsletter", latest: latest.title }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. New newsletter found — get all parents at this school
    const { data: children } = await supabase
      .from("children")
      .select("parent_id")
      .eq("school_id", SCHOOL_ID);

    if (!children || children.length === 0) {
      return new Response(
        JSON.stringify({ message: "No parents found for this school" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get unique parent IDs
    const parentIds = [...new Set(children.map((c: any) => c.parent_id))];

    // Get their phone numbers
    const { data: profiles } = await supabase
      .from("profiles")
      .select("phone_number")
      .in("user_id", parentIds)
      .not("phone_number", "is", null);

    if (!profiles || profiles.length === 0) {
      return new Response(
        JSON.stringify({ message: "No phone numbers found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Build and send the message
    const message = buildNewsletterMessage(latest);
    let sentCount = 0;

    // Deduplicate phone numbers
    const phones = [...new Set(profiles.map((p: any) => p.phone_number))];

    for (const phone of phones) {
      const ok = await sendWhatsApp(phone, message);
      if (ok) sentCount++;
    }

    // 5. Log so we don't send again
    await logNotification(latest.url, latest.title);

    console.log(`Sent newsletter notification to ${sentCount} parents`);

    return new Response(
      JSON.stringify({
        success: true,
        newsletter: latest.title,
        sent: sentCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("newsletter-checker error:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function buildNewsletterMessage(newsletter: Newsletter): string {
  return `📰 The Dean Valley Times is out!\n\nThis week's newsletter (${newsletter.dateStr}) is ready to read:\n${newsletter.url}\n\nHave a great week! 😊`;
}
