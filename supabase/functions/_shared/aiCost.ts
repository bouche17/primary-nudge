// Records the estimated cost of every Anthropic call in ai_costs. Never throws.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isTestPhone } from "./testGuard.ts";

let client: SupabaseClient | null = null;
const svc = () => client ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// USD per million tokens (input, output). Sonnet list price is the default estimate.
const PRICES: [RegExp, number, number][] = [[/opus/i, 15, 75], [/haiku/i, 1, 5], [/.*/, 3, 15]];
export function estimateCostUsd(model: string, input: number, output: number): number {
  const [, i, o] = PRICES.find(([re]) => re.test(model))!;
  return (input * i + output * o) / 1e6;
}

/** Family id = the primary account of a linked family, else the parent's own user id. */
async function familyIdForPhone(phone: string): Promise<string | null> {
  const p = phone.replace(/^whatsapp:/, "");
  const { data: prof } = await svc().from("profiles").select("user_id").eq("phone_number", p).maybeSingle();
  if (!prof) return null;
  const { data: link } = await svc().from("linked_accounts").select("primary_user_id").eq("linked_user_id", prof.user_id).eq("status", "accepted").maybeSingle();
  return link?.primary_user_id ?? prof.user_id;
}

export async function recordAiCost(e: {
  functionName: string; purpose: string; model: string; usage?: { input_tokens?: number; output_tokens?: number } | null;
  phone?: string | null; familyId?: string | null; schoolId?: string | null; isTest?: boolean;
}) {
  try {
    const input = e.usage?.input_tokens ?? 0, output = e.usage?.output_tokens ?? 0;
    const isTest = e.isTest === true || (e.phone ? await isTestPhone(e.phone) : false);
    const familyId = e.familyId ?? (e.phone ? await familyIdForPhone(e.phone) : null);
    await svc().from("ai_costs").insert({
      function_name: e.functionName, purpose: isTest ? "test" : e.purpose, family_id: familyId, school_id: e.schoolId ?? null,
      model: e.model, input_tokens: input, output_tokens: output, cost_usd: estimateCostUsd(e.model, input, output), is_test: isTest,
    });
  } catch (err) { console.error("[aiCost] record failed:", err); }
}
