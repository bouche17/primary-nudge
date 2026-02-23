import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAdmin } from "@/hooks/use-admin";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Switch } from "@/components/ui/switch";
import {
  Sparkles,
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  Bell,
} from "lucide-react";

const DAYS_OF_WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const EMOJI_OPTIONS = ["✅", "🏃", "💰", "📚", "📸", "🎨", "🎵", "🍽️", "🏫", "📝", "🔔", "⭐"];

interface Reminder {
  id: string;
  title: string;
  day_of_week: string | null;
  due_date: string | null;
  emoji: string;
  active: boolean;
  sort_order: number;
  school_id: string | null;
}

interface School {
  id: string;
  name: string;
}

const SchoolReminders = () => {
  const { user, loading } = useAuth();
  const { isAdmin, loading: adminLoading } = useAdmin();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [filterSchool, setFilterSchool] = useState<string>("all");

  useEffect(() => {
    if (!loading && !user) navigate("/login");
    if (!loading && !adminLoading && user && !isAdmin) {
      toast({ title: "Access denied", description: "Admin privileges required.", variant: "destructive" });
      navigate("/dashboard");
    }
  }, [user, loading, adminLoading, isAdmin, navigate]);

  const fetchData = async () => {
    const [remindersRes, schoolsRes] = await Promise.all([
      supabase.from("school_reminders").select("*").order("sort_order", { ascending: true }),
      supabase.from("schools").select("id, name").order("name").limit(200),
    ]);
    if (remindersRes.data) setReminders(remindersRes.data as Reminder[]);
    if (schoolsRes.data) setSchools(schoolsRes.data);
  };

  useEffect(() => {
    if (user && isAdmin) fetchData();
  }, [user, isAdmin]);

  const updateField = (id: string, field: keyof Reminder, value: unknown) => {
    setReminders((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
    );
  };

  const saveReminder = async (reminder: Reminder) => {
    setSaving(reminder.id);
    const { error } = await supabase
      .from("school_reminders")
      .update({
        title: reminder.title,
        day_of_week: reminder.day_of_week,
        due_date: reminder.due_date || null,
        emoji: reminder.emoji,
        active: reminder.active,
        sort_order: reminder.sort_order,
        school_id: reminder.school_id,
      })
      .eq("id", reminder.id);
    setSaving(null);
    if (error) {
      toast({ title: "Error saving", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Reminder saved ✓" });
    }
  };

  const addReminder = async () => {
    const maxOrder = reminders.reduce((max, r) => Math.max(max, r.sort_order), 0);
    const schoolId = filterSchool !== "all" && filterSchool !== "global" ? filterSchool : null;
    const { data, error } = await supabase
      .from("school_reminders")
      .insert({
        title: "New reminder",
        emoji: "✅",
        sort_order: maxOrder + 1,
        school_id: schoolId,
      })
      .select()
      .single();
    if (error) {
      toast({ title: "Error adding", description: error.message, variant: "destructive" });
      return;
    }
    setReminders((prev) => [...prev, data as Reminder]);
    toast({ title: "Reminder added" });
  };

  const deleteReminder = async (id: string) => {
    const { error } = await supabase.from("school_reminders").delete().eq("id", id);
    if (error) {
      toast({ title: "Error deleting", description: error.message, variant: "destructive" });
      return;
    }
    setReminders((prev) => prev.filter((r) => r.id !== id));
    toast({ title: "Reminder deleted" });
  };

  const filtered = reminders.filter((r) => {
    if (filterSchool === "all") return true;
    if (filterSchool === "global") return r.school_id === null;
    return r.school_id === filterSchool;
  });

  if (loading || adminLoading) return null;

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

      <main className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-black text-foreground mb-1">
              <Bell className="w-6 h-6 inline-block mr-2 text-primary" />
              School Reminders
            </h1>
            <p className="text-muted-foreground text-sm">Manage reminders Monty sends to parents via WhatsApp.</p>
          </div>
          <Button onClick={addReminder} className="rounded-full font-cta font-semibold">
            <Plus className="w-4 h-4 mr-2" /> Add Reminder
          </Button>
        </div>

        {/* Filter */}
        <div className="mb-6">
          <label className="text-xs font-semibold text-muted-foreground mb-1 block">Filter by school</label>
          <Select value={filterSchool} onValueChange={setFilterSchool}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="All reminders" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reminders</SelectItem>
              <SelectItem value="global">🌐 Global (all schools)</SelectItem>
              {schools.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          {filtered.map((reminder) => {
            const school = schools.find((s) => s.id === reminder.school_id);
            return (
              <div
                key={reminder.id}
                className={`bg-card rounded-2xl border border-border p-5 space-y-4 ${!reminder.active ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{reminder.emoji}</span>
                    <div>
                      <p className="font-heading font-bold text-foreground">{reminder.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {school ? school.name : "🌐 All schools"}
                        {reminder.day_of_week ? ` · Every ${reminder.day_of_week}` : ""}
                        {reminder.due_date ? ` · Due ${reminder.due_date}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={reminder.active}
                      onCheckedChange={(checked) => updateField(reminder.id, "active", checked)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground mb-1 block">Title</label>
                    <Input
                      value={reminder.title}
                      onChange={(e) => updateField(reminder.id, "title", e.target.value)}
                      className="text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground mb-1 block">Day</label>
                    <Select
                      value={reminder.day_of_week || "none"}
                      onValueChange={(v) => updateField(reminder.id, "day_of_week", v === "none" ? null : v)}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No specific day</SelectItem>
                        {DAYS_OF_WEEK.map((d) => (
                          <SelectItem key={d} value={d}>{d}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground mb-1 block">Emoji</label>
                    <Select
                      value={reminder.emoji}
                      onValueChange={(v) => updateField(reminder.id, "emoji", v)}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EMOJI_OPTIONS.map((e) => (
                          <SelectItem key={e} value={e}>{e}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground mb-1 block">School</label>
                    <Select
                      value={reminder.school_id || "global"}
                      onValueChange={(v) => updateField(reminder.id, "school_id", v === "global" ? null : v)}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="global">🌐 All schools</SelectItem>
                        {schools.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm" className="rounded-full">
                        <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this reminder?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove "{reminder.title}" from Monty's reminders.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteReminder(reminder.id)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  <Button
                    size="sm"
                    onClick={() => saveReminder(reminder)}
                    disabled={saving === reminder.id}
                    className="rounded-full font-cta font-semibold"
                  >
                    <Save className="w-3.5 h-3.5 mr-1" />
                    {saving === reminder.id ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <Bell className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No reminders yet. Click "Add Reminder" to create one.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default SchoolReminders;
