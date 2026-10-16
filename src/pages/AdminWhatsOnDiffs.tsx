import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAdmin } from "@/hooks/use-admin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Play } from "lucide-react";

interface Diff { id: string; run_date: string; family_id: string; family_label: string | null; item_date: string; item: string; side: string; likely_reason: string | null; verdict: string | null }
const VERDICTS = [["old_wrong", "Old was wrong"], ["new_wrong", "New was wrong"], ["fine", "Fine"]] as const;

const AdminWhatsOnDiffs = () => {
  const { isAdmin, loading } = useAdmin();
  const { toast } = useToast();
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [runDate, setRunDate] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    const { data: latest } = await supabase.from("whats_on_shadow_diffs").select("run_date").order("run_date", { ascending: false }).limit(1);
    const d = latest?.[0]?.run_date ?? null;
    setRunDate(d);
    if (!d) { setDiffs([]); return; }
    const { data } = await supabase.from("whats_on_shadow_diffs").select("*").eq("run_date", d).order("item_date").limit(2000);
    setDiffs((data as Diff[]) ?? []);
  }, []);
  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  const byFamily = useMemo(() => {
    const m = new Map<string, Diff[]>();
    for (const d of diffs) { const k = d.family_label || d.family_id.slice(0, 8); m.set(k, [...(m.get(k) ?? []), d]); }
    return [...m.entries()];
  }, [diffs]);

  const setVerdict = async (id: string, verdict: string) => {
    await supabase.from("whats_on_shadow_diffs").update({ verdict, verdict_at: new Date().toISOString() }).eq("id", id);
    setDiffs((ds) => ds.map((d) => (d.id === id ? { ...d, verdict } : d)));
  };
  const runNow = async () => {
    setRunning(true);
    const { data, error } = await supabase.functions.invoke("monty-test-runner", { body: { action: "whats_on_shadow" } });
    setRunning(false);
    if (error) toast({ title: "Comparison failed", description: error.message, variant: "destructive" });
    else toast({ title: `Compared ${data.families} families`, description: `${data.differences} differences` });
    load();
  };

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link to="/admin/tests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /> Tests</Link>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-heading font-bold text-foreground">What's on: old vs new</h1>
            <p className="text-sm text-muted-foreground">Nightly at 9pm. Next 14 days, old reminders (not sent) vs the new shared list. Only differences are shown. {runDate ? `Latest run: ${runDate}` : "No runs yet."}</p>
          </div>
          <Button onClick={runNow} disabled={running} variant="outline" className="rounded-full">
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />} Run comparison now
          </Button>
        </div>
        {byFamily.map(([fam, list]) => (
          <div key={fam} className="bg-card border border-border rounded-2xl overflow-hidden">
            <h2 className="p-3 font-semibold text-foreground bg-secondary">{fam} <span className="text-muted-foreground font-normal">· {list.length}</span></h2>
            <table className="w-full text-sm">
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} className="border-t border-border align-top">
                    <td className="p-3 whitespace-nowrap text-foreground">{new Date(d.item_date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</td>
                    <td className="p-3"><Badge variant={d.side === "different" ? "secondary" : "outline"}>{d.side}</Badge></td>
                    <td className="p-3 text-foreground">{d.item}<div className="text-xs text-muted-foreground mt-1">{d.likely_reason}</div></td>
                    <td className="p-3">
                      <div className="flex gap-1 flex-wrap">
                        {VERDICTS.map(([v, label]) => (
                          <Button key={v} size="sm" variant={d.verdict === v ? "default" : "ghost"} className="rounded-full h-7 px-2 text-xs" onClick={() => setVerdict(d.id, v)}>{label}</Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
};
export default AdminWhatsOnDiffs;
