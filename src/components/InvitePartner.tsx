import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

const PUBLIC_BASE_URL = "https://heymonty.co.uk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, Copy, Check } from "lucide-react";

const InvitePartner = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [inviteLink, setInviteLink] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;
    // Load existing unused invite token
    supabase
      .from("invite_tokens")
      .select("token, expires_at")
      .eq("inviter_user_id", user.id)
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data && data.expires_at && new Date(data.expires_at) > new Date()) {
          setInviteLink(`${PUBLIC_BASE_URL}/invite/${data.token}`);
        }
      });
  }, [user]);

  const handleGenerate = async () => {
    if (!user) return;
    setGenerating(true);

    const { data, error } = await supabase
      .from("invite_tokens")
      .insert({ inviter_user_id: user.id })
      .select("token")
      .single();

    if (error) {
      toast({ title: "Error generating invite", description: error.message, variant: "destructive" });
    } else if (data) {
      const link = `${PUBLIC_BASE_URL}/invite/${data.token}`;
      setInviteLink(link);
      toast({ title: "Invite link created!" });
    }
    setGenerating(false);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    toast({ title: "Link copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    if (navigator.share) {
      await navigator.share({
        title: "Join me on Monty",
        text: "I've invited you to share school reminders on Monty!",
        url: inviteLink,
      });
    } else {
      handleCopy();
    }
  };

  return (
    <div className="bg-card rounded-2xl p-5 border border-border space-y-3">
      <div>
        <h3 className="font-heading font-bold text-foreground text-sm">Invite partner</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Share a link with your partner or co-parent so they can see the same children and reminders.
        </p>
      </div>

      {inviteLink ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input value={inviteLink} readOnly className="flex-1 text-xs" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              className="rounded-full font-cta font-semibold"
            >
              {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleShare}
            className="rounded-full font-cta font-semibold"
          >
            Share link
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-full font-cta font-semibold"
        >
          <UserPlus className="w-4 h-4 mr-2" />
          {generating ? "Generating…" : "Generate invite link"}
        </Button>
      )}
    </div>
  );
};

export default InvitePartner;
