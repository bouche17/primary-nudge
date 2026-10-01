// Shared safety module for the Monty test suite.
// - Test phone numbers can NEVER receive a real WhatsApp message.
// - Test entry points require MONTY_TEST_SECRET (constant-time compare) and are audited.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Hard rule independent of the database: the reserved fake range is always test.
const HARD_TEST_RANGE = /^\+4470000000\d\d$/;

let cache: { at: number; set: Set<string> } | null = null;
let client: SupabaseClient | null = null;
function svc(): SupabaseClient {
  if (!client) client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return client;
}

export async function getTestPhones(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.set;
  const { data, error } = await svc().from("test_phone_numbers").select("phone_number");
  if (error) console.error("[testGuard] allowlist load failed:", error.message);
  const set = new Set<string>((data ?? []).map((r: any) => r.phone_number));
  cache = { at: Date.now(), set };
  return set;
}

export async function isTestPhone(phone: string | null | undefined): Promise<boolean> {
  if (!phone) return false;
  const p = phone.replace(/^whatsapp:/, "");
  if (HARD_TEST_RANGE.test(p)) return true;
  return (await getTestPhones()).has(p);
}

/** Call at the top of every Twilio send. Returns true if the send must be skipped. */
export async function blockIfTestPhone(to: string, source: string): Promise<boolean> {
  if (await isTestPhone(to)) {
    console.log(`[testGuard] ${source}: blocked real send to test number …${to.slice(-4)}`);
    return true;
  }
  return false;
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time comparison of the provided secret against MONTY_TEST_SECRET. */
export async function validTestSecret(provided: string | null): Promise<boolean> {
  const expected = Deno.env.get("MONTY_TEST_SECRET");
  if (!expected || !provided) return false;
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function auditTestEntry(e: {
  entry_point: string; phone_number?: string | null; scenario?: string | null; allowed: boolean; reason?: string;
}) {
  try {
    await svc().from("test_entry_audit").insert({
      entry_point: e.entry_point, phone_number: e.phone_number ?? null,
      scenario: e.scenario ?? null, allowed: e.allowed, reason: e.reason ?? null,
    });
  } catch (err) {
    console.error("[testGuard] audit failed:", err);
  }
}
