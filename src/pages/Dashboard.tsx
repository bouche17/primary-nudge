import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Sparkles, Plus, Settings, LogOut, Trash2, MessageCircle, Bot } from "lucide-react";

interface ChildWithSchool {
  id: string;
  first_name: string;
  year_group: string;
  schools: { name: string; postcode: string } | null;
}

const Dashboard = () => {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [children, setChildren] = useState<ChildWithSchool[]>([]);
  const { toast } = useToast();

  const removeChild = async (childId: string) => {
    const { error } = await supabase.from("children").delete().eq("id", childId);
    if (error) {
      toast({ title: "Error removing child", description: error.message, variant: "destructive" });
      return;
    }
    setChildren((prev) => prev.filter((c) => c.id !== childId));
    toast({ title: "Child removed" });
  };

  useEffect(() => {
    if (!loading && !user) navigate("/login");
  }, [user, loading, navigate]);

  useEffect(() => {
    if (user) {
      supabase
        .from("children")
        .select("id, first_name, year_group, schools(name, postcode)")
        .eq("parent_id", user.id)
        .then(({ data }) => {
          if (data) setChildren(data as unknown as ChildWithSchool[]);
        });
    }
  }, [user]);

  if (loading) return null;

  return (
    <div className="min-h-screen bg-background">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-heading font-black text-lg text-foreground">Monty</span>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/bot-flows">
            <Button variant="ghost" size="icon"><Bot className="w-4 h-4" /></Button>
          </Link>
          <Link to="/settings">
            <Button variant="ghost" size="icon"><Settings className="w-4 h-4" /></Button>
          </Link>
          <Button variant="ghost" size="icon" onClick={signOut}><LogOut className="w-4 h-4" /></Button>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-display font-black text-foreground mb-1">Your children</h1>
        <p className="text-muted-foreground text-sm mb-6">Monty sends reminders for each child's school.</p>

        <div className="space-y-3">
          {children.map((child) => (
            <div key={child.id} className="flex items-center justify-between bg-card rounded-2xl p-5 border border-border">
              <div>
                <p className="font-heading font-bold text-foreground">{child.first_name}</p>
                <p className="text-sm text-muted-foreground">
                  {child.year_group} · {child.schools?.name}
                </p>
              </div>
              <button onClick={() => removeChild(child.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="flex gap-3 mt-4">
          <Button
            variant="outline"
            onClick={() => navigate("/onboarding?add=true")}
            className="rounded-full font-cta font-semibold"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add another child
          </Button>
          <Button
            onClick={() => window.open("https://wa.me/14155238886?text=join%20cannot-printed", "_blank")}
            className="rounded-full font-cta font-bold"
          >
            <MessageCircle className="w-4 h-4 mr-2" />
            Ask Monty
          </Button>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
