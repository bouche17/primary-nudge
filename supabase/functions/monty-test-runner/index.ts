// Monty regression test runner (admin-only).
// Reminder-sender tests + conversation scenarios.
// Never sends WhatsApp messages: all sender calls go through the secret-gated dry-run/stub entry point.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getTestPhones } from "../_shared/testGuard.ts";
import { evaluateClaudeAlerts, evaluateDeliveryAlerts } from "../_shared/alerts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEST_SECRET = Deno.env.get("MONTY_TEST_SECRET")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const TEST_SCHOOL_ID = "f59ecba1-7f2c-4777-8434-9d81db5c70ca"; // no holidays/reminders/children
const TEST_EMAIL_DOMAIN = "@monty-test.invalid";
const FAMILY_A_PHONE = "+447000000001";

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(req: Request): Promise<string | null> {
  // Backend-issued single-use token (inserted directly into test_runner_tokens by someone with DB access).
  const runnerToken = req.headers.get("x-runner-token");
  if (runnerToken && runnerToken.length >= 32) {
    const hash = await sha256Hex(runnerToken);
    const { data } = await admin.from("test_runner_tokens").delete()
      .eq("token_hash", hash).gt("expires_at", new Date().toISOString()).select("token_hash");
    if (data && data.length === 1) return "backend-token";
    return null;
  }
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
    await admin.from("failed_inbound").delete().in("phone_number", allow);
    await admin.from("message_send_failures").delete().in("phone_number", allow).eq("function_name", "whatsapp-webhook");
    const { data: convos } = await admin.from("conversations").select("id").in("phone_number", allow);
    const convoIds = (convos ?? []).map((c) => c.id);
    if (convoIds.length) {
      await admin.from("messages").delete().in("conversation_id", convoIds);
      await admin.from("conversations").delete().in("id", convoIds);
    }
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

// Simulated alert bursts from fake NON-test numbers. Rows are tagged with a test-only function_name,
// the alert send is stubbed (nothing leaves the system) and everything is deleted afterwards.
const SIM_FN = "alert-sim-test";
const SIM_PHONES = ["+447999000101", "+447999000102", "+447999000103", "+447999000104"];
async function runAlertTests(): Promise<Result[]> {
  const out: Result[] = [];
  const cleanup = async () => {
    await admin.from("message_send_failures").delete().eq("function_name", SIM_FN);
    await admin.from("ops_alerts").delete().eq("is_test", true);
  };
  await cleanup();
  try {
    const sends: string[] = [];
    const stub = async (t: string) => { sends.push(t); return { ok: true, channel: "stub" }; };
    const credit = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } });
    const counts: number[] = [];
    for (const ph of SIM_PHONES) {
      await admin.from("message_send_failures").insert({ function_name: SIM_FN, phone_number: ph, status_code: 400, error_body: credit, context: "Claude API - initial reply" });
      await evaluateClaudeAlerts({ functionName: SIM_FN, isTest: true, send: stub });
      counts.push(sends.length);
    }
    const { data: rows } = await admin.from("ops_alerts").select("alert_type, affected_parents, message").eq("is_test", true);
    const reason = firstFail(JSON.stringify(counts) !== "[0,0,1,1]" && `alerts after each failure: ${JSON.stringify(counts)} (want [0,0,1,1])`,
      (rows ?? []).length !== 1 && `ops_alerts rows: ${(rows ?? []).length}`, !/console\.anthropic\.com/.test(sends[0] || "") && "alert lacks the fix",
      !/3 parents affected/.test(sends[0] || "") && "alert lacks the affected-parent count");
    out.push({ scenario: "3 simulated credit failures from a non-test family → exactly one alert (4th throttled)", category: "alerts", status: reason ? "fail" : "pass", reply: sends[0] ?? null, reason });

    await cleanup(); sends.length = 0;
    const dCounts: number[] = [];
    for (const ph of SIM_PHONES.slice(0, 3)) {
      await admin.from("message_send_failures").insert({ function_name: SIM_FN, phone_number: ph, status_code: null,
        error_body: JSON.stringify({ MessageStatus: "undelivered", ErrorCode: "63016", ErrorMessage: null }), context: "Async delivery failure (Twilio status callback), MessageSid: SMsim" });
      await evaluateDeliveryAlerts({ functionName: SIM_FN, isTest: true, send: stub });
      dCounts.push(sends.length);
    }
    const r2 = firstFail(JSON.stringify(dCounts) !== "[0,0,1]" && `alerts: ${JSON.stringify(dCounts)}`, !/24-hour window/.test(sends[0] || "") && "no likely fix");
    out.push({ scenario: "3 failed WhatsApp deliveries to real parents within an hour → one alert", category: "alerts", status: r2 ? "fail" : "pass", reply: sends[0] ?? null, reason: r2 });

    // Delivery-status endpoint: signed request is recorded, unsigned/invalid are 403.
    {
      const base = `${SUPABASE_URL}/functions/v1/twilio-status-callback?source=monty-test`;
      const sid = `SMtest${Date.now()}`;
      const form: Record<string, string> = { MessageSid: sid, MessageStatus: "undelivered", To: "whatsapp:+447000000001", ErrorCode: "63016", ErrorMessage: "test" };
      let data = base; for (const k of Object.keys(form).sort()) data += k + form[k];
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("TWILIO_AUTH_TOKEN")!), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
      const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
      const post = (h: Record<string, string>) => fetch(base, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...h }, body: new URLSearchParams(form).toString() });
      const signed = await post({ "X-Twilio-Signature": sig }); await signed.text();
      const unsigned = await post({}); await unsigned.text();
      const bad = await post({ "X-Twilio-Signature": "bm90LXZhbGlk" }); await bad.text();
      const { data: rec } = await admin.from("message_delivery_status").select("status, error_code").eq("message_sid", sid);
      const { data: fail } = await admin.from("message_send_failures").select("id").like("context", `%${sid}%`);
      await admin.from("message_delivery_status").delete().eq("message_sid", sid);
      await admin.from("message_send_failures").delete().like("context", `%${sid}%`);
      const r3 = firstFail(signed.status !== 200 && `signed → ${signed.status}`, unsigned.status !== 403 && `unsigned → ${unsigned.status}`, bad.status !== 403 && `bad signature → ${bad.status}`,
        !(rec?.length === 1 && rec[0].status === "undelivered" && rec[0].error_code === "63016") && `status not recorded: ${JSON.stringify(rec)}`, fail?.length !== 1 && "failure not logged");
      out.push({ scenario: "Twilio status callback: signed → recorded (200), unsigned/invalid → 403", category: "safety", status: r3 ? "fail" : "pass",
        reply: `signed ${signed.status}, unsigned ${unsigned.status}, bad signature ${bad.status}, recorded ${JSON.stringify(rec)}`, reason: r3 });
    }

    // Test numbers never count.
    await cleanup(); sends.length = 0;
    for (const ph of ["+447000000001", "+447000000002", "+447000000003"]) {
      await admin.from("message_send_failures").insert({ function_name: SIM_FN, phone_number: ph, status_code: 400, error_body: credit, context: "Claude API - initial reply" });
    }
    await evaluateClaudeAlerts({ functionName: SIM_FN, isTest: true, send: stub });
    out.push({ scenario: "Credit failures from test numbers never trigger an alert", category: "alerts", status: sends.length ? "fail" : "pass", reply: null, reason: sends.length ? "alerted on test numbers" : null });
  } finally { await cleanup(); }
  return out;
}

