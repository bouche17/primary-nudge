import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAdmin } from "@/hooks/use-admin";
import { ArrowLeft } from "lucide-react";

interface Row {
  id: string; received_at: string; subject: string | null; message: string | null; year_groups: string[]; opt_in: boolean;
  event_title: string | null; event_date: string | null; families_count: number; phones_count: number; is_test: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

const AdminSchoolEmails = () => {
  const { isAdmin, loading } = useAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [showTests, setShowTests] = useState(false);
  useEffect(() => {
    if (!isAdmin) return;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    supabase.from("school_email_log").select("id, received_at, subject, message, year_groups, opt_in, event_title, event_date, families_count, phones_count, is_test")
      .gte("received_at", since).order("received_at", { ascending: false }).limit(500)
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [isAdmin]);

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  const list = (rows ?? []).filter((r) => showTests || !r.is_test);
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link to="/admin/tests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /> Tests</Link>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-heading font-bold text-foreground">School emails, last 30 days</h1>
            <p className="text-sm text-muted-foreground">What Monty sent parents for each school email. Messages to each family start with their child's name.</p>
          </div>
          <label className="text-sm text-muted-foreground flex items-center gap-2">
            <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} /> Show test runs
          </label>
        </div>
        {rows === null && <p className="text-muted-foreground">Loading…</p>}
        {rows !== null && list.length === 0 && <p className="text-muted-foreground">No school emails in the last 30 days.</p>}
        <div className="space-y-3">
          {list.map((r) => (
            <div key={r.id} className="bg-card border border-border rounded-2xl p-4 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-foreground">{r.subject || "(no subject)"}</span>
                {r.opt_in && <span className="px-2 py-0.5 rounded-full bg-accent text-accent-foreground text-xs">Opt-in</span>}
                {r.is_test && <span className="px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs">Test</span>}
                <span className="ml-auto text-muted-foreground">{when(r.received_at)}</span>
              </div>
              <p className="text-sm text-foreground">{r.message}</p>
              <p className="text-xs text-muted-foreground">
                {r.year_groups?.length ? r.year_groups.join(", ") : "all"} · {r.families_count} {r.families_count === 1 ? "family" : "families"}, {r.phones_count} {r.phones_count === 1 ? "phone" : "phones"}
                {r.event_title ? ` · Event: ${r.event_title}${r.event_date ? ` on ${r.event_date}` : ""}` : ""}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
export default AdminSchoolEmails;
