// Monty regression test runner (admin-only).
// Stage 1: reminder-sender tests + read-only comparison of real reminders vs the frozen legacy build.
// Never sends WhatsApp messages: all sender calls go through the secret-gated dry-run/stub entry point.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getTestPhones } from "../_shared/testGuard.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEST_SECRET = Deno.env.get("MONTY_TEST_SECRET")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const TEST_SCHOOL_ID = "f59ecba1-7f2c-4777-8434-9d81db5c70ca"; // no holidays/reminders/children
const TEST_EMAIL_DOMAIN = "@monty-test.invalid";
const FAMILY_A_PHONE = "+447000000001";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function requireAdmin(req: Request): Promise<string | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: role } = await admin.from("user_roles").select("role")
    .eq("user_id", data.user.id).eq("role", "admin").maybeSingle();
  return role ? data.user.id : null;
}

async function callFn(name: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, "x-monty-test-secret": TEST_SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: { raw: text } }; }
}

// ── Test-family fixtures (only ever touches allowlisted phones + @monty-test.invalid users) ──

async function testUserIds(): Promise<string[]> {
  const allow = await getTestPhones();
  const { data: profs } = await admin.from("profiles").select("user_id, phone_number").in("phone_number", [...allow]);
  const ids: string[] = [];
  for (const p of profs ?? []) {
    const { data } = await admin.auth.admin.getUserById(p.user_id);
    if (data.user?.email?.endsWith(TEST_EMAIL_DOMAIN)) ids.push(p.user_id); // both conditions required
  }
  return ids;
}

async function resetTestData() {
  const allow = [...(await getTestPhones())];
  const ids = await testUserIds();
  if (ids.length) {
    const { data: kids } = await admin.from("children").select("id").in("parent_id", ids);
    const kidIds = (kids ?? []).map((k) => k.id);
    if (kidIds.length) {
      await admin.from("child_reminders").delete().in("child_id", kidIds);
      await admin.from("weekly_lunch_plans").delete().in("child_id", kidIds);
      await admin.from("event_exclusions").delete().in("child_id", kidIds);
      await admin.from("children").delete().in("id", kidIds);
    }
  }
  if (allow.length) {
    await admin.from("parent_notes").delete().in("phone_number", allow);
    await admin.from("reminder_log").delete().in("phone_number", allow);
  }
}

async function ensureTestUser(phone: string): Promise<string> {
  const email = `family${phone.slice(-2)}${TEST_EMAIL_DOMAIN}`;
  const { data: existing } = await admin.from("profiles").select("user_id").eq("phone_number", phone).maybeSingle();
  if (existing) return existing.user_id;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  await admin.from("profiles").upsert({ user_id: data.user.id, phone_number: phone }, { onConflict: "user_id" });
  return data.user.id;
}

async function seedSenderFixtures() {
  const parentId = await ensureTestUser(FAMILY_A_PHONE);
  const { data: child, error } = await admin.from("children")
    .insert({ parent_id: parentId, school_id: TEST_SCHOOL_ID, first_name: "Harry", year_group: "Year 3" })
    .select("id").single();
  if (error) throw new Error(`seed child failed: ${error.message}`);
  const r = (title: string, emoji: string, day: string, extra: Record<string, unknown> = {}) =>
    ({ child_id: child.id, parent_id: parentId, title, emoji, day_of_week: day, reminder_time: "both", active: true, recurrence_interval: 1, ...extra });
  const { error: rErr } = await admin.from("child_reminders").insert([
    r("PE kit", "👟", "Tuesday"),
    r("Gymnastics", "🤸", "Saturday"),
    r("Swimming", "🏊", "Sunday"),
    r("Forest School", "🌳", "Thursday", { recurrence_interval: 2, anchor_date: "2026-10-08" }),
  ]);
  if (rErr) throw new Error(`seed reminders failed: ${rErr.message}`);
  const { error: nErr } = await admin.from("parent_notes").insert({
    phone_number: FAMILY_A_PHONE, raw_content: "Harry has gymnastics at 8am", summary: "Harry has gymnastics at 8am",
    extracted_dates: [{ date: "2026-10-07" }], source_type: "whatsapp", child_name: "Harry",
  });
  if (nErr) throw new Error(`seed note failed: ${nErr.message}`);
}