async function runSenderSuite(): Promise<Result[]> {
  const results: Result[] = [...(await runAlertTests())];
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

// ── Handler scenarios (real AI, dry run, never Twilio) ──

const FAMILIES: Record<string, { phone: string; kids: { name: string; year: string }[] }> = {
  A: { phone: "+447000000001", kids: [{ name: "Jude", year: "Year 6" }, { name: "Harry", year: "Year 3" }] },
  B: { phone: "+447000000002", kids: [{ name: "Rosa", year: "Year 4" }, { name: "Tom", year: "Year 2" }] },
  C: { phone: "+447000000003", kids: [{ name: "Mila", year: "Year 5" }] },
};
const REAL_CONVERSATION_ID = "21634d6e-1eda-4198-b9be-5b8b1d716d54"; // read-only source for the replay test
const SYSTEM_WORDS = /NOT SAVED|POSSIBLE_DUPLICATE|ALREADY_SAVED|PENDING|TIMING|WAITING_FOR_PARENT|CONFIRM_STORED|ungrounded|tool_result|child_name|recurrence_interval/i;

type Msg = { role: "user" | "assistant"; content: string; at: string };
interface Seed {
  reminders?: { child: string; title: string; day: string }[];
  notes?: { child: string | null; summary: string; date: string }[];
  lunches?: { child: string; days: string[]; week: string }[];
  history?: Msg[];
  realHistory?: { from: string; to: string };
}
interface Step { message: string; now?: string; fail_db?: boolean; fail_followup?: boolean; fail_claude?: boolean }
interface Rows {
  notes: { child: string | null; summary: string; dates: string[] }[];
  reminders: { child: string; title: string; day: string; interval: number; anchor: string | null }[];
  lunches: { child: string; days: string[]; week: string }[];
  pending: unknown;
  inactive: number;
  failedInbound: number;
  inbound: number;
}
interface HandlerCase {
  name: string; family: keyof typeof FAMILIES; now: string; seed?: Seed; steps: Step[];
  check: (after: Rows[], replies: string[]) => string | null;
}

async function seedFamily(fam: keyof typeof FAMILIES, seed: Seed = {}) {
  const f = FAMILIES[fam];
  const parentId = await ensureTestUser(f.phone);
  const { data: kids, error } = await admin.from("children")
    .insert(f.kids.map((k) => ({ parent_id: parentId, school_id: TEST_SCHOOL_ID, first_name: k.name, year_group: k.year })))
    .select("id, first_name");
  if (error) throw new Error(`seed children failed: ${error.message}`);
  const id = (n: string) => kids!.find((k) => k.first_name === n)!.id;
  if (seed.reminders?.length) {
    const { error: e } = await admin.from("child_reminders").insert(seed.reminders.map((r) => ({
      child_id: id(r.child), parent_id: parentId, title: r.title, emoji: "📌", day_of_week: r.day, reminder_time: "both", active: true, recurrence_interval: 1,
    })));
    if (e) throw new Error(`seed reminders: ${e.message}`);
  }
  if (seed.notes?.length) {
    const { error: e } = await admin.from("parent_notes").insert(seed.notes.map((n) => ({
      phone_number: f.phone, raw_content: n.summary, summary: n.summary, extracted_dates: [{ date: n.date }], source_type: "whatsapp", child_name: n.child,
    })));
    if (e) throw new Error(`seed notes: ${e.message}`);
  }
  if (seed.lunches?.length) {
    const { error: e } = await admin.from("weekly_lunch_plans").insert(seed.lunches.map((l) => ({
      child_id: id(l.child), parent_id: parentId, week_start: l.week, packed_lunch_days: l.days,
    })));
    if (e) throw new Error(`seed lunches: ${e.message}`);
  }
  let history: Msg[] = seed.history ?? [];
  if (seed.realHistory) {
    // Copy (read-only) the real conversation's messages into the TEST number's own conversation.
    const { data: real } = await admin.from("messages").select("direction, content, created_at")
      .eq("conversation_id", REAL_CONVERSATION_ID).gte("created_at", seed.realHistory.from).lt("created_at", seed.realHistory.to)
      .order("created_at");
    history = (real ?? []).map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.content, at: m.created_at }));
    if (!history.length) throw new Error("real history copy found no messages");
  }
  if (history.length) {
    const { data: convo, error: ce } = await admin.from("conversations").insert({ phone_number: f.phone, current_step: "active" }).select("id").single();
    if (ce) throw new Error(`seed conversation: ${ce.message}`);
    await admin.from("messages").insert(history.map((m) => ({
      conversation_id: convo.id, direction: m.role === "user" ? "inbound" : "outbound", content: m.content, created_at: m.at,
    })));
  }
}

