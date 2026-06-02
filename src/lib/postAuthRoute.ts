import { supabase } from "@/integrations/supabase/client";

/**
 * Determine where a freshly authenticated user should land.
 * Existing users (profile with phone, accepted invite link, or any children)
 * go straight to /dashboard. Otherwise they enter /onboarding.
 */
export async function resolvePostAuthRoute(userId: string): Promise<"/dashboard" | "/onboarding"> {
  const [{ data: links }, { data: children }] = await Promise.all([
    supabase
      .from("linked_accounts")
      .select("id")
      .eq("linked_user_id", userId)
      .eq("status", "accepted")
      .limit(1),
    supabase.from("children").select("id").eq("parent_id", userId).limit(1),
  ]);

  if (links && links.length > 0) return "/dashboard";
  if (children && children.length > 0) return "/dashboard";
  return "/onboarding";
}

