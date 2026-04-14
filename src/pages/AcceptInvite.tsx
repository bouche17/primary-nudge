import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

const AcceptInvite = () => {
  const { token } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [status, setStatus] = useState<"loading" | "invalid" | "linking" | "done">("loading");

  useEffect(() => {
    if (loading) return;

    if (!user) {
      // Store token and redirect to signup
      localStorage.setItem("pending_invite_token", token || "");
      navigate(`/signup?invite=${token}`);
      return;
    }

    // User is logged in — accept the invite
    acceptInvite();
  }, [user, loading, token]);

  const acceptInvite = async () => {
    if (!user || !token) return;
    setStatus("linking");

    // Look up the token
    const { data: invite, error: lookupError } = await supabase
      .from("invite_tokens")
      .select("inviter_user_id, used_at, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (!invite || lookupError) {
      setStatus("invalid");
      return;
    }

    if (invite.used_at) {
      toast({ title: "Invite already used", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      toast({ title: "Invite link has expired", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    if (invite.inviter_user_id === user.id) {
      toast({ title: "You can't accept your own invite", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    // Create linked account
    const { error: linkError } = await supabase.from("linked_accounts").insert({
      primary_user_id: invite.inviter_user_id,
      linked_user_id: user.id,
      status: "accepted",
      accepted_at: new Date().toISOString(),
    });

    if (linkError) {
      toast({ title: "Error linking accounts", description: linkError.message, variant: "destructive" });
      setStatus("invalid");
      return;
    }

    // Mark token as used
    await supabase
      .from("invite_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("token", token);

    localStorage.removeItem("pending_invite_token");
    setStatus("done");
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
