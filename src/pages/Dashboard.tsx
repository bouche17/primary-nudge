import { useEffect, useMemo, useState } from "react";
import GettingStarted from "@/components/GettingStarted";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  Plus,
  Settings,
  LogOut,
  Trash2,
  MessageCircle,
  Bot,
  Calendar,
  Bell,
  UserPlus,
} from "lucide-react";
import { useAdmin } from "@/hooks/use-admin";

const WHATSAPP_LINK = "https://wa.me/447455730962";
const SHOW_GETTING_STARTED_FLAG = "monty_show_getting_started";

interface ChildWithSchool {
  id: string;
  first_name: string;
  year_group: string;
  school_id: string | null;
  schools: { name: string; postcode: string } | null;
}

interface UpcomingItem {
  key: string;
  date: string; // YYYY-MM-DD
  title: string;
  childNames: string[];
  source: "event" | "note";
}


interface RecurringItem {
  id: string;
  child_id: string;
  title: string;
  emoji: string | null;
  day_of_week: string;
  reminder_time: string | null;
}

const DAYS_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const formatDateHeading = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);

  if (target.getTime() === today.getTime()) return "Today";
  if (target.getTime() === tomorrow.getTime()) return "Tomorrow";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const Dashboard = () => {
  const { user, loading, signOut } = useAuth();
  const { isAdmin } = useAdmin();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [children, setChildren] = useState<ChildWithSchool[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);

  const [showGettingStarted, setShowGettingStarted] = useState(() => {
    return localStorage.getItem(SHOW_GETTING_STARTED_FLAG) === "true";
  });

  const handleDismissGettingStarted = () => {
    localStorage.removeItem(SHOW_GETTING_STARTED_FLAG);
    setShowGettingStarted(false);
  };

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
    if (!user) return;

    // Children (with school)
    supabase
      .from("children")
      .select("id, first_name, year_group, school_id, schools(name, postcode)")
      .then(({ data }) => {
        if (data) setChildren(data as unknown as ChildWithSchool[]);
      });
  }, [user]);

  // Once we know the children, fetch upcoming events + recurring reminders
  useEffect(() => {
    if (!user) return;
    if (children.length === 0) {
      setUpcoming([]);
      setRecurring([]);
      return;
    }

    const childIds = children.map((c) => c.id);
    const schoolIds = Array.from(new Set(children.map((c) => c.school_id).filter(Boolean))) as string[];
    const yearGroups = Array.from(new Set(children.map((c) => c.year_group).filter(Boolean)));

    const now = new Date();
    const in7 = new Date();
    in7.setDate(in7.getDate() + 7);
    const startIso = now.toISOString();
    const endIso = in7.toISOString();

    // Recurring child reminders
    supabase
      .from("child_reminders")
      .select("id, child_id, title, emoji, day_of_week, reminder_time, active")
      .in("child_id", childIds)
      .eq("active", true)
      .then(({ data }) => {
        if (data) setRecurring(data as RecurringItem[]);
      });

    // Upcoming events + parent notes — merged across children
    const buildItems = async () => {
      const merged = new Map<string, UpcomingItem>();

      const addItem = (
        dedupeKey: string,
        item: Omit<UpcomingItem, "childNames"> & { childNames: string[] }
      ) => {
        const existing = merged.get(dedupeKey);
        if (existing) {
          item.childNames.forEach((n) => {
            if (n && !existing.childNames.includes(n)) existing.childNames.push(n);
          });
        } else {
          merged.set(dedupeKey, item);
        }
      };

      if (schoolIds.length > 0) {
        const allowedYears = ["all", ...yearGroups];
        const { data: events } = await supabase
          .from("school_events")
          .select("id, title, start_at, year_group, school_id")
          .in("school_id", schoolIds)
          .gte("start_at", startIso)
          .lte("start_at", endIso)
          .order("start_at", { ascending: true });

        events?.forEach((e) => {
          if (e.year_group && !allowedYears.includes(e.year_group)) return;
          const date = new Date(e.start_at).toISOString().slice(0, 10);
          const matchedChildren = children
            .filter((c) => c.school_id === e.school_id)
            .filter((c) => !e.year_group || e.year_group === "all" || c.year_group === e.year_group)
            .map((c) => c.first_name);
          const dedupeKey = `event|${date}|${e.title.trim().toLowerCase()}`;
          addItem(dedupeKey, {
            key: `event-${date}-${e.title}`,
            date,
            title: e.title,
            childNames: matchedChildren,
            source: "event",
          });
        });
      }

      const { data: notes } = await supabase.rpc("get_upcoming_parent_notes", {
        _user_id: user.id,
        _days: 7,
      });
      notes?.forEach(
        (n: { id: string; child_name: string | null; summary: string | null; event_date: string; raw_content: string | null }) => {
          const title = n.summary || n.raw_content?.slice(0, 80) || "Reminder";
          const dedupeKey = `note|${n.event_date}|${title.trim().toLowerCase()}`;
          addItem(dedupeKey, {
            key: `note-${n.event_date}-${title}`,
            date: n.event_date,
            title,
            childNames: n.child_name ? [n.child_name] : [],
            source: "note",
          });
        }
      );

      const items = Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
      setUpcoming(items);
    };



    buildItems();
  }, [user, children]);

  const upcomingByDate = useMemo(() => {
    const map = new Map<string, UpcomingItem[]>();
    upcoming.forEach((i) => {
      const arr = map.get(i.date) ?? [];
      arr.push(i);
      map.set(i.date, arr);
    });
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [upcoming]);

  const recurringByChild = useMemo(() => {
    return children.map((child) => {
      const items = recurring
        .filter((r) => r.child_id === child.id)
        .sort((a, b) => {
          const ai = DAYS_ORDER.indexOf(a.day_of_week.toLowerCase());
          const bi = DAYS_ORDER.indexOf(b.day_of_week.toLowerCase());
          return ai - bi;
        });
      return { child, items };
    });
  }, [children, recurring]);

  if (loading) return null;

  if (showGettingStarted) {
    return (
      <div className="min-h-screen bg-background">
        <GettingStarted onDismiss={handleDismissGettingStarted} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-heading font-black text-lg text-foreground">Monty</span>
        </div>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <>
              <Link to="/bot-flows">
                <Button variant="ghost" size="icon" aria-label="Bot flows"><Bot className="w-4 h-4" /></Button>
              </Link>
              <Link to="/calendar-feeds">
                <Button variant="ghost" size="icon" aria-label="Calendar feeds"><Calendar className="w-4 h-4" /></Button>
              </Link>
              <Link to="/school-reminders">
                <Button variant="ghost" size="icon" aria-label="School reminders"><Bell className="w-4 h-4" /></Button>
              </Link>
            </>
          )}
          <a href={WHATSAPP_LINK} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost" size="icon" aria-label="Message Monty on WhatsApp">
              <MessageCircle className="w-4 h-4" />
            </Button>
          </a>
          <Link to="/settings">
            <Button variant="ghost" size="icon" aria-label="Account settings"><Settings className="w-4 h-4" /></Button>
          </Link>
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-10">
        {/* Children */}
        <section>
          <div className="flex items-end justify-between mb-4">
            <div>
              <h1 className="text-2xl text-foreground font-sans font-bold">Your children</h1>
              <p className="text-muted-foreground text-sm">Monty sends reminders for each child's school.</p>
            </div>
          </div>

          <div className="space-y-3">
            {children.map((child) => (
              <div
                key={child.id}
                className="flex items-center justify-between bg-card rounded-2xl p-5 border border-border"
              >
                <div>
                  <p className="font-heading font-bold text-foreground">{child.first_name}</p>
                  <p className="text-sm text-muted-foreground">
                    {child.year_group}
                    {child.schools?.name ? ` · ${child.schools.name}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => removeChild(child.id)}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                  aria-label={`Remove ${child.first_name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 mt-4">
            <Button
              variant="outline"
              onClick={() => navigate("/onboarding?add=true")}
              className="rounded-full font-cta font-semibold"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add another child
            </Button>
            <Button
              onClick={() => window.open(WHATSAPP_LINK, "_blank")}
              className="rounded-full font-cta font-bold"
            >
              <MessageCircle className="w-4 h-4 mr-2" />
              Ask Monty
            </Button>
          </div>
        </section>

        {/* Upcoming reminders */}
        <section>
          <h2 className="text-lg font-bold text-foreground mb-3">Next 7 days</h2>
          {upcomingByDate.length === 0 ? (
            <div className="bg-card rounded-2xl p-5 border border-border text-sm text-muted-foreground">
              Nothing on the horizon — Monty will let you know as things come up.
            </div>
          ) : (
            <div className="space-y-4">
              {upcomingByDate.map(([date, items]) => (
                <div key={date} className="bg-card rounded-2xl border border-border overflow-hidden">
                  <div className="px-5 py-2 bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {formatDateHeading(date)}
                  </div>
                  <ul className="divide-y divide-border">
                    {items.map((item) => (
                      <li key={item.key} className="px-5 py-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-foreground text-sm truncate">{item.title}</p>
                          {item.childNames.length > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {item.childNames.length === 1
                                ? item.childNames[0]
                                : item.childNames.length === 2
                                ? `${item.childNames[0]} and ${item.childNames[1]}`
                                : `${item.childNames.slice(0, -1).join(", ")} and ${item.childNames[item.childNames.length - 1]}`}
                            </p>
                          )}

                        </div>
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary shrink-0 mt-1">
                          {item.source === "event" ? "School" : "Note"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recurring reminders */}
        <section>
          <h2 className="text-lg font-bold text-foreground mb-3">Recurring reminders</h2>
          {recurringByChild.every((g) => g.items.length === 0) ? (
            <div className="bg-card rounded-2xl p-5 border border-border text-sm text-muted-foreground">
              No recurring reminders yet. Tell Monty on WhatsApp, e.g. "Jude has PE on Tuesdays".
            </div>
          ) : (
            <div className="space-y-4">
              {recurringByChild.map(({ child, items }) =>
                items.length === 0 ? null : (
                  <div key={child.id} className="bg-card rounded-2xl border border-border overflow-hidden">
                    <div className="px-5 py-2 bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {child.first_name}
                    </div>
                    <ul className="divide-y divide-border">
                      {items.map((r) => (
                        <li key={r.id} className="px-5 py-3 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-base">{r.emoji || "✅"}</span>
                            <p className="font-medium text-foreground text-sm truncate">{r.title}</p>
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {capitalise(r.day_of_week)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </div>
          )}
        </section>

        {/* Account quick links */}
        <section>
          <h2 className="text-lg font-bold text-foreground mb-3">Account</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Link
              to="/settings"
              className="bg-card rounded-2xl p-4 border border-border hover:border-primary/40 transition-colors flex items-center gap-3"
            >
              <Settings className="w-4 h-4 text-primary" />
              <div>
                <p className="font-semibold text-foreground text-sm">Account settings</p>
                <p className="text-xs text-muted-foreground">Phone number &amp; preferences</p>
              </div>
            </Link>
            <Link
              to="/settings#invite"
              className="bg-card rounded-2xl p-4 border border-border hover:border-primary/40 transition-colors flex items-center gap-3"
            >
              <UserPlus className="w-4 h-4 text-primary" />
              <div>
                <p className="font-semibold text-foreground text-sm">Invite a partner</p>
                <p className="text-xs text-muted-foreground">Share reminders with the other parent</p>
              </div>
            </Link>
            <a
              href={WHATSAPP_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-card rounded-2xl p-4 border border-border hover:border-primary/40 transition-colors flex items-center gap-3 sm:col-span-2"
            >
              <MessageCircle className="w-4 h-4 text-primary" />
              <div>
                <p className="font-semibold text-foreground text-sm">Message Monty on WhatsApp</p>
                <p className="text-xs text-muted-foreground">Add reminders, ask questions, send notes</p>
              </div>
            </a>
          </div>
        </section>
      </main>
    </div>
  );
};

export default Dashboard;
