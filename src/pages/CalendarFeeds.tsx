import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAdmin } from "@/hooks/use-admin";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sparkles,
  ArrowLeft,
  Plus,
  Trash2,
  RefreshCw,
  Calendar,
  Loader2,
} from "lucide-react";

interface CalendarFeed {
  id: string;
  school_id: string | null;
  feed_url: string;
  label: string;
  last_synced_at: string | null;
  created_at: string;
  school_name?: string;
}

const CalendarFeeds = () => {
  const { user, loading } = useAuth();
  const { isAdmin, loading: adminLoading } = useAdmin();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate("/login");
    if (!loading && !adminLoading && user && !isAdmin) {
      toast({ title: "Access denied", variant: "destructive" });
      navigate("/dashboard");
    }
  }, [user, loading, adminLoading, isAdmin, navigate]);

  const fetchFeeds = async () => {
    const { data, error } = await supabase
      .from("school_calendar_feeds")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) {
      toast({ title: "Error loading feeds", description: error.message, variant: "destructive" });
      return;
    }
    setFeeds(data || []);
  };

  useEffect(() => {
    if (user && isAdmin) fetchFeeds();
  }, [user, isAdmin]);

  const addFeed = async () => {
    if (!newUrl.trim()) return;
    setAdding(true);
    const { error } = await supabase.from("school_calendar_feeds").insert({
      feed_url: newUrl.trim(),
      label: newLabel.trim() || "School Calendar",
    });
    setAdding(false);
    if (error) {
      toast({ title: "Error adding feed", description: error.message, variant: "destructive" });
    } else {
      setNewUrl("");
      setNewLabel("");
      toast({ title: "Feed added ✓" });
      fetchFeeds();
    }
  };

  const deleteFeed = async (id: string) => {
    const { error } = await supabase.from("school_calendar_feeds").delete().eq("id", id);
    if (error) {
      toast({ title: "Error deleting feed", description: error.message, variant: "destructive" });
    } else {
      setFeeds((prev) => prev.filter((f) => f.id !== id));
      toast({ title: "Feed removed" });
    }
  };

  const syncAll = async () => {
    setSyncing(true);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(
        `https://${projectId}.supabase.co/functions/v1/sync-calendar`,
        { method: "POST" }
      );
      const data = await res.json();
      toast({ title: "Sync complete", description: data.message });
      fetchFeeds();
    } catch (err) {
      toast({ title: "Sync failed", description: String(err), variant: "destructive" });
    }
    setSyncing(false);
  };

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

      <main className="max-w-2xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-black text-foreground mb-1">
              <Calendar className="w-6 h-6 inline-block mr-2 -mt-1" />
              Calendar Feeds
            </h1>
            <p className="text-muted-foreground text-sm">
              Add iCal / Google Calendar URLs. Monty will serve live events to parents.
            </p>
          </div>
          <Button onClick={syncAll} disabled={syncing} className="rounded-full font-cta font-semibold">
            {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Sync Now
          </Button>
        </div>

        {/* Add new feed */}
        <div className="bg-card rounded-2xl border border-border p-5 mb-6 space-y-3">
          <p className="text-sm font-semibold text-foreground">Add a calendar feed</p>
          <div className="flex gap-2">
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Label (e.g. Reception Calendar)"
              className="w-48 text-sm"
            />
            <Input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://calendar.google.com/...ical"
              className="flex-1 text-sm font-mono"
            />
            <Button onClick={addFeed} disabled={adding || !newUrl.trim()} size="sm" className="rounded-full">
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
        </div>

        {/* Feed list */}
        <div className="space-y-3">
          {feeds.map((feed) => (
            <div
              key={feed.id}
              className="bg-card rounded-2xl border border-border px-5 py-4 flex items-center justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="font-heading font-bold text-foreground text-sm">{feed.label}</p>
                <p className="text-xs text-muted-foreground font-mono truncate">{feed.feed_url}</p>
                {feed.last_synced_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last synced: {new Date(feed.last_synced_at).toLocaleString("en-GB")}
                  </p>
                )}
              </div>
              <button
                onClick={() => deleteFeed(feed.id)}
                className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {feeds.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-sm">No calendar feeds yet. Add an iCal URL above to get started.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default CalendarFeeds;
