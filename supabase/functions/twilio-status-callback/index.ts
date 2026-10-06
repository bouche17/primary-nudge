// twilio-status-callback/index.ts
// Receives Twilio message status webhooks (called anonymously by Twilio — verify_jwt = false).
// Every request must carry a valid X-Twilio-Signature (HMAC-SHA1 with TWILIO_AUTH_TOKEN over the
// full public URL incl. ?source=… plus sorted form params); anything else gets 403.
// Records every status, logs failed/undelivered to message_send_failures and alerts Matt on bursts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { evaluateDeliveryAlerts } from "../_shared/alerts.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const PUBLIC_BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1/twilio-status-callback`;
const CONFIGURED_URL = Deno.env.get("TWILIO_STATUS_CALLBACK_URL") || "";

async function signatureFor(url: string, params: Record<string, string>): Promise<string> {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TWILIO_AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return encodeBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const KNOWN = new Set(["queued", "accepted", "sending", "sent", "delivered", "read", "failed", "undelivered", "receiving", "received", "scheduled", "canceled"]);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const query = url.search; // the exact ?source=… Twilio was given
  const source = url.searchParams.get("source") || "unknown";
  const bodyText = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(bodyText).entries()) params[k] = v;

  const signature = req.headers.get("x-twilio-signature") || "";
  // Public URL Twilio signed: our functions URL + the original query string (or the configured base, if set).
  const candidates = [`${PUBLIC_BASE}${query}`];
  if (CONFIGURED_URL) candidates.push(`${CONFIGURED_URL.split("?")[0]}${query}`);
  let valid = false;
  if (signature) for (const c of candidates) if (safeEqual(await signatureFor(c, params), signature)) { valid = true; break; }
  if (!valid) {
    console.warn(`[twilio-status-callback] rejected ${signature ? "invalid" : "unsigned"} request (source=${source})`);
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const messageSid = params["MessageSid"] || params["SmsSid"] || "";
    const status = (params["MessageStatus"] || params["SmsStatus"] || "").toLowerCase();
    const to = (params["To"] || "").replace(/^whatsapp:/, "");
    const errorCode = params["ErrorCode"] || null;
    const errorMessage = params["ErrorMessage"] || null;
    console.log(`[twilio-status-callback] source=${source} sid=${messageSid} status=${status} to=…${to.slice(-4)} errorCode=${errorCode}`);

    if (messageSid && KNOWN.has(status)) {
      await supabase.from("message_delivery_status").insert({
        message_sid: messageSid, status, phone_number: to || null, source, error_code: errorCode, error_message: errorMessage,
      });
    }
    if (status === "failed" || status === "undelivered") {
      await supabase.from("message_send_failures").insert({
        function_name: source, phone_number: to, period: null, status_code: null,
        error_body: JSON.stringify({ MessageStatus: status, ErrorCode: errorCode, ErrorMessage: errorMessage }),
        context: `Async delivery failure (Twilio status callback), MessageSid: ${messageSid}`,
      });
      try { await evaluateDeliveryAlerts(); } catch (e) { console.error("[twilio-status-callback] alert check failed:", e); }
    }
  } catch (error) {
    console.error("[twilio-status-callback] error:", error);
  }
  return new Response("OK", { status: 200 });
});