// ── Sender scenarios ──

interface SenderCase {
  name: string; period: "morning" | "evening"; now: string;
  expectTarget: string; expect: string[] | null; // null = expect no message
}

const SENDER_CASES: SenderCase[] = [
  { name: "Weekday morning (Tue 6 Oct, 7am BST)", period: "morning", now: "2026-10-06T06:00:00Z", expectTarget: "2026-10-06", expect: ["👟 Harry has *PE kit* today"] },
  { name: "Weekday evening (Tue 6 Oct, 6pm BST) covers Wednesday note", period: "evening", now: "2026-10-06T17:00:00Z", expectTarget: "2026-10-07", expect: ["📝 Harry has gymnastics at 8am tomorrow"] },
  { name: "Note sent after 6pm appears in next morning (Wed 7 Oct)", period: "morning", now: "2026-10-07T06:00:00Z", expectTarget: "2026-10-07", expect: ["📝 Harry has gymnastics at 8am today"] },
  { name: "Friday evening covers Saturday item", period: "evening", now: "2026-10-09T17:00:00Z", expectTarget: "2026-10-10", expect: ["🤸 Harry has *Gymnastics* tomorrow"] },
  { name: "Fortnightly on-week (Thu 8 Oct)", period: "morning", now: "2026-10-08T06:00:00Z", expectTarget: "2026-10-08", expect: ["Harry has Forest School today — they'll need their outdoor kit"] },
  { name: "Fortnightly off-week (Thu 15 Oct)", period: "morning", now: "2026-10-15T06:00:00Z", expectTarget: "2026-10-15", expect: null },
  { name: "Clock change: Sat 24 Oct 6pm BST covers Sunday 25", period: "evening", now: "2026-10-24T17:00:00Z", expectTarget: "2026-10-25", expect: ["🏊 Harry has *Swimming* tomorrow"] },
  { name: "Clock change: Sun 25 Oct 7am GMT", period: "morning", now: "2026-10-25T07:00:00Z", expectTarget: "2026-10-25", expect: ["🏊 Harry has *Swimming* today"] },
  { name: "Clock change: Mon 26 Oct 7am GMT (nothing due)", period: "morning", now: "2026-10-26T07:00:00Z", expectTarget: "2026-10-26", expect: null },
  { name: "UK date: 23:30 UTC Sat 24 Oct is already Sun 25 in BST", period: "morning", now: "2026-10-24T23:30:00Z", expectTarget: "2026-10-25", expect: ["🏊 Harry has *Swimming* today"] },
  { name: "UK date: 23:30 UTC Sun 25 Oct is still Sun 25 in GMT", period: "morning", now: "2026-10-25T23:30:00Z", expectTarget: "2026-10-25", expect: ["🏊 Harry has *Swimming* today"] },
];

type Result = { scenario: string; category: string; status: "pass" | "fail" | "flaky"; reply: string | null; reason: string | null; details?: unknown };

