import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const ForgotPassword = () => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { toast } = useToast();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setLoading(false);
      return;
    }

    setSent(true);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 mb-6">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="font-display font-black text-xl text-foreground">Monty</span>
          </Link>
          <h1 className="text-2xl font-display font-black text-foreground">Reset your password</h1>
          <p className="text-muted-foreground mt-1">We'll send you a reset link</p>
        </div>

        {sent ? (
          <div className="bg-card rounded-2xl p-6 border border-border shadow-sm text-center">
            <p className="text-foreground font-semibold mb-2">Check your email</p>
            <p className="text-muted-foreground text-sm">We've sent a password reset link to <strong>{email}</strong>.</p>
            <Link to="/login">
              <Button variant="outline" className="mt-4 rounded-full font-display font-semibold">Back to login</Button>
            </Link>
          </div>
        ) : (
          <form onSubmit={handleReset} className="space-y-4 bg-card rounded-2xl p-6 border border-border shadow-sm">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <Button type="submit" className="w-full rounded-full font-display font-bold" disabled={loading}>
              {loading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}

        <p className="text-center text-sm text-muted-foreground mt-6">
          <Link to="/login" className="text-primary font-semibold hover:underline">Back to login</Link>
        </p>
      </div>
    </div>
  );
};

export default ForgotPassword;
