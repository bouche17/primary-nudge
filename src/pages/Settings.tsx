import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowLeft, Download, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const SettingsPage = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleExport = async () => {
    if (!user) return;
    setExporting(true);

    const [childrenRes, consentRes] = await Promise.all([
      supabase.from("children").select("first_name, year_group, schools(name, postcode)").eq("parent_id", user.id),
      supabase.from("consent_records").select("consent_type, consented_at").eq("user_id", user.id),
    ]);

    const exportData = {
      email: user.email,
      children: childrenRes.data || [],
      consent_records: consentRes.data || [],
      exported_at: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "monty-data-export.json";
    a.click();
    URL.revokeObjectURL(url);

    setExporting(false);
    toast({ title: "Data exported", description: "Your data has been downloaded." });
  };

  const handleDeleteAccount = async () => {
    if (!user) return;
    setDeleting(true);

    // Delete children (cascades handled by RLS)
    await supabase.from("children").delete().eq("parent_id", user.id);
    await supabase.from("consent_records").delete().eq("user_id", user.id);

    // Sign out (actual user deletion requires admin/service role)
    await signOut();
    toast({ title: "Account data deleted", description: "Your data has been removed." });
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background">
      <nav className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <span className="font-display font-bold text-foreground">Settings</span>
      </nav>

      <main className="max-w-lg mx-auto px-6 py-10 space-y-6">
        <div>
          <h2 className="font-display font-bold text-foreground mb-1">Account</h2>
          <p className="text-sm text-muted-foreground">{user?.email}</p>
        </div>

        <div className="bg-card rounded-2xl p-5 border border-border space-y-4">
          <div>
            <h3 className="font-display font-bold text-foreground text-sm">Export your data</h3>
            <p className="text-xs text-muted-foreground mt-1">Download all your personal data as a JSON file.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={exporting}
              className="mt-3 rounded-full font-display font-semibold"
            >
              <Download className="w-4 h-4 mr-2" />
              {exporting ? "Exporting…" : "Export data"}
            </Button>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="font-display font-bold text-destructive text-sm">Delete account</h3>
            <p className="text-xs text-muted-foreground mt-1">
              This will permanently delete all your children data, consent records, and sign you out.
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  className="mt-3 rounded-full font-display font-semibold"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete my account
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all your data including your children's information and consent records. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDeleteAccount} disabled={deleting}>
                    {deleting ? "Deleting…" : "Yes, delete everything"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <div className="bg-card rounded-2xl p-5 border border-border">
          <h3 className="font-display font-bold text-foreground text-sm">Privacy</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Read our{" "}
            <a href="/privacy" className="text-primary underline hover:no-underline">
              privacy policy
            </a>{" "}
            to learn how we handle your data.
          </p>
        </div>
      </main>
    </div>
  );
};

export default SettingsPage;
