// twilio-status-callback/index.ts
// Receives Twilio message status webhooks so we can capture ASYNC delivery
// failures (e.g. accepted then undelivered because of the 24h window).
// Twilio expects a 200 for every request, otherwise it retries aggressively.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_STATUS_CALLBACK_URL = Deno.env.get("TWILIO_STATUS_CALLBACK_URL") || "";

async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const computed = encodeBase64(new Uint8Array(sig));

  return computed === signature;
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const source = url.searchParams.get("source") || "unknown";

    const bodyText = await req.text();
    const form = new URLSearchParams(bodyText);
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) params[k] = v;

    const signature = req.headers.get("x-twilio-signature") || "";
    const callbackUrl = TWILIO_STATUS_CALLBACK_URL
      ? `${TWILIO_STATUS_CALLBACK_URL}${TWILIO_STATUS_CALLBACK_URL.includes("?") ? "&" : "?"}source=${source}`
      : req.url;

    const isValid = await validateTwilioSignature(
      TWILIO_AUTH_TOKEN,
      signature,
      callbackUrl,
      params
    );

    if (!isValid) {
      console.error("[twilio-status-callback] Invalid Twilio signature — ignoring payload");
      return new Response("OK", { status: 200 });
    }

    const messageSid = params["MessageSid"] || "";
    const messageStatus = params["MessageStatus"] || "";
    const to = (params["To"] || "").replace(/^whatsapp:/, "");
    const errorCode = params["ErrorCode"] || null;
    const errorMessage = params["ErrorMessage"] || null;

    console.log(
      `[twilio-status-callback] source=${source} sid=${messageSid} status=${messageStatus} to=${to} errorCode=${errorCode}`
    );

    if (messageStatus === "failed" || messageStatus === "undelivered") {
      try {
        await supabase.from("message_send_failures").insert({
          function_name: source,
          phone_number: to,
          period: null,
          status_code: null,
          error_body: JSON.stringify({
            MessageStatus: messageStatus,
            ErrorCode: errorCode,
            ErrorMessage: errorMessage,
          }),
          context: `Async delivery failure (Twilio status callback), MessageSid: ${messageSid}`,
        });
      } catch (logError) {
        console.error("[twilio-status-callback] Failed to log delivery failure:", logError);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[twilio-status-callback] error:", error);
    return new Response("OK", { status: 200 });
  }
});