async function runSenderSuite(): Promise<Result[]> {
  const results: Result[] = [];
  for (const c of SENDER_CASES) {
    const { status, data } = await callFn("send-reminders", {
      scenario: c.name, period: c.period, now: c.now, scope: "test", only_phones: [FAMILY_A_PHONE],
    });
    const msgs: string[] = (data.messages ?? []).map((m: any) => m.message);
    const reply = msgs[0] ?? null;
    let reason: string | null = null;
    if (status !== 200) reason = `HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`;
    else if (data.target_date !== c.expectTarget) reason = `target date ${data.target_date}, expected ${c.expectTarget}`;
    else if (c.expect === null && msgs.length > 0) reason = `expected no message, got: ${reply}`;
    else if (c.expect !== null) {
      if (msgs.length !== 1) reason = `expected 1 message, got ${msgs.length}`;
      else if (reply !== c.expect.join(" | ")) reason = `expected "${c.expect.join(" | ")}", got "${reply}"`;
    }
    results.push({ scenario: c.name, category: "sender", status: reason ? "fail" : "pass", reply, reason, details: { now: c.now, period: c.period } });
  }

  // Double-send guard: stub-send twice for the same slot; second must be blocked. Never calls Twilio.
  const first = await callFn("send-reminders", { scenario: "double-send #1", period: "morning", now: "2026-10-06T06:00:00Z", scope: "test", only_phones: [FAMILY_A_PHONE], stub_send: true });
  const second = await callFn("send-reminders", { scenario: "double-send #2", period: "morning", now: "2026-10-06T06:00:00Z", scope: "test", only_phones: [FAMILY_A_PHONE], stub_send: true });
  const d1 = first.data.delivered?.length ?? -1, d2 = second.data.delivered?.length ?? -1;
  const b2 = second.data.blocked?.length ?? 0;
  const ok = d1 === 1 && d2 === 0;
  results.push({
    scenario: "Double-send guard blocks a second run for the same slot", category: "sender",
    status: ok ? "pass" : "fail", reply: first.data.delivered?.[0]?.message ?? null,
    reason: ok ? null : `first run delivered ${d1}, second delivered ${d2} (blocked ${b2})`,
    details: { first: first.data, second: second.data },
  });

  // Safety: the entry point must refuse a real (non-allowlisted) number.
  const refused = await callFn("send-reminders", { scenario: "safety: real number refused", period: "morning", scope: "test", only_phones: ["+447700900123"] });
  results.push({
    scenario: "Test entry point refuses a non-test phone number", category: "safety",
    status: refused.status === 403 ? "pass" : "fail", reply: null,
    reason: refused.status === 403 ? null : `expected 403, got ${refused.status}`,
  });
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const adminId = await requireAdmin(req);
  if (!adminId) return json({ error: "Admin only" }, 403);
  const body = await req.json().catch(() => ({}));
  const action = body.action ?? "sender_suite";

  if (action === "compare_real") {
    // Read-only: build what tonight's evening run would produce, new code vs frozen legacy code.
    const now = typeof body.now === "string" ? body.now : new Date().toISOString();
    const req2 = { scenario: "stage1 real comparison", period: body.period === "morning" ? "morning" : "evening", now, ignore_sent_log: true };
    const [neu, old] = await Promise.all([
      callFn("send-reminders", { ...req2, scope: "real_readonly" }),
      callFn("legacy-reminders-dryrun", req2),
    ]);
    const key = (m: any) => `${m.phone_last4}::${m.message}`;
    const a = (neu.data.messages ?? []).map(key).sort();
    const b = (old.data.messages ?? []).map(key).sort();
    const identical = JSON.stringify(a) === JSON.stringify(b);
    return json({ now, identical, new_count: a.length, old_count: b.length,
      only_in_new: a.filter((x: string) => !b.includes(x)), only_in_old: b.filter((x: string) => !a.includes(x)),
      messages: neu.data.messages, status: { new: neu.status, old: old.status } });
  }

  // sender_suite
  const { data: run } = await admin.from("test_runs").insert({ suite: "sender", triggered_by: adminId }).select("id").single();
  let results: Result[] = [];
  let fatal: string | null = null;
  try {
    await resetTestData();
    await seedSenderFixtures();
    results = await runSenderSuite();
  } catch (e) {
    fatal = (e as Error).message;
  } finally {
    await resetTestData();
  }
  if (fatal) results.push({ scenario: "Suite setup", category: "setup", status: "fail", reply: null, reason: fatal });
  if (results.length) {
    await admin.from("test_run_results").insert(results.map((r) => ({ run_id: run!.id, ...r, details: r.details ?? null })));
  }
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const flaky = results.filter((r) => r.status === "flaky").length;
  await admin.from("test_runs").update({
    finished_at: new Date().toISOString(), total: results.length, passed, failed, flaky,
    status: failed ? "failed" : "passed", notes: "Stage 1: reminder sender suite (no AI calls, no sends)",
  }).eq("id", run!.id);
  return json({ run_id: run!.id, total: results.length, passed, failed, flaky, results });
});
