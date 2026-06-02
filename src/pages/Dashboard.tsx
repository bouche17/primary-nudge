import { useEffect, useMemo, useState } from "react";
import GettingStarted from "@/components/GettingStarted";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Check,
  X,
  Pencil,
  Sandwich,
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
  noteIds?: string[];
}

interface RecurringItem {
  id: string;
  child_id: string;
  title: string;
  emoji: string | null;
  day_of_week: string;
  reminder_time: string | null;
  active: boolean;
}

interface LunchPlanRow {
  child_id: string;
  packed_lunch_days: string[];
}

const DAYS_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_SHORT: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

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

// Monday of the current week at UTC noon (per project memory)
const currentWeekStart = (): string => {
  const now = new Date();
  const utcNoon = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0)
  );
  const dow = utcNoon.getUTCDay(); // 0 = Sun, 1 = Mon ...
  const offset = (dow + 6) % 7; // days since Monday
  utcNoon.setUTCDate(utcNoon.getUTCDate() - offset);
  return utcNoon.toISOString().slice(0, 10);
};

const formatSyncedAt = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const Dashboard = () => {
  const { user, loading, signOut } = useAuth();
  const { isAdmin } = useAdmin();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [children, setChildren] = useState<ChildWithSchool[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingItem[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);
  const [lunchPlans, setLunchPlans] = useState<LunchPlanRow[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [editingDay, setEditingDay] = useState<string | null>(null);

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

  const deleteNote = async (noteIds: string[]) => {
    const results = await Promise.all(
      noteIds.map((id) => supabase.rpc("delete_parent_note", { _note_id: id }))
    );
    const failed = results.find((r) => r.error || r.data === false);
    if (failed) {
      toast({
        title: "Couldn't remove that note",
        description: failed.error?.message ?? "Please try again.",
        variant: "destructive",
      });
      return;
    }
    setUpcoming((prev) =>
      prev.filter((i) => !i.noteIds || !i.noteIds.some((id) => noteIds.includes(id)))
    );
    toast({ title: "Note removed" });
  };

  const deleteRecurring = async (id: string) => {
    const { error } = await supabase.from("child_reminders").delete().eq("id", id);
    if (error) {
      toast({ title: "Couldn't remove reminder", description: error.message, variant: "destructive" });
      return;
    }
    setRecurring((prev) => prev.filter((r) => r.id !== id));
    toast({ title: "Reminder removed" });
  };

  const toggleRecurring = async (id: string, next: boolean) => {
    const previous = recurring;
    setRecurring((prev) => prev.map((r) => (r.id === id ? { ...r, active: next } : r)));
    const { error } = await supabase.from("child_reminders").update({ active: next }).eq("id", id);
    if (error) {
      setRecurring(previous);
      toast({ title: "Couldn't update reminder", description: error.message, variant: "destructive" });
    }
  };

  const updateRecurringDay = async (id: string, day: string) => {
    const previous = recurring;
    setRecurring((prev) => prev.map((r) => (r.id === id ? { ...r, day_of_week: day } : r)));
    setEditingDay(null);
    const { error } = await supabase
      .from("child_reminders")
      .update({ day_of_week: day })
      .eq("id", id);
    if (error) {
      setRecurring(previous);
      toast({ title: "Couldn't update day", description: error.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    if (!loading && !user) navigate("/login");
  }, [user, loading, navigate]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("children")
      .select("id, first_name, year_group, school_id, schools(name, postcode)")
      .then(({ data }) => {
        if (data) setChildren(data as unknown as ChildWithSchool[]);
      });
  }, [user]);

  // Fetch dependent data once children are known
  useEffect(() => {
    if (!user) return;
    if (children.length === 0) {
      setUpcoming([]);
      setRecurring([]);
      setLunchPlans([]);
      setLastSyncedAt(null);
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

    // Recurring child reminders (active + paused)
    supabase
      .from("child_reminders")
      .select("id, child_id, title, emoji, day_of_week, reminder_time, active")
      .in("child_id", childIds)
      .then(({ data }) => {
        if (data) setRecurring(data as RecurringItem[]);
      });

    // Packed lunch plans for current week
    const weekStart = currentWeekStart();
    supabase
      .from("weekly_lunch_plans")
      .select("child_id, packed_lunch_days")
      .in("child_id", childIds)
      .eq("week_start", weekStart)
      .then(({ data }) => {
        if (data) setLunchPlans(data as LunchPlanRow[]);
      });

    // Last calendar sync for children's schools
    if (schoolIds.length > 0) {
      supabase
        .from("school_calendar_feeds")
        .select("last_synced_at")
        .in("school_id", schoolIds)
        .order("last_synced_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .then(({ data }) => {
          setLastSyncedAt(data?.[0]?.last_synced_at ?? null);
        });
    }

    // Upcoming events + parent notes — merged across children
    const buildItems = async () => {
      const merged = new Map<string, UpcomingItem>();

      const addItem = (dedupeKey: string, item: UpcomingItem) => {
        const existing = merged.get(dedupeKey);
        if (existing) {
          item.childNames.forEach((n) => {
            if (n && !existing.childNames.includes(n)) existing.childNames.push(n);
          });
          if (item.noteIds) {
            existing.noteIds = [...(existing.noteIds ?? []), ...item.noteIds];
          }
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
            .filter(
              (c) => !e.year_group || e.year_group === "all" || c.year_group === e.year_group
            )
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
        (n: {
          id: string;
          child_name: string | null;
          summary: string | null;
          event_date: string;
          raw_content: string | null;
        }) => {
          const title = n.summary || n.raw_content?.slice(0, 80) || "Reminder";
          const dedupeKey = `note|${n.event_date}|${title.trim().toLowerCase()}`;
          addItem(dedupeKey, {
            key: `note-${n.id}`,
            date: n.event_date,
            title,
            childNames: n.child_name ? [n.child_name] : [],
            source: "note",
            noteIds: [n.id],
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

  const lunchByChild = useMemo(() => {
    return children.map((child) => {
      const plan = lunchPlans.find((p) => p.child_id === child.id);
      return { child, days: plan?.packed_lunch_days ?? [] };
    });
  }, [children, lunchPlans]);

  const formatNames = (names: string[]) => {
    if (names.length === 0) return null;
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  };

  if (loading) return null;

  if (showGettingStarted) {
    return (
      <div className="min-h-screen bg-background">
        <GettingStarted onDismiss={handleDismissGettingStarted} />
      </div>
    );
  }

  const syncedLabel = formatSyncedAt(lastSyncedAt);

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
          <div className="flex items-end justify-between mb-3 gap-3">
            <h2 className="text-lg font-bold text-foreground">Next 7 days</h2>
            {syncedLabel && (
              <span className="text-xs text-muted-foreground">
                School calendar synced {syncedLabel}
              </span>
            )}
          </div>
          {upcomingByDate.length === 0 ? (
            <div className="bg-card rounded-2xl p-5 border border-border text-sm text-muted-foreground">
              Nothing coming up — forward a school letter or message to Monty on WhatsApp to add reminders.
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
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-foreground text-sm">{item.title}</p>
                          {item.childNames.length > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {formatNames(item.childNames)}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                            {item.source === "event" ? "School" : "Saved"}
                          </span>
                          {item.source === "note" && item.noteIds && item.noteIds.length > 0 && (
                            <button
                              onClick={() => deleteNote(item.noteIds!)}
                              className="text-muted-foreground hover:text-destructive transition-colors"
                              aria-label="Remove note"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
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
                        <li
                          key={r.id}
                          className={`px-5 py-3 flex items-center justify-between gap-3 ${
                            r.active ? "" : "opacity-60"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <span className="text-base">{r.emoji || "✅"}</span>
                            <p className="font-medium text-foreground text-sm truncate">{r.title}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {editingDay === r.id ? (
                              <Select
                                value={r.day_of_week.toLowerCase()}
                                onValueChange={(v) => updateRecurringDay(r.id, v)}
                              >
                                <SelectTrigger className="h-8 w-[120px] text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {DAYS_ORDER.map((d) => (
                                    <SelectItem key={d} value={d}>
                                      {capitalise(d)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <button
                                onClick={() => setEditingDay(r.id)}
                                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                                aria-label="Edit day"
                              >
                                {capitalise(r.day_of_week)}
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                            <Switch
                              checked={r.active}
                              onCheckedChange={(v) => toggleRecurring(r.id, v)}
                              aria-label={r.active ? "Pause reminder" : "Resume reminder"}
                              className="data-[state=checked]:bg-[#FF6B35] data-[state=unchecked]:bg-muted-foreground/30"
                            />
                            <button
                              onClick={() => deleteRecurring(r.id)}
                              className="text-muted-foreground hover:text-destructive transition-colors"
                              aria-label="Remove reminder"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </div>
          )}
        </section>

        {/* Packed lunch this week */}
        <section>
          <h2 className="text-lg font-bold text-foreground mb-3">Packed lunch this week</h2>
          {lunchByChild.every((g) => g.days.length === 0) ? (
            <div className="bg-card rounded-2xl p-5 border border-border text-sm text-muted-foreground flex items-start gap-3">
              <Sandwich className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <span>Message Monty on Sunday evening to set up this week's lunch plans.</span>
            </div>
          ) : (
            <div className="space-y-3">
              {lunchByChild.map(({ child, days }) => (
                <div
                  key={child.id}
                  className="bg-card rounded-2xl border border-border px-5 py-4 flex items-center justify-between gap-3"
                >
                  <p className="font-heading font-bold text-foreground text-sm">{child.first_name}</p>
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    {DAYS_ORDER.slice(0, 5).map((d) => {
                      const on = days.map((x) => x.toLowerCase()).includes(d);
                      return (
                        <span
                          key={d}
                          className={`text-[11px] font-semibold px-2 py-1 rounded-full inline-flex items-center gap-1 ${
                            on
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground"
                          }`}
                          title={on ? "Packed lunch" : "School lunch"}
                        >
                          {on ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                          {DAY_SHORT[d]}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
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
