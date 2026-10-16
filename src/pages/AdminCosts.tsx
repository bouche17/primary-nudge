import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAdmin } from "@/hooks/use-admin";
import { ArrowLeft } from "lucide-react";

interface Row { created_at: string; function_name: string; purpose: string; family_id: string | null; model: string | null; input_tokens: number; output_tokens: number; cost_usd: number; is_test: boolean }

const usd = (n: number) => `$${n.toFixed(2)}`;
function group(rows: Row[], key: (r: Row) => string) {
  const m = new Map<string, { cost: number; calls: number }>();
  for (const r of rows) { const k = key(r); const g = m.get(k) ?? { cost: 0, calls: 0 }; g.cost += Number(r.cost_usd); g.calls++; m.set(k, g); }
  return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
}

function Table({ title, rows, sortByKey }: { title: string; rows: [string, { cost: number; calls: number }][]; sortByKey?: boolean }) {
  const list = sortByKey ? [...rows].sort((a, b) => b[0].localeCompare(a[0])) : rows;
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <h2 className="p-3 font-semibold text-foreground bg-secondary">{title}</h2>
      <table className="w-full text-sm">
        <tbody>
          {list.map(([k, v]) => (
            <tr key={k} className="border-t border-border">
              <td className="p-3 text-foreground">{k}</td>
              <td className="p-3 text-muted-foreground">{v.calls} calls</td>
              <td className="p-3 text-right font-medium text-foreground">{usd(v.cost)}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td className="p-4 text-muted-foreground">Nothing recorded yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const AdminCosts = () => {
  const { isAdmin, loading } = useAdmin();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (!isAdmin) return;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    supabase.from("ai_costs").select("created_at, function_name, purpose, family_id, model, input_tokens, output_tokens, cost_usd, is_test")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(10000)
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [isAdmin]);

  const real = useMemo(() => rows.filter((r) => !r.is_test), [rows]);
  const tests = useMemo(() => rows.filter((r) => r.is_test), [rows]);
  const day = (r: Row) => new Date(r.created_at).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const total = (rs: Row[]) => rs.reduce((a, r) => a + Number(r.cost_usd), 0);

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/dashboard" replace />;
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link to="/admin/tests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /> Tests</Link>
        <div>
          <h1 className="text-2xl font-heading font-bold text-foreground">AI costs, last 30 days</h1>
          <p className="text-sm text-muted-foreground">Estimated from tokens at list price. Parents: {usd(total(real))} · Tests: {usd(total(tests))}</p>
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          <Table title="Parents — per day" rows={group(real, day)} sortByKey />
          <Table title="Parents — per purpose" rows={group(real, (r) => r.purpose)} />
          <Table title="Parents — per family" rows={group(real, (r) => r.family_id ? r.family_id.slice(0, 8) : "unknown / school-wide")} />
          <Table title="Tests — per day" rows={group(tests, day)} sortByKey />
        </div>
      </div>
    </div>
  );
};
export default AdminCosts;
