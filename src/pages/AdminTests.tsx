import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAdmin } from "@/hooks/use-admin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Play, Loader2, AlertTriangle } from "lucide-react";
import DeleteParentPanel from "@/components/DeleteParentPanel";

interface Run {
  id: string; started_at: string; finished_at: string | null; suite: string;
  total: number; passed: number; failed: number; flaky: number; status: string; notes: string | null;
}
interface Result {
  id: string; scenario: string; category: string; status: string; reply: string | null; reason: string | null;
}

const statusVariant = (s: string) =>
  s === "pass" || s === "passed" ? "default" : s === "flaky" ? "secondary" : "destructive";

const AdminTests = () => {
  const { isAdmin, loading } = useAdmin();
  const { toast } = useToast();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const loadRuns = useCallback(async () => {
    const { data } = await supabase.from("test_runs" as any).select("*").order("started_at", { ascending: false }).limit(20);
    const list = (data as unknown as Run[]) ?? [];
    setRuns(list);
    if (list.length && !selected) setSelected(list[0].id);
  }, [selected]);

  useEffect(() => { if (isAdmin) loadRuns(); }, [isAdmin, loadRuns]);

  useEffect(() => {
    if (!selected) return;
    supabase.from("test_run_results" as any).select("*").eq("run_id", selected).order("created_at")
      .then(({ data }) => setResults((data as unknown as Result[]) ?? []));
  }, [selected, refresh]);

  const [alerts, setAlerts] = useState<{ id: string; created_at: string; message: string; alert_type: string }[]>([]);
  const loadAlerts = useCallback(async () => {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { data } = await supabase.from("ops_alerts" as any).select("id, created_at, message, alert_type")
      .eq("is_test", false).is("resolved_at", null).gt("created_at", since).order("created_at", { ascending: false });
    setAlerts((data as any) ?? []);
  }, []);
  useEffect(() => {
    if (!isAdmin) return;
    loadAlerts();
    const t = setInterval(loadAlerts, 60_000);
    return () => clearInterval(t);
  }, [isAdmin, loadAlerts]);
  const resolveAlerts = async () => {
    await supabase.from("ops_alerts" as any).update({ resolved_at: new Date().toISOString() }).in("id", alerts.map((a) => a.id));
    loadAlerts();
  };

  const [progress, setProgress] = useState<string>("");
  const [runningKind, setRunningKind] = useState<"quick" | "full" | null>(null);
  const runSuite = async (kind: "quick" | "full") => {
    setRunning(true); setRunningKind(kind);
    const action = kind === "quick" ? "quick_suite" : "full_suite";
    // The runner works in chunks (sender tests, then a few conversation tests per call).
    let body: Record<string, unknown> = { action, part: "sender" };
    let last: any = null;
    for (let i = 0; i < 40; i++) {
      const { data, error } = await supabase.functions.invoke("monty-test-runner", { body });
      if (error) {
        setRunning(false); setRunningKind(null); setProgress("");
        toast({ title: "Test run stopped", description: error.message, variant: "destructive" });
        loadRuns();
        return;
      }
      last = data;
      setSelected(data.run_id);
      setRefresh((n) => n + 1);
      setProgress(`${data.total} done · ${data.failed} failing`);
      if (!data.next) break;
      body = { action, run_id: data.run_id, ...data.next };
    }
    setRunning(false); setRunningKind(null); setProgress("");
    toast({ title: `Run finished: ${last.passed}/${last.total} passed`, description: `${last.failed} failing · ${last.flaky} flaky · about $${last.cost_usd} of AI` });
    loadRuns();
  };

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link to="/dashboard" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Dashboard
        </Link>
        {alerts.length > 0 && (
          <div role="alert" className="rounded-2xl border border-destructive bg-destructive text-destructive-foreground p-4 space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="w-5 h-5" /> Monty is failing for real parents</div>
              <Button size="sm" variant="secondary" className="rounded-full" onClick={resolveAlerts}>Mark resolved</Button>
            </div>
            {alerts.map((a) => (
              <p key={a.id} className="text-sm">
                {new Date(a.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} — {a.message}
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-heading font-bold text-foreground">Monty test suite</h1>
            <p className="text-sm text-muted-foreground">Runs against test families only. Never sends WhatsApp messages. Quick suite after every change; full suite runs every Sunday at 8pm and before big changes.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => runSuite("quick")} disabled={running} variant="outline" className="rounded-full">
              {runningKind === "quick" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              {runningKind === "quick" ? `Running… ${progress}` : "Run quick suite"}
            </Button>
            <Button onClick={() => runSuite("full")} disabled={running} className="rounded-full">
              {runningKind === "full" ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              {runningKind === "full" ? `Running… ${progress}` : "Run full suite"}
            </Button>
          </div>
        </div>

        <div className="grid md:grid-cols-[240px_1fr] gap-6">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">Recent runs</h2>
            {runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r.id)}
                className={`w-full text-left rounded-xl border p-3 transition-colors ${selected === r.id ? "border-primary bg-secondary" : "border-border bg-card hover:bg-secondary"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {new Date(r.started_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {r.passed}/{r.total} passed{r.failed ? ` · ${r.failed} failed` : ""}{r.flaky ? ` · ${r.flaky} flaky` : ""}
                </p>
              </button>
            ))}
          </div>

          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary text-left">
                <tr>
                  <th className="p-3 font-semibold text-foreground">Scenario</th>
                  <th className="p-3 font-semibold text-foreground">Result</th>
                  <th className="p-3 font-semibold text-foreground">Monty would send / reason</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="p-3 text-foreground">
                      {r.scenario}
                      <div className="text-xs text-muted-foreground">{r.category}</div>
                    </td>
                    <td className="p-3"><Badge variant={statusVariant(r.status)}>{r.status}</Badge></td>
                    <td className="p-3">
                      {r.reply && <p className="text-foreground whitespace-pre-line">{r.reply}</p>}
                      {r.reason && <p className="text-destructive text-xs mt-1">{r.reason}</p>}
                      {!r.reply && !r.reason && <span className="text-muted-foreground">(no message)</span>}
                    </td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr><td colSpan={3} className="p-6 text-center text-muted-foreground">Pick a run to see its results.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <DeleteParentPanel />
      </div>
    </div>
  );
};

export default AdminTests;
