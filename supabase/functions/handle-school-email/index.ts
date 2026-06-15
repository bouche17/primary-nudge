import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_SCHOOL_NOTIFICATION_SID = Deno.env.get("TWILIO_SCHOOL_NOTIFICATION_SID") || "HX7b29b6d8809d72e83b03decb7590b281";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function extractEmailInfo(subject: string, body: string): Promise<{
  summary: string;
  yearGroups: string[];
  dates: string[];
  actionRequired: string | null;
}> {
  const prompt = `You are processing a school email from Dean Valley Community Primary School sent via Arbor.

Extract the key information from this email and return ONLY a JSON object with no preamble or markdown.

Email subject: ${subject}

Email body:
${body}

Return this exact JSON structure:
{
  "summary": "A concise one or two sentence summary of what this email is about",
  "yearGroups": ["list of year groups mentioned, e.g. Year 1, Year 2, or all if whole school"],
  "dates": ["list of dates mentioned in YYYY-MM-DD format"],
  "actionRequired": "what parents need to do, or null if no action needed"
}

For yearGroups, use these exact values: "Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6", or "all" for whole school.
Today's date is ${new Date().toISOString().split("T")[0]}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content[0].text.trim();
  return JSON.parse(text);
}

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const sanitisedText = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[^\S\n\r]+/g, " ")
    .replace(/\n/g, "\u2028")
    .trim()
    .slice(0, 1024);

  const contentVariables = JSON.stringify({ "1": sanitisedText });

  const params = new URLSearchParams();
  params.append("To", `whatsapp:${to}`);
  params.append("From", `whatsapp:${TWILIO_WHATSAPP_NUMBER}`);
  params.append("ContentSid", TWILIO_SCHOOL_NOTIFICATION_SID);
  params.append("ContentVariables", contentVariables);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  console.log("Twilio status:", res.status, await res.text());
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { from, subject, rawEmail } = await req.json();

    console.log(`Received email from ${from}, subject: ${subject}`);

    // Extract info using Claude
    const extracted = await extractEmailInfo(subject, rawEmail);
    console.log("Extracted:", JSON.stringify(extracted));

    // Find relevant parents based on year groups
    let query = supabase
      .from("children")
      .select("parent_id, year_group, first_name");

    const { data: children } = await query;

    if (!children || children.length === 0) {
      return new Response(JSON.stringify({ message: "No children found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Filter children by year group
    const isWholeSchool = extracted.yearGroups.includes("all");
    const relevantChildren = isWholeSchool
      ? children
      : children.filter((c: any) =>
          extracted.yearGroups.some(
            (yg) => yg.toLowerCase() === (c.year_group || "").toLowerCase()
          )
        );

    // Get unique parent IDs
    const parentIds = [...new Set(relevantChildren.map((c: any) => c.parent_id))];

    // Get phone numbers for these parents
    const { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, phone_number")
      .in("user_id", parentIds)
      .not("phone_number", "is", null);

    if (!profiles || profiles.length === 0) {
      return new Response(JSON.stringify({ message: "No parent phone numbers found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build the message
    let message = extracted.summary;
    if (extracted.actionRequired) {
      message += `\u2028\u2028Action needed: ${extracted.actionRequired}`;
    }

    // Send to all relevant parents
    let sentCount = 0;
    for (const profile of profiles) {
      if (!profile.phone_number) continue;
      const ok = await sendWhatsApp(profile.phone_number, message);
      if (ok) sentCount++;
    }

    console.log(`Sent to ${sentCount} parents for year groups: ${extracted.yearGroups.join(", ")}`);

    return new Response(JSON.stringify({ success: true, sent: sentCount, extracted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("handle-school-email error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
