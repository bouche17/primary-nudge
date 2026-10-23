import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAdmin } from "@/hooks/use-admin";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { schoolPlace } from "../../supabase/functions/_shared/schoolLabel.ts";

interface Signup {
  event_id: string; created_at: string; kind: string; user_id: string; parent_first_name: string | null;
  child_id: string | null; child_first_name: string | null; year_group: string | null;
  school_name: string | null; school_address: string | null; school_town: string | null; school_postcode: string | null; school_urn: string | null;
  known_school: boolean | null; processed_at: string | null; channel: string | null; delivered: boolean;
}
interface SchoolChange { created_at: string; child_name: string | null; tool: string; change: string; new_school: string | null }

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const alertLabel = (s: Signup) => {
  if (s.channel === "backfilled") return "Before alerts existed";
  if (!s.processed_at) return "Alert waiting";
  if (s.delivered) return "Sent on WhatsApp";
  if (s.channel === "email_pending") return "Not sent: waiting for email (outside WhatsApp window)";
  if (s.channel === "skipped") return "Skipped";
  return `Not sent (${s.channel ?? "unknown"})`;
};

const AdminSignups = () => {
  const { isAdmin, loading } = useAdmin();
  const [rows, setRows] = useState<Signup[]>([]);
  const [changes, setChanges] = useState<SchoolChange[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    supabase.rpc("admin_signups", { _days: 30 }).then(({ data }) => setRows((data as Signup[]) ?? []));
    supabase.rpc("admin_school_changes", { _days: 30 }).then(({ data }) => setChanges((data as SchoolChange[]) ?? []));
  }, [isAdmin]);

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link to="/admin/tests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /> Tests</Link>
        <div>
          <h1 className="text-2xl font-heading font-bold text-foreground">New sign-ups, last 30 days</h1>
          <p className="text-sm text-muted-foreground">Every new parent and child added. "Known school" means Monty already reads that school's calendar.</p>
        </div>
        <div className="bg-card border border-border rounded-2xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary text-left">
              <tr>
                <th className="p-3 font-semibold text-foreground">When</th>
                <th className="p-3 font-semibold text-foreground">Parent</th>
                <th className="p-3 font-semibold text-foreground">Child</th>
                <th className="p-3 font-semibold text-foreground">School</th>
                <th className="p-3 font-semibold text-foreground">Alert</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.event_id} className="border-t border-border align-top">
                  <td className="p-3 text-muted-foreground whitespace-nowrap">{when(s.created_at)}</td>
                  <td className="p-3 text-foreground">{s.parent_first_name ?? "—"}{s.kind === "profile_created" && <span className="block text-xs text-muted-foreground">New account</span>}</td>
                  <td className="p-3 text-foreground">{s.child_first_name ? `${s.child_first_name} (${s.year_group})` : s.child_id ? "Removed since" : "No child yet"}</td>
                  <td className="p-3">
                    {s.school_name ? (
                      <>
                        <span className="text-foreground">{s.school_name}</span>
                        <span className="block text-xs text-muted-foreground">{schoolPlace({ name: s.school_name, address: s.school_address, town: s.school_town, postcode: s.school_postcode })}{s.school_urn ? ` · URN ${s.school_urn}` : ""}</span>
                        <Badge variant={s.known_school ? "secondary" : "destructive"} className="mt-1">{s.known_school ? "Known school" : "New school"}</Badge>
                      </>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">{alertLabel(s)}</td>
                  <td className="p-3 whitespace-nowrap">
                    {s.child_first_name && <Link to={`/family-audit?q=${encodeURIComponent(s.child_first_name)}`} className="text-primary hover:underline">Family audit</Link>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="p-4 text-muted-foreground" colSpan={6}>No sign-ups in the last 30 days.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="bg-card border border-border rounded-2xl overflow-x-auto">
          <h2 className="p-3 font-semibold text-foreground bg-secondary">School changes, last 30 days</h2>
          <table className="w-full text-sm">
            <tbody>
              {changes.map((c, i) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="p-3 text-muted-foreground whitespace-nowrap">{when(c.created_at)}</td>
                  <td className="p-3 text-foreground">{c.child_name ?? "—"}</td>
                  <td className="p-3 text-foreground">{c.change}</td>
                  <td className="p-3 text-xs text-muted-foreground">{c.tool.replace("school_change_", "via ")}</td>
                </tr>
              ))}
              {changes.length === 0 && <tr><td className="p-4 text-muted-foreground">No school changes yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default AdminSignups;
