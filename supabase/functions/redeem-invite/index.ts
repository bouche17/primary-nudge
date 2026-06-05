import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Validate the calling user
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: "Unauthorized" }, 401);
    }
    const userId = userData.user.id;

    const { token } = await req.json().catch(() => ({}));
    if (!token || typeof token !== "string") {
      return json({ error: "Invalid token" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: invite, error: lookupErr } = await admin
      .from("invite_tokens")
      .select("inviter_user_id, used_at, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (lookupErr) {
      console.error("redeem-invite lookup error:", lookupErr);
      return json({ error: "Internal server error" }, 500);
    }
    if (!invite) return json({ status: "invalid" }, 404);
    if (invite.used_at) return json({ status: "used" }, 410);
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return json({ status: "expired" }, 410);
    }
    if (invite.inviter_user_id === userId) {
      return json({ status: "self" }, 400);
    }

    const { data: existing } = await admin
      .from("linked_accounts")
      .select("id")
      .eq("primary_user_id", invite.inviter_user_id)
      .eq("linked_user_id", userId)
      .maybeSingle();

    if (!existing) {
      const { error: linkErr } = await admin.from("linked_accounts").insert({
        primary_user_id: invite.inviter_user_id,
        linked_user_id: userId,
        status: "accepted",
        accepted_at: new Date().toISOString(),
      });
      if (linkErr) {
        console.error("redeem-invite link insert error:", linkErr);
        return json({ error: "Internal server error" }, 500);
      }
    }

    const { error: updateErr } = await admin
      .from("invite_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token", token);
    if (updateErr) {
      console.error("redeem-invite token update error:", updateErr);
    }

    return json({ status: "linked", already: !!existing });
  } catch (error) {
    console.error("redeem-invite error:", error);
    return json({ error: "Internal server error" }, 500);
  }
});
