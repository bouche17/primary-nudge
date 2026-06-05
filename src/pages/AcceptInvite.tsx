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
    if (!user || !token) return;
    setStatus("linking");

    const { data, error } = await supabase.functions.invoke("redeem-invite", {
      body: { token },
    });

    if (error || !data) {
      console.error("[AcceptInvite] redeem-invite failed:", error);
      localStorage.removeItem("pending_invite_token");
      toast({ title: "Could not link accounts", variant: "destructive" });
      setStatus("invalid");
      return;
    }

    const statusValue = (data as { status?: string }).status;
    if (statusValue === "linked") {
      localStorage.removeItem("pending_invite_token");
      setStatus("done");
      toast({ title: "Accounts linked!", description: "You're now connected." });
      setTimeout(() => navigate("/dashboard"), 1500);
      return;
    }

    localStorage.removeItem("pending_invite_token");
    if (statusValue === "used") {
      toast({ title: "Invite already used", variant: "destructive" });
    } else if (statusValue === "expired") {
      toast({ title: "Invite link has expired", variant: "destructive" });
    } else if (statusValue === "self") {
      toast({ title: "You can't accept your own invite", variant: "destructive" });
    } else {
      toast({ title: "Invalid invite", variant: "destructive" });
    }
    setStatus("invalid");
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
