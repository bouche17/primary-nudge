// Admin-only full "delete parent": dry-run preview per table, then delete everything for one person
// across all tables + auth user + Twilio message logs. Families: shared children stay with the remaining
// partner; reminders/lunch plans the person created on those children are reassigned, not deleted.
// Leaves a deletion_audit row with no personal data (hashed phone + counts).
// The opted_out_numbers row is deliberately KEPT so Monty never messages the number again.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SID = Deno.env.get("TWILIO_ACCOUNT_SID")!, TOK = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TW = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
const twAuth = { Authorization: "Basic " + btoa(`${SID}:${TOK}`) };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9]\d{6,14}$/;

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(req: Request): Promise<boolean> {
  const runnerToken = req.headers.get("x-runner-token");
  if (runnerToken && runnerToken.length >= 32) {
    const { data } = await admin.from("test_runner_tokens").delete().eq("token_hash", await sha256Hex(runnerToken))
      .gt("expires_at", new Date().toISOString()).select("token_hash");
    return !!data && data.length === 1;
  }
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return false;
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
  return !!role;
}

// ── Twilio message logs ──
async function listTwilio(phone: string): Promise<string[]> {
  const sids = new Set<string>();
  for (const dir of ["To", "From"]) {
    let url: string | null = `${TW}/Messages.json?${dir}=${encodeURIComponent(`whatsapp:${phone}`)}&PageSize=1000`;
    let pages = 0;
    while (url && pages++ < 20) {
      const res = await fetch(url, { headers: twAuth });
      if (!res.ok) throw new Error(`Twilio list ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      for (const m of j.messages ?? []) sids.add(m.sid);
      url = j.next_page_uri ? `https://api.twilio.com${j.next_page_uri}` : null;
    }
  }
  return [...sids];
}
async function deleteTwilio(sids: string[], deadline: number) {
  let deleted = 0, failed = 0; const errors: string[] = [];
  for (let i = 0; i < sids.length && Date.now() < deadline; i += 10) {
    await Promise.all(sids.slice(i, i + 10).map(async (sid) => {
      const r = await fetch(`${TW}/Messages/${sid}.json`, { method: "DELETE", headers: twAuth });
      if (r.status === 204 || r.status === 404) deleted++; else { failed++; if (errors.length < 3) errors.push(`${r.status} ${(await r.text()).slice(0, 120)}`); }
    }));
  }
  return { deleted, failed, errors, remaining: Math.max(0, sids.length - deleted - failed) };
}

type Op = { table: string; label?: string; kind: "delete" | "reassign"; apply: (q: any) => any; set?: Record<string, unknown> };

async function count(op: Op): Promise<number> {
  const { count: c, error } = await op.apply(admin.from(op.table).select("*", { count: "exact", head: true }));
  if (error) throw new Error(`${op.table}: ${error.message}`);
  return c ?? 0;
}
async function run(op: Op): Promise<number> {
  const q = op.kind === "delete" ? admin.from(op.table).delete({ count: "exact" }) : admin.from(op.table).update(op.set!, { count: "exact" });
  const { count: c, error } = await op.apply(q);
  if (error) throw new Error(`${op.label ?? op.table}: ${error.message}`);
  return c ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!(await requireAdmin(req))) return json({ error: "Admin only" }, 403);
  const deadline = Date.now() + 120_000;
  const b = await req.json().catch(() => ({}));
  let phone: string | null = typeof b.phone === "string" && b.phone.trim() ? b.phone.replace(/^whatsapp:/, "").replace(/[\s\-()]/g, "") : null;
  let userId: string | null = typeof b.user_id === "string" && b.user_id.trim() ? b.user_id.trim() : null;
  const confirm = b.confirm === true;
  const doTwilio = b.twilio !== false;
  if (!phone && !userId) return json({ error: "Give a phone number or a user id" }, 400);
  if (phone && !PHONE.test(phone)) return json({ error: "Phone must look like +447700900123" }, 400);
  if (userId && !UUID.test(userId)) return json({ error: "User id must be a UUID" }, 400);

  // Resolve the other identifier (profile first, then onboarding_state for already-deleted accounts).
  if (!userId && phone) {
    const { data: p } = await admin.from("profiles").select("user_id").eq("phone_number", phone).maybeSingle();
    userId = p?.user_id ?? null;
    if (!userId) { const { data: o } = await admin.from("onboarding_state").select("user_id").eq("phone_number", phone).not("user_id", "is", null).limit(1); userId = o?.[0]?.user_id ?? null; }
  }
  if (!phone && userId) {
    const { data: p } = await admin.from("profiles").select("phone_number").eq("user_id", userId).maybeSingle();
    phone = p?.phone_number ?? null;
    if (!phone) { const { data: o } = await admin.from("onboarding_state").select("phone_number").eq("user_id", userId).limit(1); phone = o?.[0]?.phone_number ?? null; }
  }
  // Safety: if the number now belongs to a DIFFERENT live account (re-registered), never touch phone-keyed data.
  let phoneInUseByOther = false;
  if (phone && userId) {
    const { data: live } = await admin.from("profiles").select("user_id").eq("phone_number", phone);
    phoneInUseByOther = (live ?? []).some((p) => p.user_id !== userId);
  }
  const phoneScoped = !!phone && !phoneInUseByOther;
  const phones = phone ? [phone, `whatsapp:${phone}`] : [];

  const ops: Op[] = [];
  const reassigned: Record<string, number> = {};
  let partnerId: string | null = null;

  if (userId) {
    const uid = userId;
    const { data: links } = await admin.from("linked_accounts").select("primary_user_id, linked_user_id").eq("status", "accepted")
      .or(`primary_user_id.eq.${uid},linked_user_id.eq.${uid}`);
    partnerId = (links ?? []).map((l) => l.primary_user_id === uid ? l.linked_user_id : l.primary_user_id).find((x) => x && x !== uid) ?? null;

    const { data: ownKids } = await admin.from("children").select("id").eq("parent_id", uid);
    const ownKidIds = (ownKids ?? []).map((k) => k.id);
    // Rows this person created; decide per row: reassign to the child's (remaining) parent or delete with the child.
    for (const table of ["child_reminders", "weekly_lunch_plans"]) {
      const { data: rows } = await admin.from(table).select("id, child_id").eq("parent_id", uid);
      const childIds = [...new Set((rows ?? []).map((r: any) => r.child_id))];
      const { data: kids } = childIds.length ? await admin.from("children").select("id, parent_id").in("id", childIds) : { data: [] as any[] };
      const owner = new Map((kids ?? []).map((k: any) => [k.id, k.parent_id]));
      const byTarget = new Map<string, string[]>(); const del: string[] = [];
      for (const r of rows ?? []) {
        const childOwner = owner.get((r as any).child_id);
        const target = childOwner && childOwner !== uid ? childOwner : partnerId;
        if (target) { if (!byTarget.has(target)) byTarget.set(target, []); byTarget.get(target)!.push((r as any).id); }
        else if (!ownKidIds.includes((r as any).child_id)) del.push((r as any).id); // own children's rows go with the children below
      }
      for (const [target, ids] of byTarget) ops.push({ table, label: `${table} → remaining parent`, kind: "reassign", set: { parent_id: target }, apply: (q) => q.in("id", ids) });
      if (del.length) ops.push({ table, kind: "delete", apply: (q) => q.in("id", del) });
    }
    if (ownKidIds.length) {
      if (partnerId) ops.push({ table: "children", label: "children → partner (shared, kept)", kind: "reassign", set: { parent_id: partnerId }, apply: (q) => q.in("id", ownKidIds) });
      else {
        for (const t of ["child_reminders", "weekly_lunch_plans", "event_exclusions"]) ops.push({ table: t, label: `${t} (children deleted)`, kind: "delete", apply: (q) => q.in("child_id", ownKidIds) });
        ops.push({ table: "children", kind: "delete", apply: (q) => q.in("id", ownKidIds) });
      }
    }
    ops.push(
      { table: "lunch_checkin_log", kind: "delete", apply: (q) => q.eq("parent_id", uid) },
      { table: "consent_records", kind: "delete", apply: (q) => q.eq("user_id", uid) },
      { table: "invite_tokens", kind: "delete", apply: (q) => q.eq("inviter_user_id", uid) },
      { table: "linked_accounts", kind: "delete", apply: (q) => q.or(`primary_user_id.eq.${uid},linked_user_id.eq.${uid}`) },
      { table: "pending_family_updates", kind: "delete", apply: (q) => q.or(`actor_user_id.eq.${uid},family_key.eq.${uid}`) },
      { table: "user_roles", kind: "delete", apply: (q) => q.eq("user_id", uid) },
      { table: "onboarding_state", label: "onboarding_state (by user)", kind: "delete", apply: (q) => phoneScoped ? q.eq("user_id", uid).neq("phone_number", phone) : q.eq("user_id", uid) },
      { table: "test_runs", label: "test_runs (who-ran cleared)", kind: "reassign", set: { triggered_by: null }, apply: (q) => q.eq("triggered_by", uid) },
      { table: "profiles", kind: "delete", apply: (q) => q.eq("user_id", uid) },
    );
  }
  let convoIds: string[] = [];
  if (phoneScoped) {
    const { data: convos } = await admin.from("conversations").select("id").in("phone_number", phones);
    convoIds = (convos ?? []).map((c) => c.id);
    if (convoIds.length) ops.push({ table: "messages", kind: "delete", apply: (q) => q.in("conversation_id", convoIds) });
    for (const t of ["conversations", "parent_notes", "reminder_log", "dedup_decisions", "message_send_failures", "onboarding_state", "message_delivery_status", "failed_inbound", "test_entry_audit"])
      ops.push({ table: t, label: t === "onboarding_state" ? "onboarding_state (by phone)" : t, kind: "delete", apply: (q) => q.in("phone_number", phones) });
    ops.push({ table: "ops_alerts", label: "ops_alerts mentioning them", kind: "delete", apply: (q) => q.ilike("message", `%${phone}%`) });
  }

  let authExists = false;
  if (userId) { const { data } = await admin.auth.admin.getUserById(userId); authExists = !!data?.user; }

  try {
    if (!confirm) {
      const preview: Record<string, number> = {};
      for (const op of ops) { const n = await count(op); if (n) preview[op.label ?? op.table] = (preview[op.label ?? op.table] ?? 0) + n; }
      let twilio: number | string = "skipped";
      if (doTwilio && phoneScoped) { try { twilio = (await listTwilio(phone)).length; } catch (e) { twilio = `error: ${(e as Error).message}`; } }
      return json({ mode: "preview", user_found: !!userId, auth_user_exists: authExists, has_partner: !!partnerId, phone_in_use_by_another_account: phoneInUseByOther, phone_last4: phone?.slice(-4) ?? null,
        rows: preview, twilio_messages: twilio, kept: phoneInUseByOther ? "phone-keyed data and Twilio logs (the number now belongs to another live account)" : phone ? "any opted-out record for this number, so Monty never messages it again" : null });
    }

    const counts: Record<string, number> = {};
    for (const op of ops) { const n = await run(op); if (n) counts[op.label ?? op.table] = (counts[op.label ?? op.table] ?? 0) + n; }
    let authDeleted = false;
    if (userId && authExists) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`auth user: ${error.message}`);
      authDeleted = true;
    }
    let tw = { deleted: 0, failed: 0, errors: [] as string[], remaining: 0, found: 0 };
    if (doTwilio && phoneScoped) { const sids = await listTwilio(phone); tw = { ...(await deleteTwilio(sids, deadline)), found: sids.length }; }
    const salt = Deno.env.get("DELETION_AUDIT_SALT") ?? "";
    await admin.from("deletion_audit").insert({
      phone_hash: phone ? await sha256Hex(salt + phone) : null, row_counts: counts, twilio_deleted: tw.deleted, auth_user_deleted: authDeleted,
      kind: b.kind === "leftovers" ? "leftovers" : b.kind === "twilio_only" ? "twilio_only" : "full",
    });
    return json({ mode: "deleted", rows: counts, auth_user_deleted: authDeleted, twilio: tw });
  } catch (e) {
    console.error("[delete-parent]", (e as Error).message);
    return json({ error: "Deletion did not complete", details: (e as Error).message }, 500);
  }
});
