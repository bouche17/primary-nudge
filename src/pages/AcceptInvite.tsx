import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

const AcceptInvite = () => {
  const { token: urlToken } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [status, setStatus] = useState<"loading" | "invalid" | "linking" | "done">("loading");

  // Use URL token or fall back to localStorage
  const token = urlToken || localStorage.getItem("pending_invite_token") || "";

  useEffect(() => {
    console.log("[AcceptInvite] useEffect fired", { loading, userId: user?.id, urlToken, token });

    if (loading) return;

    if (!user) {
      console.log("[AcceptInvite] No user — storing token and redirecting to signup");
      localStorage.setItem("pending_invite_token", token);
      navigate(`/signup?invite=${token}`);
      return;
    }

    console.log("[AcceptInvite] User is authenticated, calling acceptInvite");
    acceptInvite();
  }, [user, loading, token]);

  const acceptInvite = async () => {
    if (!user || !token) {
      console.log("[AcceptInvite] acceptInvite aborted — missing user or token", { userId: user?.id, token });
      return;
    }
    setStatus("linking");

    // Step 1: Look up the token
    console.log("[AcceptInvite] Step 1: Looking up token in invite_tokens…", { token });
    const { data: invite, error: lookupError } = await supabase
      .from("invite_tokens")
      .select("inviter_user_id, used_at, expires_at")
      .eq("token", token)
      .maybeSingle();

    console.log("[AcceptInvite] Step 1 result:", { invite, lookupError });

    if (!invite || lookupError) {
      console.error("[AcceptInvite] Token lookup failed or not found");
      localStorage.removeItem("pending_invite_token");
      setStatus("invalid");
      return;
    }

    if (invite.used_at) {
      console.log("[AcceptInvite] Token already used at:", invite.used_at);
      localStorage.removeItem("pending_invite_token");
      toast({ title: "Invite already used", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      console.log("[AcceptInvite] Token expired at:", invite.expires_at);
      localStorage.removeItem("pending_invite_token");
      toast({ title: "Invite link has expired", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    if (invite.inviter_user_id === user.id) {
      console.log("[AcceptInvite] User is the inviter — self-invite blocked");
      localStorage.removeItem("pending_invite_token");
      toast({ title: "You can't accept your own invite", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    // Step 2: Create linked account
    console.log("[AcceptInvite] Step 2: Inserting into linked_accounts…", {
      primary_user_id: invite.inviter_user_id,
      linked_user_id: user.id,
    });
    const { data: linkData, error: linkError } = await supabase.from("linked_accounts").insert({
      primary_user_id: invite.inviter_user_id,
      linked_user_id: user.id,
      status: "accepted",
      accepted_at: new Date().toISOString(),
    }).select();

    console.log("[AcceptInvite] Step 2 result:", { linkData, linkError });

    if (linkError) {
      console.error("[AcceptInvite] linked_accounts insert FAILED:", linkError);
      localStorage.removeItem("pending_invite_token");
      toast({ title: "Error linking accounts", description: linkError.message, variant: "destructive" });
      setStatus("invalid");
      return;
    }

    // Step 3: Mark token as used
    console.log("[AcceptInvite] Step 3: Marking token as used…");
    const { data: updateData, error: updateError } = await supabase
      .from("invite_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token", token)
      .select();

    console.log("[AcceptInvite] Step 3 result:", { updateData, updateError });

    if (updateError) {
      console.error("[AcceptInvite] Failed to mark token as used:", updateError);
    }

    localStorage.removeItem("pending_invite_token");
    setStatus("done");
    console.log("[AcceptInvite] ✅ Flow complete! Redirecting to dashboard in 1.5s");
    toast({ title: "Accounts linked!", description: "You're now connected." });

    setTimeout(() => navigate("/dashboard"), 1500);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="max-w-sm text-center space-y-4">
        <Sparkles className="w-10 h-10 text-primary mx-auto" />
        {status === "loading" || status === "linking" ? (
          <>
            <h1 className="font-heading font-bold text-xl text-foreground">Linking accounts…</h1>
            <p className="text-sm text-muted-foreground">Please wait a moment.</p>
          </>
        ) : status === "done" ? (
          <>
            <h1 className="font-heading font-bold text-xl text-foreground">You're connected! 🎉</h1>
            <p className="text-sm text-muted-foreground">Redirecting to your dashboard…</p>
          </>
        ) : (
          <>
            <h1 className="font-heading font-bold text-xl text-foreground">Invalid invite</h1>
            <p className="text-sm text-muted-foreground">This invite link is expired, already used, or invalid.</p>
            <Button onClick={() => navigate("/")} className="rounded-full font-cta font-semibold">
              Go home
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

export default AcceptInvite;
