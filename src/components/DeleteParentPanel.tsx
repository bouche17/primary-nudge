import { useState } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Trash2 } from "lucide-react";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DeleteParentPanel = () => {
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const body = () => { const v = who.trim(); return UUID.test(v) ? { user_id: v } : { phone: v }; };
  const call = async (confirm: boolean) => {
    setBusy(true); setErr(null);
    const { data, error } = await supabase.functions.invoke("delete-parent", { body: { ...body(), confirm } });
    setBusy(false);
    if (error) { setErr(error instanceof FunctionsHttpError ? await error.context.text() : error.message); return; }
    if (confirm) { setDone(data); setPreview(null); } else { setPreview(data); setDone(null); }
  };

  const rows = (r: Record<string, number>) => Object.entries(r ?? {});
  return (
    <div className="mt-10 rounded-lg border border-destructive/40 p-5">
      <h2 className="font-semibold text-lg flex items-center gap-2"><Trash2 className="w-5 h-5" /> Delete parent</h2>
      <p className="text-sm text-muted-foreground mt-1">Phone number (+44…) or user id. Preview first; nothing is deleted until you confirm.</p>
      <div className="flex gap-2 mt-3">
        <Input value={who} onChange={(e) => { setWho(e.target.value); setPreview(null); setDone(null); }} placeholder="+447700900123 or user id" />
        <Button variant="outline" disabled={busy || !who.trim()} onClick={() => call(false)}>{busy && !preview ? <Loader2 className="w-4 h-4 animate-spin" /> : "Preview"}</Button>
      </div>
      {err && <p className="text-sm text-destructive mt-3 break-all">{err}</p>}
      {preview && (
        <div className="mt-4 text-sm space-y-2">
          <p>Account found: {preview.user_found ? "yes" : "no"} · login exists: {preview.auth_user_exists ? "yes" : "no"} · linked partner: {preview.has_partner ? "yes (shared children kept)" : "no"}</p>
          <table className="w-full"><tbody>
            {rows(preview.rows).map(([t, n]) => <tr key={t} className="border-t"><td className="py-1">{t}</td><td className="text-right">{n}</td></tr>)}
            <tr className="border-t"><td className="py-1">Twilio messages</td><td className="text-right">{String(preview.twilio_messages)}</td></tr>
          </tbody></table>
          {preview.kept && <p className="text-muted-foreground">Kept: {preview.kept}.</p>}
          <Button variant="destructive" disabled={busy} onClick={() => call(true)}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete everything shown"}</Button>
        </div>
      )}
      {done && (
        <div className="mt-4 text-sm">
          <p className="font-medium">Deleted. Login removed: {done.auth_user_deleted ? "yes" : "no"} · Twilio messages deleted: {done.twilio?.deleted ?? 0}{done.twilio?.failed ? ` (${done.twilio.failed} failed)` : ""}</p>
          <ul className="mt-2">{rows(done.rows).map(([t, n]) => <li key={t}>{t}: {n}</li>)}</ul>
        </div>
      )}
    </div>
  );
};

export default DeleteParentPanel;