async function familyRows(fam: keyof typeof FAMILIES): Promise<Rows> {
  const f = FAMILIES[fam];
  const ids = await testUserIds();
  const { data: kids } = await admin.from("children").select("id, first_name").in("parent_id", ids);
  const kidIds = (kids ?? []).map((k) => k.id);
  const nameOf = (id: string) => kids?.find((k) => k.id === id)?.first_name ?? "?";
  const [notes, rems, lunches, convo, inact, fin] = await Promise.all([
    admin.from("parent_notes").select("child_name, summary, extracted_dates").eq("phone_number", f.phone),
    kidIds.length ? admin.from("child_reminders").select("child_id, title, day_of_week, recurrence_interval, anchor_date").eq("active", true).in("child_id", kidIds) : Promise.resolve({ data: [] as any[] }),
    kidIds.length ? admin.from("weekly_lunch_plans").select("child_id, packed_lunch_days, week_start").in("child_id", kidIds) : Promise.resolve({ data: [] as any[] }),
    admin.from("conversations").select("context").eq("phone_number", f.phone).maybeSingle(),
    kidIds.length ? admin.from("child_reminders").select("id", { count: "exact", head: true }).eq("active", false).in("child_id", kidIds) : Promise.resolve({ count: 0 } as any),
    admin.from("failed_inbound").select("id", { count: "exact", head: true }).eq("phone_number", f.phone),
  ]);
  const convoRow = await admin.from("conversations").select("id").eq("phone_number", f.phone).maybeSingle();
  const inb = convoRow.data ? await admin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convoRow.data.id).eq("direction", "inbound") : { count: 0 } as any;
  return {
    notes: (notes.data ?? []).map((n: any) => ({ child: n.child_name, summary: n.summary ?? "", dates: (n.extracted_dates ?? []).map((d: any) => d.date) })),
    reminders: (rems.data ?? []).map((r: any) => ({ child: nameOf(r.child_id), title: r.title, day: r.day_of_week, interval: r.recurrence_interval, anchor: r.anchor_date })),
    lunches: (lunches.data ?? []).map((l: any) => ({ child: nameOf(l.child_id), days: [...(l.packed_lunch_days ?? [])].sort(), week: l.week_start })),
    pending: (convo.data as any)?.context?.pending_action ?? null,
    inactive: (inact as any).count ?? 0,
    failedInbound: (fin as any).count ?? 0,
    inbound: (inb as any).count ?? 0,
  };
}

// ── check helpers ──
const total = (r: Rows) => r.notes.length + r.reminders.length + r.lunches.filter((l) => l.days.length).length;
const noteFor = (r: Rows, child: string | null, date: string, re: RegExp) =>
  r.notes.filter((n) => (child === null || n.child === child || n.child === null) && n.dates.includes(date) && re.test(n.summary));
const remFor = (r: Rows, child: string, day: string, re: RegExp) => r.reminders.filter((x) => x.child === child && x.day === day && re.test(x.title));
const lunchDays = (r: Rows, child: string, week: string) => r.lunches.find((l) => l.child === child && l.week === week)?.days ?? [];
const asks = (reply: string) => reply.includes("?");
const claimsSaved = (reply: string) => /\b(saved|done|added|sorted|noted|got (it|that) down)\b/i.test(reply);
const eq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const firstFail = (...xs: (string | null | false)[]) => (xs.find((x) => typeof x === "string") as string | undefined) ?? null;
const peThu = (r: Rows, child: string) => noteFor(r, child, "2026-10-08", /pe/i).length + remFor(r, child, "Thursday", /pe/i).length;

const MON = "2026-10-05T18:17:00Z";      // Mon 5 Oct 19:17 BST
const MON_AM = "2026-10-05T08:00:00Z";   // Mon 5 Oct 09:00 BST
const WK = "2026-10-05";
const OLD_GYM_HISTORY: Msg[] = [
  { role: "user", content: "Harry has gymnastics at 8am tomorrow morning", at: "2026-09-30T07:40:00Z" },
  { role: "assistant", content: "Saved: Harry has gymnastics at 8am on Thursday 1 October ✅", at: "2026-09-30T07:40:10Z" },
  { role: "user", content: "Jude needs a packed lunch on Friday", at: "2026-09-30T07:41:00Z" },
  { role: "assistant", content: "Saved: packed lunch for Jude on Friday ✅", at: "2026-09-30T07:41:10Z" },
];
const PE_WED = "Jude needs a PE kit just for this Wednesday";
const oneJudePeWed = (r: Rows) => {
  if (r.reminders.length || r.lunches.some((l) => l.days.length)) return `unexpected reminder/lunch rows: ${JSON.stringify(r)}`;
  if (r.notes.length !== 1) return `expected 1 note, got ${r.notes.length}: ${JSON.stringify(r.notes)}`;
  const n = r.notes[0];
  if (n.child !== "Jude" || !n.dates.includes("2026-10-07") || !/pe/i.test(n.summary)) return `wrong note: ${JSON.stringify(n)}`;
  return null;
};

