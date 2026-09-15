import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAdmin } from "@/hooks/use-admin";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sparkles, ArrowLeft, Users, RefreshCw, Baby, Bell, StickyNote } from "lucide-react";

interface Member {
  user_id: string;
  phone_number: string | null;
  role: string;
  accepted_at: string | null;
  notifies: string[];
}
interface Child {
  id: string;
  first_name: string;
  year_group: string;
  owner_user_id: string;
  school_name: string | null;
}
interface Reminder {
  id: string;
  title: string;
  emoji: string | null;
  day_of_week: string;
  reminder_time: string | null;
  active: boolean;
  child_name: string;
}
interface Note {
  id: string;
  child_name: string | null;
  summary: string | null;
  phone_number: string;
  dates: string[];
  created_at: string;
}
interface Family {
  id: string;
  members: Member[];
  children: Child[];
  reminders: Reminder[];
  notes: Note[];
}

const FamilyAudit = () => {
  const { user, loading } = useAuth();
  const { isAdmin, loading: adminLoading } = useAdmin();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [families, setFamilies] = useState<Family[]>([]);
  const [templates, setTemplates] = useState<Record<string, boolean>>({});
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!loading && !user) navigate("/login");
    if (!loading && !adminLoading && user && !isAdmin) {
      toast({ title: "Access denied", description: "Admin privileges required.", variant: "destructive" });
      navigate("/dashboard");
    }
  }, [user, loading, adminLoading, isAdmin, navigate, toast]);

  const fetchData = async () => {
    setFetching(true);
    const { data, error } = await supabase.functions.invoke("family-audit");
    setFetching(false);
    if (error) {
      toast({ title: "Couldn't load families", description: error.message, variant: "destructive" });
      return;
    }
    setFamilies((data?.families ?? []) as Family[]);
    setTemplates(data?.templates ?? {});
  };

  useEffect(() => {
    if (user && isAdmin) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isAdmin]);

  if (loading || adminLoading) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? families.filter(
        (f) =>
          f.members.some((m) => (m.phone_number ?? "").toLowerCase().includes(q)) ||
          f.children.some((c) => c.first_name.toLowerCase().includes(q)),
      )
    : families;

  return (
    <div className="min-h-screen bg-background">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-heading font-black text-lg text-foreground">Monty</span>
        </div>
        <Link to="/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4 mr-1" /> Dashboard
          </Button>
        </Link>
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-display font-black text-foreground mb-1">
              <Users className="w-6 h-6 inline-block mr-2 text-primary" />
              Families & partner notifications
            </h1>
            <p className="text-muted-foreground text-sm">
              Who is linked to whom, and exactly which numbers get notified when a partner saves something.
            </p>
          </div>
          <Button onClick={fetchData} disabled={fetching} variant="outline" className="rounded-full">
            <RefreshCw className={`w-4 h-4 mr-2 ${fetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          {[
            ["Reminder alerts", templates.partner_reminder],
            ["Note alerts", templates.partner_note],
            ["Lunch alerts", templates.partner_lunch],
          ].map(([label, ok]) => (
            <Badge key={String(label)} variant={ok ? "default" : "secondary"}>
              {String(label)}: {ok ? "ready" : "not set up yet"}
            </Badge>
          ))}
        </div>

        <Input
          placeholder="Search by phone number or child's name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-6"
        />

        <div className="space-y-4">
          {filtered.map((family) => (
            <div key={family.id} className="bg-card rounded-2xl border border-border p-5 space-y-4">
              <div className="space-y-2">
                {family.members.map((m) => (
                  <div key={m.user_id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline" className="capitalize">{m.role}</Badge>
                    <span className="font-heading font-bold text-foreground">
                      {m.phone_number ?? "No WhatsApp number"}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {m.notifies.length > 0
                        ? `notifies ${m.notifies.join(", ")}`
                        : "no partner to notify"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 sm:grid-cols-3 pt-2 border-t border-border">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">
                    <Baby className="w-3.5 h-3.5 inline-block mr-1" />
                    Children ({family.children.length})
                  </p>
                  <ul className="space-y-1 text-sm">
                    {family.children.map((c) => (
                      <li key={c.id} className="text-foreground">
                        {c.first_name}{" "}
                        <span className="text-muted-foreground text-xs">
                          {c.year_group}
                          {c.school_name ? ` · ${c.school_name}` : ""}
                        </span>
                      </li>
                    ))}
                    {family.children.length === 0 && (
                      <li className="text-muted-foreground text-xs">None</li>
                    )}
                  </ul>
                </div>

                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">
                    <Bell className="w-3.5 h-3.5 inline-block mr-1" />
                    Reminders ({family.reminders.length})
                  </p>
                  <ul className="space-y-1 text-sm">
                    {family.reminders.map((r) => (
                      <li key={r.id} className={r.active ? "text-foreground" : "text-muted-foreground line-through"}>
                        {r.emoji ?? "🔔"} {r.title}{" "}
                        <span className="text-muted-foreground text-xs">
                          {r.child_name} · {r.day_of_week}
                          {r.reminder_time ? ` · ${r.reminder_time}` : ""}
                        </span>
                      </li>
                    ))}
                    {family.reminders.length === 0 && (
                      <li className="text-muted-foreground text-xs">None</li>
                    )}
                  </ul>
                </div>

                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">
                    <StickyNote className="w-3.5 h-3.5 inline-block mr-1" />
                    Notes ({family.notes.length})
                  </p>
                  <ul className="space-y-1 text-sm">
                    {family.notes.map((n) => (
                      <li key={n.id} className="text-foreground">
                        {n.summary ?? "(no summary)"}{" "}
                        <span className="text-muted-foreground text-xs">
                          {n.child_name ?? "unassigned"}
                          {n.dates.length > 0 ? ` · ${n.dates.join(", ")}` : ""} · {n.phone_number}
                        </span>
                      </li>
                    ))}
                    {family.notes.length === 0 && (
                      <li className="text-muted-foreground text-xs">None</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">{fetching ? "Loading…" : "No families found."}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default FamilyAudit;
