import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const ResetPassword = () => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    // Check for recovery token in URL hash
    const hash = window.location.hash;
    if (hash.includes("type=recovery")) {
      setReady(true);
    }
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (password.length < 6) {
      toast({ title: "Password too short", description: "At least 6 characters.", variant: "destructive" });
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setLoading(false);
      return;
    }

    toast({ title: "Password updated", description: "You can now log in with your new password." });
    navigate("/login");
  };

  if (!ready) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-6">
        <div className="text-center">
          <Sparkles className="w-8 h-8 text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Invalid or expired reset link.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center mx-auto mb-4">
            <Sparkles className="w-5 h-5 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-display font-black text-foreground">Set new password</h1>
        </div>

        <form onSubmit={handleReset} className="space-y-4 bg-card rounded-2xl p-6 border border-border shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input id="confirmPassword" type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </div>
          <Button type="submit" className="w-full rounded-full font-display font-bold" disabled={loading}>
            {loading ? "Updating…" : "Update password"}
          </Button>
        </form>
      </div>
    </div>
  );
};

export default ResetPassword;