const HANDLER_CASES: HandlerCase[] = [
  // ── history / grounding ──
  { name: "Old 'gymnastics tomorrow' in history + unrelated new message → nothing re-saved", family: "A", now: MON,
    seed: { history: OLD_GYM_HISTORY }, steps: [{ message: "Thanks Monty, that's brilliant" }],
    check: ([r], [reply]) => firstFail(total(r) > 0 && `expected no saves, got ${JSON.stringify(r)}`, /gymnastic/i.test(reply) && "reply mentions old gymnastics") },
  { name: "'Jude needs a PE kit just for this Wednesday' on a Monday (old history) → one Jude note for Wed", family: "A", now: MON,
    seed: { history: OLD_GYM_HISTORY }, steps: [{ message: PE_WED }],
    check: ([r], [reply]) => firstFail(oneJudePeWed(r), /gymnastic|packed lunch/i.test(reply) && "reply mentions old requests",
      /let me|i'll save|now saving/i.test(reply) && "reply announces a future action",
      /remind you/i.test(reply) && "confirmation explains reminder timing") },
  { name: "Real history replay (Matt, 29 Sep–5 Oct) → PE kit Wednesday saves exactly one Jude note", family: "A", now: MON,
    seed: { realHistory: { from: "2026-09-29T00:00:00Z", to: "2026-10-05T18:17:30Z" } }, steps: [{ message: PE_WED }],
    check: ([r], [reply]) => firstFail(oneJudePeWed(r), /gymnastic|packed lunch/i.test(reply) && "reply mentions old requests") },
  { name: "Message needing two saves → both saved, reply confirms both", family: "A", now: MON,
    steps: [{ message: "Harry has swimming every Monday, and Jude needs his recorder this Friday" }],
    check: ([r], [reply]) => firstFail(
      remFor(r, "Harry", "Monday", /swim/i).length !== 1 && `no Harry swimming Monday reminder: ${JSON.stringify(r.reminders)}`,
      noteFor(r, "Jude", "2026-10-09", /recorder/i).length !== 1 && `no Jude recorder note 9 Oct: ${JSON.stringify(r.notes)}`,
      !(/swim/i.test(reply) && /recorder/i.test(reply)) && "reply doesn't confirm both",
      /(already|has) (gone|passed)|won't (get|go)/i.test(reply) && "reply has a negative timing line") },
  // ── weekly reminders ──
  { name: "New weekly reminder", family: "A", now: MON, steps: [{ message: "Harry has football club every Tuesday" }],
    check: ([r]) => firstFail(remFor(r, "Harry", "Tuesday", /football/i).length !== 1 && `rows: ${JSON.stringify(r.reminders)}`, r.reminders.length !== 1 && "extra reminders saved") },
  { name: "Multi-day activity including Saturday", family: "A", now: MON, steps: [{ message: "Jude has gymnastics on Wednesdays and Saturdays" }],
    check: ([r]) => firstFail(remFor(r, "Jude", "Wednesday", /gym/i).length !== 1 && "no Wednesday", remFor(r, "Jude", "Saturday", /gym/i).length !== 1 && `no Saturday: ${JSON.stringify(r.reminders)}`) },
  { name: "Sunday reminder", family: "A", now: MON, steps: [{ message: "Harry has swimming lessons every Sunday" }],
    check: ([r]) => remFor(r, "Harry", "Sunday", /swim/i).length !== 1 ? `rows: ${JSON.stringify(r.reminders)}` : null },
  { name: "Fortnightly with a confirmed date", family: "A", now: MON, steps: [{ message: "Harry has Forest School every other Thursday, the next one is 8th October" }],
    check: ([r]) => {
      const x = remFor(r, "Harry", "Thursday", /forest/i);
      return firstFail(x.length !== 1 && `rows: ${JSON.stringify(r.reminders)}`, x[0] && x[0].interval !== 2 && "not fortnightly",
        x[0] && x[0].anchor !== "2026-10-08" && `anchor ${x[0]?.anchor}`, x[0] && /fortnight|every other/i.test(x[0].title) && "frequency in title");
    } },
  { name: "'Every other Friday' with no date → asks for the next date, saves nothing", family: "A", now: MON, steps: [{ message: "Jude has cooking club every other Friday" }],
    check: ([r], [reply]) => firstFail(r.reminders.length > 0 && `saved without anchor: ${JSON.stringify(r.reminders)}`, !asks(reply) && "didn't ask a question", !/when|date|next/i.test(reply) && "didn't ask for the next date") },
  { name: "Exact duplicate weekly reminder → no second row", family: "A", now: MON,
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }] }, steps: [{ message: "Harry needs his PE kit every Tuesday" }],
    check: ([r]) => remFor(r, "Harry", "Tuesday", /pe/i).length !== 1 ? `PE rows: ${JSON.stringify(r.reminders)}` : null },
  { name: "Same day, different activity → both kept", family: "A", now: MON,
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }] }, steps: [{ message: "Harry has football club on Tuesdays too" }],
    check: ([r]) => firstFail(remFor(r, "Harry", "Tuesday", /football/i).length !== 1 && "no football", remFor(r, "Harry", "Tuesday", /pe/i).length !== 1 && `PE changed: ${JSON.stringify(r.reminders)}`) },
  ...[1, 2, 3, 4, 5].map((n): HandlerCase => ({ name: `PE kit moved Tuesday→Wednesday (repeat ${n}/5)`, family: "A", now: MON,
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }] }, steps: [{ message: "Harry's PE kit has moved from Tuesday to Wednesday" }],
    check: ([r], [reply]) => firstFail(remFor(r, "Harry", "Wednesday", /pe/i).length !== 1 && `no Wednesday PE: ${JSON.stringify(r.reminders)}`,
      remFor(r, "Harry", "Tuesday", /pe/i).length > 0 && "Tuesday PE still active", r.reminders.length !== 1 && `extra rows: ${JSON.stringify(r.reminders)}`,
      r.inactive > 0 && "old row deactivated instead of moved (second row created)", !/harry/i.test(reply) || !/wednesday/i.test(reply) ? `reply: "${reply}"` : null) })),
  { name: "'Harry's PE is now on Wednesdays instead' (no old day named) → the one PE reminder moves", family: "A", now: MON,
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }, { child: "Harry", title: "Swimming kit", day: "Friday" }] },
    steps: [{ message: "Harry's PE is now on Wednesdays instead" }],
    check: ([r]) => firstFail(remFor(r, "Harry", "Wednesday", /pe/i).length !== 1 && `rows: ${JSON.stringify(r.reminders)}`, remFor(r, "Harry", "Tuesday", /pe/i).length > 0 && "Tuesday still active",
      r.reminders.length !== 2 && `row count: ${JSON.stringify(r.reminders)}`, r.inactive > 0 && "second row created", remFor(r, "Harry", "Friday", /swim/i).length !== 1 && "swimming touched") },
  { name: "Move with two matching reminders (PE Tue + Thu) → asks which, nothing changed", family: "A", now: MON,
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }, { child: "Harry", title: "PE kit", day: "Thursday" }] },
    steps: [{ message: "Harry's PE has moved to Wednesday" }],
    check: ([r], [q]) => firstFail(!(asks(q) && /tuesday/i.test(q) && /thursday/i.test(q)) && `didn't ask naming both: "${q}"`,
      remFor(r, "Harry", "Wednesday", /pe/i).length > 0 && "moved without asking", r.reminders.length !== 2 && `rows: ${JSON.stringify(r.reminders)}`) },
  // ── which child / clarification ──
  { name: "No child named, 2 children → asks which child, then 'Jude' saves for Jude", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "Jude" }, { message: "every week" }],
    check: ([r1, r2, r3], [q, q2, a]) => firstFail(total(r1) > 0 && `saved before asking: ${JSON.stringify(r1)}`, !(asks(q) && /jude/i.test(q) && /harry/i.test(q) && /every thursday/i.test(q)) && `didn't ask child + one-off/weekly together: "${q}"`,
      total(r2) > 0 && "saved before one-off/weekly was answered", !/every thursday/i.test(q2) && `didn't ask one-off or weekly: "${q2}"`, /harry/i.test(q2) && "re-asked which child",
      remFor(r3, "Jude", "Thursday", /pe/i).length !== 1 && `Jude weekly not saved: ${JSON.stringify(r3)}`, peThu(r3, "Harry") > 0 && "also saved for Harry",
      !/jude/i.test(a) && "confirmation doesn't name Jude", r3.pending !== null && "pending not cleared") },
  { name: "Combined question, full answer 'Jude, every week' → one Jude weekly reminder", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "Jude, every week" }],
    check: ([r1, r2], [q, a]) => firstFail(total(r1) > 0 && "saved before asking", !(/jude/i.test(q) && /harry/i.test(q) && /every thursday/i.test(q)) && `not one combined question: "${q}"`,
      remFor(r2, "Jude", "Thursday", /pe/i).length !== 1 && `Jude weekly missing: ${JSON.stringify(r2)}`, peThu(r2, "Harry") > 0 && "saved for Harry", r2.notes.length > 0 && "dated note saved too",
      asks(a) && `asked again: "${a}"`, r2.pending !== null && "pending not cleared") },
  { name: "Combined question, partial answer 'every week' → asks only which child, then 'Harry' saves", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "every week" }, { message: "Harry" }],
    check: ([, r2, r3], [, q2, a]) => firstFail(total(r2) > 0 && `saved with no child: ${JSON.stringify(r2)}`, !(asks(q2) && /harry/i.test(q2) && /jude/i.test(q2)) && `didn't ask which child: "${q2}"`,
      /every thursday|just/i.test(q2) && "re-asked one-off/weekly", remFor(r3, "Harry", "Thursday", /pe/i).length !== 1 && `Harry weekly missing: ${JSON.stringify(r3)}`,
      peThu(r3, "Jude") > 0 && "saved for Jude", asks(a) && `asked again: "${a}"`) },
  { name: "Combined question, 'both, every week' → weekly for both", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "both, every week" }],
    check: ([, r2]) => firstFail(remFor(r2, "Jude", "Thursday", /pe/i).length !== 1 && `Jude: ${JSON.stringify(r2)}`, remFor(r2, "Harry", "Thursday", /pe/i).length !== 1 && "Harry missing", r2.notes.length > 0 && "dated notes saved") },
  { name: "Reply 'both' to which-child → saved for both", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "both" }, { message: "just this once" }],
    check: (rs) => {
      const r1 = rs[0], last = rs[rs.length - 1];
      return firstFail(total(r1) > 0 && "saved before asking", peThu(last, "Jude") < 1 && `Jude missing: ${JSON.stringify(last)}`, peThu(last, "Harry") < 1 && "Harry missing");
    } },
  { name: "Parent changes topic instead of answering → pending dropped, not re-asked", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "What time do the morning reminders come through?" }],
    check: ([r1, r2], [, a]) => firstFail(total(r2) > 0 && `saved something: ${JSON.stringify(r2)}`, /is that for|which child|harry or jude|jude or harry/i.test(a) && "re-asked which child", r2.pending !== null && "pending not cleared") },
  { name: "Pending question expires after 24 hours", family: "A", now: MON,
    steps: [{ message: "Needs PE kit Thursday" }, { message: "Jude", now: "2026-10-06T19:30:00Z" }],
    check: ([, r2]) => peThu(r2, "Jude") > 0 ? "saved from an expired question" : null },
  { name: "One-child family → never asks which child (asks one-off or weekly, then saves)", family: "C", now: MON, steps: [{ message: "PE kit on Thursday" }, { message: "every week" }],
    check: ([r1, r2], [q]) => firstFail(/which child|who is (that|it) for|is that for/i.test(q) && "asked which child",
      !(peThu(r1, "Mila") >= 1 || /every thursday/i.test(q)) && `neither saved nor asked one-off/weekly: "${q}"`, peThu(r2, "Mila") < 1 && `not saved for Mila: ${JSON.stringify(r2)}`) },
  { name: "'Both kids have non-uniform day Friday' → saved for all children, no question", family: "A", now: MON,
    steps: [{ message: "Both kids have non-uniform day on Friday" }],
    check: ([r], [reply]) => firstFail(noteFor(r, "Jude", "2026-10-09", /uniform/i).length < 1 && `Jude missing: ${JSON.stringify(r.notes)}`, noteFor(r, "Harry", "2026-10-09", /uniform/i).length < 1 && "Harry missing", /which child|is that for/i.test(reply) && "asked which child") },
  { name: "Note for two named children", family: "A", now: MON, steps: [{ message: "Harry and Jude both have a school trip to the farm on Friday" }],
    check: ([r]) => firstFail(noteFor(r, "Jude", "2026-10-09", /trip|farm/i).length < 1 && `Jude missing: ${JSON.stringify(r.notes)}`, noteFor(r, "Harry", "2026-10-09", /trip|farm/i).length < 1 && "Harry missing") },
  { name: "Pronoun 'She needs her swim bag tomorrow' (Rosa has weekly swimming) → names Rosa, already on the list", family: "B", now: MON,
    seed: { reminders: [{ child: "Rosa", title: "Swimming kit", day: "Tuesday" }], history: [
      { role: "user", content: "Rosa has swimming on Tuesdays", at: "2026-10-05T17:00:00Z" },
      { role: "assistant", content: "Done — saved Rosa's swimming kit every Tuesday ✅", at: "2026-10-05T17:00:10Z" },
    ] },
    steps: [{ message: "She needs her swim bag tomorrow" }, { message: "yes" }],
    check: ([r1, r2], [q, a]) => {
      const onList = (r: Rows, reply: string) => r.notes.length === 0 && r.reminders.length === 1 && /already/i.test(reply) && /rosa/i.test(reply);
      if (onList(r1, q)) return null; // went straight to "already on the list"
      return firstFail(total(r1) > 1 && `saved before confirming: ${JSON.stringify(r1)}`, !(asks(q) && /rosa/i.test(q)) && "didn't propose Rosa",
        r2.notes.length > 0 && `saved a duplicate note: ${JSON.stringify(r2.notes)}`, r2.reminders.length !== 1 && `reminders: ${JSON.stringify(r2.reminders)}`,
        !(/already/i.test(a) && /rosa/i.test(a) && /swim/i.test(a)) && `didn't say it's already on the list: "${a}"`);
    } },
  { name: "'Same again next week' → proposes the recorder, 'yes' saves next Friday", family: "A", now: MON,
    seed: { notes: [{ child: "Jude", summary: "Jude needs her recorder", date: "2026-10-09" }], history: [
      { role: "user", content: "Jude needs her recorder this Friday", at: "2026-10-05T17:00:00Z" },
      { role: "assistant", content: "Done — saved Jude needs her recorder on Friday 9 October ✅", at: "2026-10-05T17:00:10Z" },
    ] },
    steps: [{ message: "Same again next week" }, { message: "yes" }],
    check: ([r1, r2], [q]) => firstFail(r1.notes.length !== 1 && `saved before confirming: ${JSON.stringify(r1.notes)}`, !(asks(q) && /recorder/i.test(q)) && "didn't propose the recorder",
      noteFor(r2, "Jude", "2026-10-16", /recorder/i).length !== 1 && `not saved for 16 Oct: ${JSON.stringify(r2.notes)}`) },
  // ── dated notes ──
  { name: "After-6pm note for tomorrow", family: "A", now: MON, steps: [{ message: "Harry has a dentist appointment at 9am tomorrow" }],
    check: ([r], [reply]) => firstFail(noteFor(r, "Harry", "2026-10-06", /dentist/i).length !== 1 && `rows: ${JSON.stringify(r.notes)}`, /won't|already (gone|passed)|after 6/i.test(reply) && "negative timing line") },
  { name: "Gymnastics on a day with PE kit already saved → not 'already saved'", family: "A", now: MON,
    seed: { notes: [{ child: "Harry", summary: "Harry needs PE kit", date: "2026-10-07" }] }, steps: [{ message: "Harry has gymnastics at 8am on Wednesday" }],
    check: ([r], [reply]) => firstFail(noteFor(r, "Harry", "2026-10-07", /gym/i).length + remFor(r, "Harry", "Wednesday", /gym/i).length < 1 && !/every wednesday/i.test(reply) && `gymnastics neither saved nor asked: ${JSON.stringify(r)}`, /already/i.test(reply) && "claimed already saved") },
  { name: "Rosa's gymnastics not treated as PE kit", family: "B", now: MON,
    seed: { reminders: [{ child: "Rosa", title: "PE kit", day: "Thursday" }] }, steps: [{ message: "Rosa has gymnastics club on Thursdays" }],
    check: ([r]) => firstFail(remFor(r, "Rosa", "Thursday", /gym/i).length !== 1 && `rows: ${JSON.stringify(r.reminders)}`, remFor(r, "Rosa", "Thursday", /pe/i).length !== 1 && "PE kit changed") },
  { name: "Reading-for-pleasure book every Friday", family: "C", now: MON, steps: [{ message: "Mila needs her reading for pleasure book every Friday" }],
    check: ([r]) => remFor(r, "Mila", "Friday", /read/i).length !== 1 ? `rows: ${JSON.stringify(r.reminders)}` : null },
  { name: "Young Voices 'remind me the night before' → no duplicate note", family: "C", now: MON_AM,
    seed: { notes: [{ child: "Mila", summary: "Young Voices concert", date: "2026-10-08" }] }, steps: [{ message: "Can you remind me about Young Voices the night before?" }],
    check: ([r]) => noteFor(r, "Mila", "2026-10-08", /young voices/i).length !== 1 ? `notes: ${JSON.stringify(r.notes)}` : null },
  { name: "General question → nothing saved, no success claim", family: "A", now: MON, steps: [{ message: "What time do the reminders come through?" }],
    check: ([r], [reply]) => firstFail(total(r) > 0 && `saved: ${JSON.stringify(r)}`, /\b(saved|added|noted)\b/i.test(reply) && "claims a save") },
  // ── packed lunches ──
  { name: "Packed lunch tomorrow saved for the right day", family: "A", now: MON, steps: [{ message: "Jude needs a packed lunch tomorrow" }],
    check: ([r]) => !eq(lunchDays(r, "Jude", WK), ["Tuesday"]) ? `lunches: ${JSON.stringify(r.lunches)}` : null },
  { name: "Jude's packed lunch on Thursday (past wrong-day bug)", family: "A", now: MON, steps: [{ message: "Jude needs a packed lunch on Thursday" }],
    check: ([r]) => !eq(lunchDays(r, "Jude", WK), ["Thursday"]) ? `lunches: ${JSON.stringify(r.lunches)}` : null },
  { name: "Sunday check-in answer saves the week's plan", family: "A", now: "2026-10-04T17:30:00Z",
    seed: { history: [{ role: "assistant", content: "Hi! Which days do Jude and Harry need packed lunches this week (5 Oct–9 Oct)? 🥪", at: "2026-10-04T16:00:00Z" }] },
    steps: [{ message: "Jude Monday and Wednesday, Harry school dinners all week" }],
    check: ([r]) => firstFail(!eq(lunchDays(r, "Jude", WK), ["Monday", "Wednesday"]) && `Jude: ${JSON.stringify(r.lunches)}`, lunchDays(r, "Harry", WK).length > 0 && "Harry has packed lunches") },
  { name: "Remove a packed lunch day (switch to school dinners)", family: "A", now: MON_AM,
    seed: { lunches: [{ child: "Jude", days: ["Monday", "Wednesday"], week: WK }] }, steps: [{ message: "Jude doesn't need a packed lunch on Wednesday any more, school dinners instead" }],
    check: ([r]) => !eq(lunchDays(r, "Jude", WK), ["Monday"]) ? `lunches: ${JSON.stringify(r.lunches)}` : null },
  { name: "Full-week packed lunch replace", family: "A", now: MON_AM,
    seed: { lunches: [{ child: "Jude", days: ["Monday"], week: WK }] }, steps: [{ message: "This week Jude needs packed lunches on Tuesday and Thursday only, school dinners the other days" }],
    check: ([r]) => !eq(lunchDays(r, "Jude", WK), ["Thursday", "Tuesday"]) ? `lunches: ${JSON.stringify(r.lunches)}` : null },
  { name: "Weekend packed lunch isn't saved as a school lunch", family: "A", now: MON, steps: [{ message: "Jude needs a packed lunch on Saturday" }],
    check: ([r], [reply]) => firstFail(r.lunches.some((l) => l.days.includes("Saturday")) && "Saturday saved as school lunch", /saved.*packed lunch.*saturday/i.test(reply) && "claims Saturday lunch saved") },
  { name: "'School dinners tomorrow' one-off removes the packed lunch", family: "A", now: MON,
    seed: { lunches: [{ child: "Jude", days: ["Tuesday", "Thursday"], week: WK }] }, steps: [{ message: "Jude's having school dinners tomorrow" }],
    check: ([r]) => !eq(lunchDays(r, "Jude", WK), ["Thursday"]) ? `lunches: ${JSON.stringify(r.lunches)}` : null },
  // ── names not pronouns / one-off vs weekly ──
  { name: "'He needs his recorder Friday' (Jude & Harry) → reply uses no he/she/his/her", family: "A", now: MON, steps: [{ message: "He needs his recorder Friday" }],
    check: (_r, [reply]) => /\b(he|she|his|her|him)\b/i.test(reply) ? `pronoun in reply: "${reply}"` : null },
  { name: "Existing weekly swimming (Tue) + 'Jude needs his swim bag tomorrow' on Monday → already on the list", family: "A", now: MON,
    seed: { reminders: [{ child: "Jude", title: "Swimming kit", day: "Tuesday" }] }, steps: [{ message: "Jude needs his swim bag tomorrow" }],
    check: ([r], [reply]) => firstFail(r.notes.length > 0 && `note saved: ${JSON.stringify(r.notes)}`, r.reminders.length !== 1 && `reminders: ${JSON.stringify(r.reminders)}`,
      !(/already/i.test(reply) && /jude/i.test(reply) && /swim/i.test(reply)) && "didn't say it's already on the list") },
  { name: "No match: 'Harry needs his swim bag tomorrow' → asks just tomorrow or every Tuesday; 'just tomorrow' → one dated note", family: "A", now: MON,
    steps: [{ message: "Harry needs his swim bag tomorrow" }, { message: "just tomorrow" }],
    check: ([r1, r2], [q]) => firstFail(total(r1) > 0 && `saved before asking: ${JSON.stringify(r1)}`, !(/tomorrow/i.test(q) && /every tuesday/i.test(q)) && `question: "${q}"`,
      noteFor(r2, "Harry", "2026-10-06", /swim/i).length !== 1 && `notes: ${JSON.stringify(r2.notes)}`, r2.reminders.length > 0 && "weekly reminder saved too") },
  { name: "No match: 'Harry needs his swim bag tomorrow' → 'every week' → one weekly reminder", family: "A", now: MON,
    steps: [{ message: "Harry needs his swim bag tomorrow" }, { message: "every week" }],
    check: ([r1, r2]) => firstFail(total(r1) > 0 && "saved before asking", remFor(r2, "Harry", "Tuesday", /swim/i).length !== 1 && `reminders: ${JSON.stringify(r2.reminders)}`, r2.notes.length > 0 && "dated note saved too") },
  { name: "'Harry has swimming every Thursday' → weekly, no question", family: "A", now: MON, steps: [{ message: "Harry has swimming every Thursday" }],
    check: ([r], [reply]) => firstFail(remFor(r, "Harry", "Thursday", /swim/i).length !== 1 && `reminders: ${JSON.stringify(r.reminders)}`, r.notes.length > 0 && "note saved", /just .*or every/i.test(reply) && "asked one-off or weekly") },
  { name: "'Harry needs PE kit just this Wednesday' → dated note, no question", family: "A", now: MON, steps: [{ message: "Harry needs PE kit just this Wednesday" }],
    check: ([r], [reply]) => firstFail(noteFor(r, "Harry", "2026-10-07", /pe/i).length !== 1 && `notes: ${JSON.stringify(r.notes)}`, r.reminders.length > 0 && "weekly saved", /every wednesday\?/i.test(reply) && "asked one-off or weekly") },
  // ── forced failures ──
  { name: "Forced database failure → warm, specific 'couldn't save', nothing written", family: "A", now: MON, steps: [{ message: PE_WED, fail_db: true }],
    check: ([r], [reply]) => firstFail(total(r) > 0 && `rows written: ${JSON.stringify(r)}`, !/sorry|couldn'?t/i.test(reply) && "not apologetic",
      !(/jude/i.test(reply) && /pe/i.test(reply)) && "not specific (Jude's PE kit)", /\b(saved|done)\b(?!.*couldn)/i.test(reply) && !/couldn'?t save/i.test(reply) && "claims a save") },
  { name: "Forced AI follow-up failure → code-built honest confirmation", family: "A", now: MON, steps: [{ message: PE_WED, fail_followup: true }],
    check: ([r], [reply]) => firstFail(oneJudePeWed(r), !(/jude/i.test(reply) && /pe/i.test(reply)) && "not specific", !/^Got it, .+ is saved ✅$/.test(reply) && `not the short code-built line: "${reply}"`) },
  { name: "Forced Claude failure (credit run out) → honest outage reply, nothing saved, message kept", family: "A", now: MON, steps: [{ message: PE_WED, fail_claude: true }],
    check: ([r], [reply]) => firstFail(total(r) > 0 && `rows written: ${JSON.stringify(r)}`,
      reply !== "Sorry, I'm having trouble right now and haven't saved that. Could you send it again in a little while? 🙏" && `reply: "${reply}"`,
      r.failedInbound !== 1 && `failed item not recorded (${r.failedInbound})`, r.inbound < 1 && "inbound message not stored") },
];

type CaseOut = { reason: string | null; reply: string | null; details: unknown; usage: { input: number; output: number; calls: number; ms: number; truncated: number; turns: number; model?: string } };
async function runHandlerCase(c: HandlerCase): Promise<CaseOut> {
  await resetTestData();
  await seedFamily(c.family, c.seed);
  const after: Rows[] = []; const replies: string[] = []; const calls: unknown[] = [];
  const usage: CaseOut["usage"] = { input: 0, output: 0, calls: 0, ms: 0, truncated: 0, turns: 0 };
  const turnMs: number[] = [];
  for (const step of c.steps) {
    const { status, data } = await callFn("whatsapp-webhook", {
      scenario: c.name, phone: FAMILIES[c.family].phone, message: step.message, now: step.now ?? c.now,
      fail_db: step.fail_db === true, fail_followup: step.fail_followup === true, fail_claude: step.fail_claude === true, dry_run: true,
    });
    if (status !== 200) return { reason: `HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`, reply: null, details: null, usage };
    if (data.twilio_called !== false) return { reason: "Twilio not confirmed off", reply: null, details: null, usage };
    usage.input += data.usage?.input ?? 0; usage.output += data.usage?.output ?? 0; usage.calls += data.usage?.calls ?? 0;
    usage.ms += data.usage?.ms ?? 0; usage.truncated += data.usage?.truncated ?? 0; if (data.usage?.calls) { usage.turns++; turnMs.push(data.usage.ms ?? 0); } if (data.usage?.model) usage.model = data.usage.model;
    replies.push(data.reply ?? ""); calls.push(data.tool_calls);
    after.push(await familyRows(c.family));
  }
  const kidNames = FAMILIES[c.family].kids.map((k) => k.name);
  const confirmations = replies.map((r, i) => ({ r, asked: c.steps[i].message.includes("?") }))
    .filter((x) => /saved ✅|has moved to/i.test(x.r) && !/sorry|couldn'?t/i.test(x.r));
  const badConf = confirmations.find((x) => !x.asked && (x.r.includes("\n") || x.r.length > 120 || !kidNames.some((n) => x.r.includes(n)) || /remind you/i.test(x.r)));
  const sys = replies.find((r) => SYSTEM_WORDS.test(r));
  const pron = replies.find((r) => /\b(he|she|his|her|him)\b/i.test(r));
  const empty = replies.findIndex((r) => !r.trim());
  const reason = sys ? `system wording reached the parent: "${sys.slice(0, 120)}"` : pron ? `pronoun used for a child: "${pron.slice(0, 160)}"` : empty >= 0 ? `empty reply at step ${empty + 1}` : badConf ? `confirmation not one short line naming the child: "${badConf.r}"` : c.check(after, replies);
  const reply = c.steps.length > 1 ? c.steps.map((s, i) => `Parent: ${s.message}\nMonty: ${replies[i]}`).join("\n") : replies[0];
  return { reason, reply, details: { rows: after[after.length - 1], tool_calls: calls, confirmations: confirmations.map((x) => x.r), model: usage.model, ai_ms_per_turn: turnMs, truncated: usage.truncated }, usage };
}

const usageTotals = { input: 0, output: 0, calls: 0, ms: 0, truncated: 0, turns: 0, model: "" };
async function runHandlerSlice(offset: number, limit: number): Promise<Result[]> {
  const out: Result[] = [];
  for (const c of HANDLER_CASES.slice(offset, offset + limit)) {
    let r = await runHandlerCase(c);
    let status: Result["status"] = r.reason ? "fail" : "pass";
    const add = (u: CaseOut["usage"]) => { usageTotals.input += u.input; usageTotals.output += u.output; usageTotals.calls += u.calls; usageTotals.ms += u.ms; usageTotals.truncated += u.truncated; usageTotals.turns += u.turns; if (u.model) usageTotals.model = u.model; };
    add(r.usage);
    if (r.reason) { // retry once; a pass on retry is "flaky", never "pass"
      const r2 = await runHandlerCase(c); add(r2.usage);
      if (!r2.reason) { status = "flaky"; r = { ...r2, reason: `first attempt failed: ${r.reason}` }; }
    }
    out.push({ scenario: c.name, category: "conversation", status, reply: r.reply, reason: r.reason, details: r.details });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const adminId = await requireAdmin(req);
  if (!adminId) return json({ error: "Admin only" }, 403);
  const body = await req.json().catch(() => ({}));
  const action = body.action ?? "full_suite";

  // Chunked run: part "sender" (no AI), then "conversation" slices — keeps each call well under the time limit.
  // A run with only one part (e.g. action "sender_suite") finishes in one call.
  const part: "sender" | "conversation" = body.part === "conversation" ? "conversation" : "sender";
  const offset = Number.isInteger(body.offset) ? body.offset : 0;
  const limit = Math.min(Number.isInteger(body.limit) ? body.limit : 2, 6);
  let runId: string | null = typeof body.run_id === "string" ? body.run_id : null;
  if (!runId) {
    const suite = action === "sender_suite" ? "sender" : action === "conversation_suite" ? "conversation" : "full";
    const { data: run } = await admin.from("test_runs").insert({ suite, triggered_by: adminId === "backend-token" ? null : adminId }).select("id").single();
    runId = run!.id;
  }
  const { data: runRow } = await admin.from("test_runs").select("suite, notes").eq("id", runId).single();
  const suite = runRow?.suite ?? "full";

  let results: Result[] = [];
  let fatal: string | null = null;
  try {
    await resetTestData();
    if (part === "sender") { await seedSenderFixtures(); results = await runSenderSuite(); }
    else results = await runHandlerSlice(offset, limit);
  } catch (e) {
    fatal = (e as Error).message;
  } finally {
    await resetTestData();
  }
  if (fatal) results.push({ scenario: `Suite setup (${part} ${offset})`, category: "setup", status: "fail", reply: null, reason: fatal });
  if (results.length) await admin.from("test_run_results").insert(results.map((r) => ({ run_id: runId, ...r, details: r.details ?? null })));

  let next: { part: string; offset: number } | null = null;
  if (part === "sender" && suite !== "sender") next = { part: "conversation", offset: 0 };
  if (part === "conversation" && offset + limit < HANDLER_CASES.length) next = { part: "conversation", offset: offset + limit };

  // Last chunk: one suite-wide check that every confirmation is a single short line naming the child.
  if (!next && suite !== "sender") {
    const { data: conv } = await admin.from("test_run_results").select("scenario, details").eq("run_id", runId).eq("category", "conversation");
    const allNames = Object.values(FAMILIES).flatMap((f) => f.kids.map((k) => k.name));
    const confs = (conv ?? []).flatMap((r: any) => ((r.details?.confirmations ?? []) as string[]).map((t) => ({ s: r.scenario, t })));
    const bad = confs.filter((x) => x.t.includes("\n") || x.t.length > 120 || !allNames.some((n) => x.t.includes(n)) || /remind you/i.test(x.t));
    await admin.from("test_run_results").insert({ run_id: runId, scenario: `Every confirmation in the suite is one line, under 120 characters, names the child (${confs.length} checked)`,
      category: "conversation", status: bad.length || !confs.length ? "fail" : "pass", reply: confs.slice(0, 6).map((x) => x.t).join("\n"),
      reason: bad.length ? bad.slice(0, 3).map((x) => `${x.s}: "${x.t}"`).join(" | ") : confs.length ? null : "no confirmations found" });
  }

  // Recount everything stored for this run; accumulate AI usage in notes.
  const { data: all } = await admin.from("test_run_results").select("status").eq("run_id", runId);
  const passed = (all ?? []).filter((r) => r.status === "pass").length;
  const failed = (all ?? []).filter((r) => r.status === "fail").length;
  const flaky = (all ?? []).filter((r) => r.status === "flaky").length;
  let prev: any = { input: 0, output: 0, calls: 0 };
  try { prev = JSON.parse(runRow?.notes ?? "{}").usage ?? prev; } catch { /* first chunk */ }
  const usage = { input: prev.input + usageTotals.input, output: prev.output + usageTotals.output, calls: prev.calls + usageTotals.calls,
    ms: (prev.ms ?? 0) + usageTotals.ms, truncated: (prev.truncated ?? 0) + usageTotals.truncated, turns: (prev.turns ?? 0) + usageTotals.turns, model: usageTotals.model || prev.model || null };
  const avgTurnMs = usage.turns ? Math.round(usage.ms / usage.turns) : null;
  const costUsd = Math.round(((usage.input * 3 + usage.output * 15) / 1e6) * 100) / 100; // $3/$15 per M tokens (Sonnet list price)
  await admin.from("test_runs").update({
    finished_at: next ? null : new Date().toISOString(), total: (all ?? []).length, passed, failed, flaky,
    status: next ? "running" : failed ? "failed" : "passed",
    notes: JSON.stringify({ usage, cost_usd: costUsd, avg_ai_ms_per_reply: avgTurnMs, scenarios: { sender: SENDER_CASES.length + 2, conversation: HANDLER_CASES.length } }),
  }).eq("id", runId);
  return json({ run_id: runId, next, total: (all ?? []).length, passed, failed, flaky, cost_usd: costUsd, usage, results });
});
