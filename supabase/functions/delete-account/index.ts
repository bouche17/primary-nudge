import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ success: false, error: "Missing authorization" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData?.user) {
      console.error("delete-account: failed to verify caller JWT", userError?.message);
      return json({ success: false, error: "Invalid or expired session" }, 401);
    }

    // Only ever the authenticated caller's own account.
    const callerId = userData.user.id;
    const steps: string[] = [];

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("phone_number")
      .eq("user_id", callerId)
      .maybeSingle();

    if (profileError) {
      console.error("delete-account: step=lookup_profile failed", profileError.message);
      return json({ success: false, error: "Could not load your profile", step: "lookup_profile" }, 500);
    }

    const phone = profile?.phone_number ?? null;

    const runStep = async (step: string, fn: () => Promise<{ error: unknown }>) => {
      const { error } = await fn();
      if (error) {
        const message = (error as { message?: string })?.message ?? String(error);
        console.error(`delete-account: step=${step} failed`, message);
        throw new Error(`${step}: ${message}`);
      }
      steps.push(step);
    };

    try {
      if (phone) {
        await runStep("delete_parent_notes", () =>
          admin.from("parent_notes").delete().eq("phone_number", phone)
        );
        await runStep("delete_reminder_log", () =>
          admin.from("reminder_log").delete().eq("phone_number", phone)
        );
        await runStep("delete_message_send_failures", () =>
          admin.from("message_send_failures").delete().eq("phone_number", phone)
        );

        const { data: conversations, error: convError } = await admin
          .from("conversations")
          .select("id")
          .eq("phone_number", phone);
        if (convError) {
          console.error("delete-account: step=lookup_conversations failed", convError.message);
          throw new Error(`lookup_conversations: ${convError.message}`);
        }
        const conversationIds = (conversations ?? []).map((c) => c.id);
        if (conversationIds.length > 0) {
          await runStep("delete_messages", () =>
            admin.from("messages").delete().in("conversation_id", conversationIds)
          );
        }
        await runStep("delete_conversations", () =>
          admin.from("conversations").delete().eq("phone_number", phone)
        );
        await runStep("delete_onboarding_state", () =>
          admin.from("onboarding_state").delete().eq("phone_number", phone)
        );
      }

      // Keyed by parent_id rather than phone number.
      await runStep("delete_lunch_checkin_log", () =>
        admin.from("lunch_checkin_log").delete().eq("parent_id", callerId)
      );

      // Cascades: profiles, children (child_reminders, weekly_lunch_plans,
      // event_exclusions), linked_accounts, consent_records, invite_tokens.
      const { error: deleteUserError } = await admin.auth.admin.deleteUser(callerId);
      if (deleteUserError) {
        console.error("delete-account: step=delete_auth_user failed", deleteUserError.message);
        throw new Error(`delete_auth_user: ${deleteUserError.message}`);
      }
      steps.push("delete_auth_user");
    } catch (stepError) {
      return json(
        {
          success: false,
          error: "Account deletion did not complete. Please contact support.",
          failed_at: (stepError as Error).message,
          completed_steps: steps,
        },
        500
      );
    }

    console.log("delete-account: completed for user", callerId, steps.join(", "));
    return json({ success: true, deleted_user_id: callerId, completed_steps: steps });
  } catch (e) {
    console.error("delete-account: unexpected error", (e as Error).message);
    return json({ success: false, error: "Unexpected error deleting account" }, 500);
  }
});
