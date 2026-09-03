import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_WHATSAPP_NUMBER = Deno.env.get("TWILIO_WHATSAPP_NUMBER")!;
const TWILIO_SCHOOL_NOTIFICATION_SID = Deno.env.get("TWILIO_SCHOOL_NOTIFICATION_SID") || "HX63040a55daeb8ef0673b8a1a156ad9a9";

const TEST_PHONE_NUMBER = Deno.env.get("TEST_PHONE_NUMBER") || "+447801442732";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function extractEmailInfo(subject: string, body: string): Promise<{
  summary: string;
  yearGroups: string[];
  dates: string[];
  actionRequired: string | null;
  links: string[];
}> {
  const prompt = `You are processing a school email from Dean Valley Community Primary School sent via Arbor.

Extract the key information from this email and return ONLY a JSON object with no preamble or markdown.

Email subject: ${subject}

Email body:
${body}

Return this exact JSON structure:
{
  "summary": "A concise summary of what this email is about",
  "yearGroups": ["list of year groups mentioned, e.g. Year 1, Year 2, or all if whole school"],
  "dates": ["list of dates mentioned in YYYY-MM-DD format"],
  "actionRequired": "what parents need to do, or null if no action needed",
  "links": ["every URL mentioned in the email body, preserved exactly as written"]
}

Distinguish two email types when writing the summary and actionRequired:
(a) Deadline-driven / mandatory-action emails (e.g. payment deadlines, forms everyone must complete, final consent dates). Keep the summary tight and direct, and make actionRequired clear and compulsory-sounding.
(b) Informational / awareness emails (e.g. club or tournament announcements, general updates, optional activities, no universal mandatory deadline). Write a fuller summary of up to 3-4 sentences that preserves actual details and any per-year-group nuance (e.g. different cohorts joining at different times, selection being performance-based). For this type, only set actionRequired if there is a specific, universal action every relevant parent must take. If the "action" is really an optional or self-selecting invitation (like volunteering for a role, signing up to a club only if interested), describe it inside the summary instead of actionRequired so it does not read as mandatory.

Extract every URL mentioned in the email body (e.g. Google Forms, Microsoft Forms, payment portals, sign-up links) and preserve each link exactly as written, never summarised, shortened, or omitted. Put them in the links array.

For yearGroups, use these exact values: "Reception", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6", or "all" for whole school.

Many school emails combine a universal requirement (applies to every child, no exceptions — phrases like "all children", "all pupils", "whether they...", or a deadline/action that doesn't exclude any year group) with year-specific extras (like optional clubs only open to certain years). When this happens, yearGroups should be set to ["all"] — since the universal requirement means every family needs to see the message, even if some content like a specific club doesn't apply to them. Only use specific year groups (not "all") when the ENTIRE email is restricted to those years with no whole-school component at all.
Today's date is ${new Date().toISOString().split("T")[0]}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content[0].text.trim();
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  return JSON.parse(clean);
}

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const sanitisedText = text
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
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

  const responseBody = await res.text();
  console.log("Twilio status:", res.status, responseBody);
  if (!res.ok) {
    try {
      await supabase.from("message_send_failures").insert({
        function_name: "handle-school-email",
        phone_number: to,
        period: null,
        status_code: res.status,
        error_body: responseBody,
        context: `Template SID: ${TWILIO_SCHOOL_NOTIFICATION_SID}`,
      });
    } catch (logError) {
      console.error("Failed to log message send failure:", logError);
    }
  }
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { from, subject, rawEmail, test } = await req.json();
    const testMode = test === true;

    if (testMode) {
      console.log(`[handle-school-email] TEST MODE active — only ${TEST_PHONE_NUMBER} will receive messages`);
    }

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
    let { data: profiles } = await supabase
      .from("profiles")
      .select("user_id, phone_number")
      .in("user_id", parentIds)
      .not("phone_number", "is", null);

    if (testMode && profiles) {
      const beforeCount = profiles.length;
      profiles = profiles.filter((p: any) => p.phone_number === TEST_PHONE_NUMBER);
      console.log(`[handle-school-email] Test mode: filtered ${beforeCount} profiles down to ${profiles.length} test recipient(s)`);
    }

    if (!profiles || profiles.length === 0) {
      return new Response(JSON.stringify({ message: "No parent phone numbers found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build the message
    let message = extracted.summary;
    if (extracted.actionRequired) {
      message += " — Action needed: " + extracted.actionRequired;
    }
    if (extracted.links && extracted.links.length > 0) {
      message += " " + extracted.links.join(" ");
    }

    // Send to all relevant parents
    let sentCount = 0;
    for (const profile of profiles) {
      if (!profile.phone_number) continue;
      const ok = await sendWhatsApp(profile.phone_number, message);
      if (ok) sentCount++;
    }

    console.log(`Sent to ${sentCount} parents for year groups: ${extracted.yearGroups.join(", ")}`);

    return new Response(JSON.stringify({ success: true, sent: sentCount, extracted, test_mode: testMode }), {
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
