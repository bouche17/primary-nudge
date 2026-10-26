// Monty regression test runner (admin-only).
// Reminder-sender tests + conversation scenarios.
// Never sends WhatsApp messages: all sender calls go through the secret-gated dry-run/stub entry point.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { getTestPhones, sendBlockReason } from "../_shared/testGuard.ts";
import { estimateCostUsd } from "../_shared/aiCost.ts";
import { dropMisplacedWellWishes, dropPlainPromises, hasPlainPromise, isRoboticReply, shortReplyKind } from "../_shared/replyGuard.ts";
import { contentText, recordOutbound } from "../_shared/outbound.ts";
import { isOptInEmail } from "../_shared/schoolEventRules.ts";
import { detectOptIntent, isOptedOut, optIn, OPT_REPLIES } from "../_shared/optOut.ts";
import { evaluateClaudeAlerts, evaluateDeliveryAlerts } from "../_shared/alerts.ts";
import { buildSchoolMessage, type SchoolEmailInfo } from "../_shared/schoolEmailMessage.ts";
import { buildSignupAlert, ukTime } from "../_shared/signupAlert.ts";
import { isWrongSchoolMessage, repeatedNames, schoolOneLine, schoolResultLabel, schoolSearchQuery } from "../_shared/schoolLabel.ts";
import { fmtFromWhatsOn, formatFreeform, formatLines, formatTemplateVar, type FmtItem } from "../_shared/reminderFormat.ts";
import { computeWhatsOn, getWhatsOn, isOptInEvent, loadFamilyData, yearGroupMatches, type FamilyData } from "../_shared/whatsOn.ts";
import { runChatShadow, runWhatsOnShadow } from "./shadow.ts";
import { whatsOnDays } from "../_shared/reminderFormat.ts";
import { confirmQuestion, doneLine, lookupReply, matchesQuery, rangePhrase } from "../_shared/askMonty.ts";
import { legacyUpcoming, loadChatWhatsOn, loadLegacyChatContext } from "../_shared/chatContext.ts";

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

// Set per request from body.whats_on_source (test runs only): every send-reminders call in the run uses that source.
let SENDER_SOURCE: "legacy" | "new" | null = null;
// Same for Monty's chat (body.chat_source): every whatsapp-webhook test call in the run uses that setting.
let CHAT_SOURCE: "legacy" | "new" | null = null;
async function callFn(name: string, body: unknown) {
  if (name === "send-reminders" && SENDER_SOURCE && body && typeof body === "object" && !("whats_on_source" in (body as any))) body = { ...(body as any), whats_on_source: SENDER_SOURCE };
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
    await admin.from("lunch_checkin_log").delete().in("parent_id", ids);
    await admin.from("linked_accounts").delete().in("primary_user_id", ids);
    await admin.from("linked_accounts").delete().in("linked_user_id", ids);
  }
  await admin.from("school_holidays").delete().eq("school_id", TEST_SCHOOL_ID);
  await admin.from("school_reminders").delete().eq("school_id", TEST_SCHOOL_ID);
  await admin.from("school_events").delete().eq("school_id", TEST_SCHOOL_ID).like("uid", "monty-test-%");
  if (allow.length) {
    await admin.from("parent_notes").delete().in("phone_number", allow);
    await admin.from("reminder_log").delete().in("phone_number", allow);
    await admin.from("dedup_decisions").delete().in("phone_number", allow).eq("decision", "school_changed");
    // Archived, never deleted: keeps the real error (status, body, step, timing) for diagnosis.
    await admin.from("failed_inbound").update({ archived_at: new Date().toISOString() }).in("phone_number", allow).is("archived_at", null);
    await admin.from("message_send_failures").delete().in("phone_number", allow).eq("function_name", "whatsapp-webhook");
    const { data: convos } = await admin.from("conversations").select("id").in("phone_number", allow);
    const convoIds = (convos ?? []).map((c) => c.id);
    if (convoIds.length) {
      await admin.from("messages").delete().in("conversation_id", convoIds);
      await admin.from("conversations").delete().in("id", convoIds);
    }
  }
  await admin.from("school_email_log").delete().eq("school_id", TEST_SCHOOL_ID).eq("is_test", true);
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
  // Holiday fixtures: Wed 21 + Thu 22 Oct 2026 are school holidays (INSET) for the test school.
  const { error: hErr } = await admin.from("school_holidays").insert({
    school_id: TEST_SCHOOL_ID, label: "Test INSET days", start_date: "2026-10-21", end_date: "2026-10-22",
  });
  if (hErr) throw new Error(`seed holiday failed: ${hErr.message}`);
  // Packed lunch every Wednesday (normal week 12 Oct + holiday week 19 Oct).
  const { error: lErr } = await admin.from("weekly_lunch_plans").insert([
    { child_id: child.id, parent_id: parentId, week_start: "2026-10-12", packed_lunch_days: ["Wednesday"] },
    { child_id: child.id, parent_id: parentId, week_start: "2026-10-19", packed_lunch_days: ["Wednesday"] },
  ]);
  if (lErr) throw new Error(`seed lunch plans failed: ${lErr.message}`);
  // School reminders: one due Wed 14 Oct (a normal school day), one due Thu 22 Oct (a holiday).
  const { error: sErr } = await admin.from("school_reminders").insert([
    { school_id: TEST_SCHOOL_ID, title: "Book fair", emoji: "📚", due_date: "2026-10-14", active: true },
    { school_id: TEST_SCHOOL_ID, title: "Bring in harvest donations", emoji: "🥫", due_date: "2026-10-22", active: true },
  ]);
  if (sErr) throw new Error(`seed school reminders failed: ${sErr.message}`);
  // School events on Mon 12 Oct (Harry is Year 3): read only by the 'new' source. The tournament is saved by the parent too.
  const { error: eErr } = await admin.from("school_events").insert([
    ["Y3 Trip to Jodrell Bank", "Year 3"], ["Y3/4 Mixed Football Tournament @ Macc FC", "Year 3,Year 4"], ["ASC Harry Potter Party", "all"], ["Halloween Disco", "all"], ["Y5 Bikeability", "Year 5"],
  ].map(([title, yg], i) => ({ school_id: TEST_SCHOOL_ID, title, start_at: "2026-10-12T08:30:00Z", all_day: false, year_group: yg, uid: `monty-test-sender-${i}-${Date.now()}` })));
  if (eErr) throw new Error(`seed events failed: ${eErr.message}`);
  const { error: n2Err } = await admin.from("parent_notes").insert({ phone_number: FAMILY_A_PHONE, raw_content: "Y3/4 Mixed Football Tournament @ Macc FC",
    summary: "Y3/4 Mixed Football Tournament @ Macc FC", extracted_dates: [{ date: "2026-10-12" }], source_type: "whatsapp", child_name: "Harry" });
  if (n2Err) throw new Error(`seed event note failed: ${n2Err.message}`);
}

// ── Sender scenarios ──

interface SenderCase {
  name: string; period: "morning" | "evening"; now: string; source?: "legacy" | "new"; // source forces the reminder rules for this case
  expectTarget: string; expect: string | null; // template variable (one line); null = expect no message
}

const SENDER_CASES: SenderCase[] = [
  { name: "Weekday morning (Tue 6 Oct, 7am BST)", period: "morning", now: "2026-10-06T06:00:00Z", expectTarget: "2026-10-06", expect: "Harry: 👟 PE kit" },
  { name: "Weekday evening (Tue 6 Oct, 6pm BST) covers Wednesday note", period: "evening", now: "2026-10-06T17:00:00Z", expectTarget: "2026-10-07", expect: "Harry: 📝 gymnastics at 8am" },
  { name: "Note sent after 6pm appears in next morning (Wed 7 Oct)", period: "morning", now: "2026-10-07T06:00:00Z", expectTarget: "2026-10-07", expect: "Harry: 📝 gymnastics at 8am" },
  { name: "Friday evening covers Saturday item", period: "evening", now: "2026-10-09T17:00:00Z", expectTarget: "2026-10-10", expect: "Harry: 🤸 gymnastics" },
  { name: "Fortnightly on-week (Thu 8 Oct)", period: "morning", now: "2026-10-08T06:00:00Z", expectTarget: "2026-10-08", expect: "Harry: 🌳 Forest School" },
  { name: "Fortnightly off-week (Thu 15 Oct)", period: "morning", now: "2026-10-15T06:00:00Z", expectTarget: "2026-10-15", expect: null },
  { name: "Clock change: Sat 24 Oct 6pm BST covers Sunday 25", period: "evening", now: "2026-10-24T17:00:00Z", expectTarget: "2026-10-25", expect: "Harry: 🏊 swimming" },
  { name: "Clock change: Sun 25 Oct 7am GMT", period: "morning", now: "2026-10-25T07:00:00Z", expectTarget: "2026-10-25", expect: "Harry: 🏊 swimming" },
  { name: "Clock change: Mon 26 Oct 7am GMT (nothing due)", period: "morning", now: "2026-10-26T07:00:00Z", expectTarget: "2026-10-26", expect: null },
  { name: "UK date: 23:30 UTC Sat 24 Oct is already Sun 25 in BST", period: "morning", now: "2026-10-24T23:30:00Z", expectTarget: "2026-10-25", expect: "Harry: 🏊 swimming" },
  { name: "UK date: 23:30 UTC Sun 25 Oct is still Sun 25 in GMT", period: "morning", now: "2026-10-25T23:30:00Z", expectTarget: "2026-10-25", expect: "Harry: 🏊 swimming" },
  { name: "Packed lunch + school reminder sent on a normal school day (Wed 14 Oct)", period: "morning", now: "2026-10-14T06:00:00Z", expectTarget: "2026-10-14", expect: "Harry: 🥪 packed lunch • 📚 book fair" },
  { name: "Packed lunch skipped on a holiday (Wed 21 Oct INSET)", period: "morning", now: "2026-10-21T06:00:00Z", expectTarget: "2026-10-21", expect: null },
  { name: "School reminder skipped on a holiday (Thu 22 Oct INSET)", period: "morning", now: "2026-10-22T06:00:00Z", expectTarget: "2026-10-22", expect: null },
  { name: "New rules: Y3 trip + whole-school disco sent, opt-in ASC party/Y5 event left out, parent-saved tournament once (Mon 12 Oct)", source: "new", period: "morning", now: "2026-10-12T06:00:00Z", expectTarget: "2026-10-12",
    expect: "Harry: 🎉 Halloween Disco • 🚌 trip to Jodrell Bank • ⚽ Y3/4 Mixed Football Tournament @ Macc FC" },
  { name: "Old rules (rollback): no school events, only the parent's own note (Mon 12 Oct)", source: "legacy", period: "morning", now: "2026-10-12T06:00:00Z", expectTarget: "2026-10-12",
    expect: "Harry: ⚽ Y3/4 Mixed Football Tournament @ Macc FC" },
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
    await cleanup(); // no simulated rows may exist while the real endpoint runs its alert check
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

// ── Opt-out (STOP/START/delete) — no AI, nothing sent, alert stubbed ──
async function runOptOutTests(quick = false): Promise<Result[]> {
  const out: Result[] = [];
  const ph = FAMILY_A_PHONE;
  const say = (message: string, scenario: string) => callFn("whatsapp-webhook", { phone: ph, message, scenario });
  const morning = () => callFn("send-reminders", { scenario: "opt-out check", period: "morning", now: "2026-10-06T06:00:00Z", scope: "test", only_phones: [ph] });
  const cleanup = async () => { await optIn(ph); await admin.from("ops_alerts").delete().eq("is_test", true); };
  await cleanup();
  try {
    const notesBefore = (await admin.from("parent_notes").select("*", { count: "exact", head: true }).eq("phone_number", ph)).count ?? 0;
    const base = await morning();
    const baseN = (base.data.messages ?? []).length;
    const stop = await say("STOP", "opt-out: STOP");
    const opted = await isOptedOut(ph);
    const block = await sendBlockReason(ph);
    const alertPath = await sendBlockReason(ph, { allowOptedOut: true });
    const after = await morning();
    const afterN = (after.data.messages ?? []).length;
    const normal = await say("Harry needs his PE kit on Thursday", "opt-out: ordinary message while stopped");
    const { count: notes } = await admin.from("parent_notes").select("*", { count: "exact", head: true }).eq("phone_number", ph);
    const r1 = firstFail(stop.data.reply !== OPT_REPLIES.stop && `reply: ${stop.data.reply}`, !opted && "not on opted-out list",
      block !== "opted_out" && `every sender's guard says ${block}`, alertPath !== "test_number" && "alert path misclassified",
      baseN < 1 && "baseline produced no reminder", afterN !== 0 && `reminders still built: ${afterN}`,
      normal.data.reply !== OPT_REPLIES.paused && `stopped parent got AI reply: ${normal.data.reply}`, (notes ?? 0) !== notesBefore && "saved while stopped");
    out.push({ scenario: "STOP → recorded, every sender skips the number, reminders not built, no AI while stopped", category: "opt-out", status: r1 ? "fail" : "pass", reply: stop.data.reply ?? null, reason: r1, details: { baseline_msgs: baseN, after_msgs: afterN, guard: block } });

    const start = await say("start", "opt-out: START");
    const back = await morning();
    const r2 = firstFail(start.data.reply !== OPT_REPLIES.start && `reply: ${start.data.reply}`, await isOptedOut(ph) && "still opted out",
      (back.data.messages ?? []).length !== baseN && `reminders after START: ${(back.data.messages ?? []).length}, want ${baseN}`, (await sendBlockReason(ph)) !== "test_number" && "guard still blocks as opted out");
    out.push({ scenario: "START → opt-out removed, reminders resume", category: "opt-out", status: r2 ? "fail" : "pass", reply: start.data.reply ?? null, reason: r2, details: r2 ? { back: back.data, start: start.data, slot_rows: (await admin.from("reminder_log").select("reference_id, period, sent_at").eq("phone_number", ph)).data } : null });

    const del = await say("Please delete my data", "opt-out: deletion request");
    const { data: al } = await admin.from("ops_alerts").select("alert_type, message").eq("is_test", true).eq("alert_type", "deletion_request");
    const r3 = firstFail(del.data.reply !== OPT_REPLIES.delete && `reply: ${del.data.reply}`, (del.data.alert_sends ?? []).length !== 1 && `alerts sent: ${(del.data.alert_sends ?? []).length}`,
      (al ?? []).length !== 1 && "no deletion_request alert row", !(await isOptedOut(ph)) && "sends not paused", ((await morning()).data.messages ?? []).length !== 0 && "reminders still built");
    out.push({ scenario: "Deletion request → Matt alerted once (stubbed), sends paused", category: "opt-out", status: r3 ? "fail" : "pass", reply: `${del.data.reply ?? ""}\nALERT: ${(del.data.alert_sends ?? [])[0] ?? ""}`, reason: r3 });

    const yes = ["remove my data", "Remove my details", "delete me", "Delete everything", "I want my data deleted", "stop", "STOP", "Stop.", "unsubscribe", "stop messages", "Stop messaging me", "remove me", "don't message me", "opt out", "delete my account", "delete my data", "How do I stop messages?", "please stop"];
    const no = ["the bus stop moved", "Harry needs to stop at the shop after school", "Can you stop the PE kit reminder?", "stop the swimming reminder for Jude", "When does after-school club start?", "Jude's football starts again next week", "remove the PE kit reminder", "delete the swimming reminder"];
    const wrongYes = yes.filter((m) => !detectOptIntent(m)), wrongNo = no.filter((m) => detectOptIntent(m));
    const r4 = firstFail(wrongYes.length > 0 && `missed: ${wrongYes.join(" | ")}`, wrongNo.length > 0 && `false opt-out: ${wrongNo.join(" | ")}`);
    out.push({ scenario: `Opt-out matching: ${yes.length} opt-out phrasings caught, ${no.length} ordinary 'stop'/'delete' messages ignored`, category: "opt-out", status: r4 ? "fail" : "pass", reply: null, reason: r4 });
    await optIn(ph);
    if (quick) return out; // quick suite skips the AI-backed 'bus stop' check
    const bus = await say("the bus stop moved to Elm Road", "opt-out: bus stop (no AI expected? goes to AI)");
    const r5 = firstFail(await isOptedOut(ph) && "bus stop message opted the parent out", bus.data.opt === true && "handled as opt-out");
    out.push({ scenario: "'the bus stop moved' through Monty does NOT opt out", category: "opt-out", status: r5 ? "fail" : "pass", reply: bus.data.reply ?? null, reason: r5, details: { usage: bus.data.usage } });
    if (bus.data.usage) { usageTotals.input += bus.data.usage.input || 0; usageTotals.output += bus.data.usage.output || 0; usageTotals.cache_write += bus.data.usage.cache_write || 0; usageTotals.cache_read += bus.data.usage.cache_read || 0; usageTotals.calls += bus.data.usage.calls || 0; }
  } finally { await cleanup(); }
  return out;
}

// ── Delete parent on disposable test families (no Twilio) ──
async function callDeleteParent(body: unknown) {
  const tok = crypto.randomUUID() + crypto.randomUUID();
  await admin.from("test_runner_tokens").insert({ token_hash: await sha256Hex(tok), expires_at: new Date(Date.now() + 120_000).toISOString() });
  const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-parent`, { method: "POST", headers: { "Content-Type": "application/json", "x-runner-token": tok, apikey: SERVICE_KEY }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function runDeleteParentTests(): Promise<Result[]> {
  const out: Result[] = [];
  const SOLO = "+447000000099", A = "+447000000098", B = "+447000000097";
  const wipe = async (phone: string) => { // leftovers from a failed earlier run
    const { data: p } = await admin.from("profiles").select("user_id").eq("phone_number", phone).maybeSingle();
    if (p) await callDeleteParent({ phone, confirm: true, twilio: false });
  };
  for (const p of [SOLO, A, B]) await wipe(p);
  try {
    // Solo parent: everything goes.
    const uid = await ensureTestUser(SOLO);
    const { data: kid } = await admin.from("children").insert({ parent_id: uid, school_id: TEST_SCHOOL_ID, first_name: "Testkid", year_group: "Year 2" }).select("id").single();
    await admin.from("child_reminders").insert({ child_id: kid!.id, parent_id: uid, title: "PE kit", emoji: "👟", day_of_week: "Tuesday", reminder_time: "both", active: true, recurrence_interval: 1 });
    await admin.from("parent_notes").insert({ phone_number: SOLO, raw_content: "x", summary: "Testkid trip", source_type: "whatsapp", child_name: "Testkid" });
    await admin.from("consent_records").insert({ user_id: uid, consent_type: "terms" });
    await admin.from("onboarding_state").insert({ phone_number: SOLO, status: "complete", user_id: uid });
    const { data: c } = await admin.from("conversations").insert({ phone_number: SOLO, current_step: "active" }).select("id").single();
    await admin.from("messages").insert([{ conversation_id: c!.id, direction: "inbound", content: "hi" }, { conversation_id: c!.id, direction: "outbound", content: "hello" }]);
    const pv = await callDeleteParent({ phone: SOLO, twilio: false });
    const del = await callDeleteParent({ phone: SOLO, confirm: true, twilio: false });
    const { data: still } = await admin.auth.admin.getUserById(uid);
    const left = (await admin.from("children").select("id").eq("id", kid!.id)).data?.length ?? 0;
    const want = { profiles: 1, children: 1, "child_reminders (children deleted)": 1, parent_notes: 1, consent_records: 1, messages: 2, conversations: 1 };
    const miss = Object.entries(want).filter(([k, n]) => pv.data.rows?.[k] !== n || del.data.rows?.[k] !== n).map(([k]) => k);
    const r1 = firstFail(pv.status !== 200 && `preview ${pv.status} ${JSON.stringify(pv.data)}`, del.status !== 200 && `delete ${del.status} ${JSON.stringify(del.data)}`,
      miss.length > 0 && `counts wrong for ${miss.join(", ")}`, !!still?.user && "auth user still exists", left > 0 && "child still exists");
    out.push({ scenario: "Delete parent (solo test family): preview counts = deleted counts, auth user gone", category: "deletion", status: r1 ? "fail" : "pass",
      reply: `preview ${JSON.stringify(pv.data.rows)}\ndeleted ${JSON.stringify(del.data.rows)} auth_deleted=${del.data.auth_user_deleted}`, reason: r1 });

    // Two-parent family: delete A, keep the shared child + reminders with B.
    const a = await ensureTestUser(A), bId = await ensureTestUser(B);
    await admin.from("linked_accounts").insert({ primary_user_id: a, linked_user_id: bId, status: "accepted" });
    const { data: k2 } = await admin.from("children").insert({ parent_id: a, school_id: TEST_SCHOOL_ID, first_name: "Sharedkid", year_group: "Year 3" }).select("id").single();
    await admin.from("child_reminders").insert([1, 2].map((i) => ({ child_id: k2!.id, parent_id: a, title: `Club ${i}`, emoji: "📌", day_of_week: "Monday", reminder_time: "both", active: true, recurrence_interval: 1 })));
    await admin.from("weekly_lunch_plans").insert({ child_id: k2!.id, parent_id: a, week_start: "2026-10-05", packed_lunch_days: ["Monday"] });
    const pv2 = await callDeleteParent({ phone: A, twilio: false });
    const del2 = await callDeleteParent({ phone: A, confirm: true, twilio: false });
    const { data: kidNow } = await admin.from("children").select("parent_id").eq("id", k2!.id).maybeSingle();
    const { data: rems } = await admin.from("child_reminders").select("parent_id").eq("child_id", k2!.id);
    const { data: lp } = await admin.from("weekly_lunch_plans").select("parent_id").eq("child_id", k2!.id);
    const { data: bProf } = await admin.from("profiles").select("user_id").eq("user_id", bId);
    const r2 = firstFail(del2.status !== 200 && `delete ${del2.status} ${JSON.stringify(del2.data)}`, kidNow?.parent_id !== bId && "shared child not kept with partner",
      (rems ?? []).length !== 2 || (rems ?? []).some((r) => r.parent_id !== bId) ? "reminders not reassigned to partner" : null,
      (lp ?? []).length !== 1 || lp![0].parent_id !== bId ? "lunch plan not reassigned" : null, (bProf ?? []).length !== 1 && "partner's profile deleted",
      pv2.data.has_partner !== true && "preview didn't see the partner");
    out.push({ scenario: "Delete parent with linked partner: shared child + reminders + lunch plan reassigned to partner, partner untouched", category: "deletion", status: r2 ? "fail" : "pass",
      reply: `preview ${JSON.stringify(pv2.data.rows)}\ndeleted ${JSON.stringify(del2.data.rows)}`, reason: r2 });
    const { data: audit } = await admin.from("deletion_audit").select("phone_hash, row_counts").order("created_at", { ascending: false }).limit(2);
    const r3 = firstFail((audit ?? []).length !== 2 && "audit rows missing", JSON.stringify(audit).includes("+44") && "audit contains a phone number",
      (audit ?? []).some((x) => !/^[0-9a-f]{64}$/.test(x.phone_hash || "")) && "phone not hashed");
    out.push({ scenario: "Deletion audit row has hashed phone + counts only, no personal data", category: "deletion", status: r3 ? "fail" : "pass", reply: JSON.stringify(audit?.[0] ?? null), reason: r3 });
  } catch (e) {
    out.push({ scenario: "Delete parent tests", category: "deletion", status: "fail", reply: null, reason: (e as Error).message });
  } finally { for (const p of [B, SOLO, A]) await wipe(p); }
  return out;
}

// ── Invented contact details + plain-update fallback ──
async function runContactTests(quick = false): Promise<Result[]> {
  const out: Result[] = [];
  const ph = FAMILY_A_PHONE;
  const say = (message: string, scenario: string, extra: Record<string, unknown> = {}) => callFn("whatsapp-webhook", { phone: ph, message, scenario, ...extra });
  const track = (d: any) => { if (d?.usage) { usageTotals.input += d.usage.input || 0; usageTotals.output += d.usage.output || 0; usageTotals.cache_write += d.usage.cache_write || 0; usageTotals.cache_read += d.usage.cache_read || 0; usageTotals.calls += d.usage.calls || 0; } };
  const emails = (t: string) => (t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase());
  try {
    if (!quick) {
    const a = await say("What's Monty's email address? I have a question about my data", "contact: Monty email"); track(a.data);
    const ra = a.data.reply || "";
    const r1 = firstFail(!ra.includes("hello@heymonty.co.uk") && "no hello@heymonty.co.uk", emails(ra).some((e) => e !== "hello@heymonty.co.uk") && `other email: ${emails(ra).join(", ")}`);
    out.push({ scenario: "Asking for Monty's contact email → hello@heymonty.co.uk only", category: "contacts", status: r1 ? "fail" : "pass", reply: ra, reason: r1 });
    }

    const since = new Date().toISOString();
    const b = await say("Thanks Monty", "contact: forced invented details", { inject_reply: "Email help@monty.school, visit www.monty.school or call the office on 01625 123456." }); track(b.data);
    const rb = b.data.reply || "";
    const { data: logs } = await admin.from("dedup_decisions").select("new_item").eq("phone_number", ph).eq("decision", "invented_contact_blocked").gte("created_at", since);
    const r2 = firstFail(/monty\.school|01625 123456/.test(rb) && "invented detail reached the parent", !/don't have that contact detail/.test(rb) && "no honest replacement",
      !rb.includes("hello@heymonty.co.uk") && "honest version lacks hello@heymonty.co.uk", (logs ?? []).length !== 1 && `block logs: ${(logs ?? []).length}`);
    out.push({ scenario: "Forced invented email/URL/phone in a reply → blocked, replaced, logged invented_contact_blocked", category: "contacts", status: r2 ? "fail" : "pass", reply: rb, reason: r2, details: { logged: logs?.[0]?.new_item } });

    if (quick) return out;
    const c = await say("Remove my data", "contact: remove my data");
    const r3 = firstFail(c.data.reply !== OPT_REPLIES.delete && `reply: ${c.data.reply}`, !(c.data.reply || "").includes("hello@heymonty.co.uk") && "no support email", (c.data.alert_sends ?? []).length !== 1 && "Matt not alerted", !(await isOptedOut(ph)) && "sends not paused");
    out.push({ scenario: "'Remove my data' → deletion flow in code (reply + alert + paused)", category: "contacts", status: r3 ? "fail" : "pass", reply: c.data.reply ?? null, reason: r3 });
    await optIn(ph); await admin.from("ops_alerts").delete().eq("is_test", true);

    const d = await say("What's the school office phone number?", "contact: school phone not stored"); track(d.data);
    const rd = d.data.reply || "";
    const r4 = firstFail(/\d{4,}[\s-]?\d{3,}/.test(rd) && "gave a phone number", !/(don'?t|do not) have|haven'?t got/i.test(rd) && "no honest 'I don't have that'");
    out.push({ scenario: "School phone when none is stored → honest 'I don't have that'", category: "contacts", status: r4 ? "fail" : "pass", reply: rd, reason: r4 });

    const e = await say("the bus stop moved to Elm Road", "fallback: plain update"); track(e.data);
    const re = e.data.reply || "";
    const r5 = firstFail(/haven'?t saved|send (that|it) (to me )?again/i.test(re) && "got the 'haven't saved' fallback", !re.trim() && "empty reply");
    out.push({ scenario: "Plain update with nothing to save → normal short reply, not 'haven't saved'", category: "contacts", status: r5 ? "fail" : "pass", reply: re, reason: r5 });

    const sinceSick = new Date().toISOString();
    const f = await say("Mrs Smith is off sick this week", "fallback: plain update (teacher off sick)"); track(f.data);
    const rf = f.data.reply || "";
    const { count: sickSaves } = await admin.from("parent_notes").select("id", { count: "exact", head: true }).eq("phone_number", ph).gte("created_at", sinceSick);
    const r6 = firstFail(/haven'?t saved|(can|could) only save|can'?t save|send (that|it) (to me )?again/i.test(rf) && "talked about saving / got the 'haven't saved' fallback",
      !rf.trim() && "empty reply", (sickSaves ?? 0) > 0 && `saved ${sickSaves} note(s) for a plain update`);
    out.push({ scenario: "Plain update 'Mrs Smith is off sick this week' → warm reply, nothing saved, no 'haven't saved'/'can only save'", category: "contacts", status: r6 ? "fail" : "pass", reply: rf, reason: r6, details: { saves: sickSaves ?? 0 } });
  } catch (err) {
    out.push({ scenario: "Contact tests", category: "contacts", status: "fail", reply: null, reason: (err as Error).message });
  } finally { await optIn(ph); }
  return out;
}

// ── "What's on" shared function — pure tests (no AI, no database) + one linked-partner test ──
function famFixture(over: Partial<FamilyData> = {}): FamilyData {
  return { familyId: "f", children: [{ id: "k1", first_name: "Harry", school_id: "s1", year_group: "Year 3" }],
    childReminders: [], lunchPlans: [], schoolReminders: [], schoolEvents: [], holidays: [], notes: [], exclusions: [], ...over };
}
const HALF_TERM = [{ school_id: "s1", start_date: "2026-10-23", end_date: "2026-11-01" }];
async function runWhatsOnTests(): Promise<Result[]> {
  const out: Result[] = [];
  const t = (scenario: string, fn: () => string | null | Promise<string | null>, reply?: string) => out.push({ scenario, category: "whats-on", status: "pass", reply: reply ?? null, reason: null, details: { fn } as any });
  const cases: [string, () => Promise<{ reason: string | null; reply?: string }>][] = [
    ["What's on: weekly reminder appears every matching weekday", async () => {
      const r = computeWhatsOn(famFixture({ childReminders: [{ id: "r1", child_id: "k1", title: "PE kit", emoji: "👟", day_of_week: "Tuesday", reminder_time: "both", active: true, recurrence_interval: 1, anchor_date: null }] }), "2026-10-05", "2026-10-18");
      const d = r.map((i) => i.date).join(",");
      return { reason: d === "2026-10-06,2026-10-13" && r.every((i) => i.kind === "weekly") ? null : `got ${d}`, reply: d };
    }],
    ["What's on: Y3 Forest School fortnightly across October half-term → 2 Oct, 16 Oct, 13 Nov, 27 Nov, 11 Dec", async () => {
      const r = computeWhatsOn(famFixture({ holidays: HALF_TERM, childReminders: [{ id: "fs", child_id: "k1", title: "Forest School", emoji: "🌲", day_of_week: "Friday", reminder_time: "evening", active: true, recurrence_interval: 2, anchor_date: "2026-10-02" }] }), "2026-09-28", "2026-12-18");
      const d = r.map((i) => i.date).join(",");
      return { reason: d === "2026-10-02,2026-10-16,2026-11-13,2026-11-27,2026-12-11" ? null : `got ${d}`, reply: d };
    }],
    ["What's on: one-off note appears on its date only", async () => {
      const r = computeWhatsOn(famFixture({ notes: [{ id: "n1", summary: "Harvest donations", child_name: "Harry", extracted_dates: [{ date: "2026-10-14" }] }] }), "2026-10-12", "2026-10-18");
      return { reason: r.length === 1 && r[0].date === "2026-10-14" && r[0].kind === "one-off" && r[0].childName === "Harry" ? null : `got ${JSON.stringify(r)}` };
    }],
    ["What's on: school event reaches the matching year group only (Year 1 never matches Year 10; Y3/Year 3/3 normalised)", async () => {
      const kids = [{ id: "k1", first_name: "Harry", school_id: "s1", year_group: "Y3" }, { id: "k2", first_name: "Jude", school_id: "s1", year_group: "Year 6" }];
      const r = computeWhatsOn(famFixture({ children: kids, schoolEvents: [
        { id: "e1", school_id: "s1", title: "Year 3 trip", start_at: "2026-10-14T08:00:00Z", year_group: "Year 3" },
        { id: "e2", school_id: "s1", title: "Whole-school assembly", start_at: "2026-10-15T08:00:00Z", year_group: "all" },
        { id: "e3", school_id: "s1", title: "Y10 thing", start_at: "2026-10-16T08:00:00Z", year_group: "Year 10" },
      ] }), "2026-10-12", "2026-10-18");
      const got = r.map((i) => `${i.date}:${i.childName}:${i.title}`).join(" | ");
      const want = "2026-10-14:Harry:Year 3 trip | 2026-10-15:Harry:Whole-school assembly | 2026-10-15:Jude:Whole-school assembly";
      const norm = yearGroupMatches("Year 1", "1") && !yearGroupMatches("Year 10", "Year 1") && !yearGroupMatches("Year 1", "Y10") && yearGroupMatches("", "Year 4");
      return { reason: got === want && norm ? null : `got ${got}; normalise ok=${norm}`, reply: got };
    }],
    ["What's on: family with two children — each child's items, school reminder once per family, fixed order", async () => {
      const kids = [{ id: "k2", first_name: "Rosa", school_id: "s1", year_group: "Year 4" }, { id: "k1", first_name: "Harry", school_id: "s1", year_group: "Year 3" }];
      const rem = (id: string, child: string, title: string) => ({ id, child_id: child, title, emoji: null, day_of_week: "Wednesday", reminder_time: "both", active: true, recurrence_interval: 1, anchor_date: null });
      const r = computeWhatsOn(famFixture({ children: kids, childReminders: [rem("a", "k2", "Swimming"), rem("b", "k1", "PE kit")],
        schoolReminders: [{ id: "sr", school_id: "s1", title: "Book fair", emoji: "📚", day_of_week: null, due_date: "2026-10-14", active: true }] }), "2026-10-14", "2026-10-14");
      const got = r.map((i) => `${i.childName ?? "family"}:${i.title}`).join(" | ");
      return { reason: got === "Harry:PE kit | Rosa:Swimming | family:Book fair" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: holiday and INSET days skip weekly, lunch and school reminders (not moved)", async () => {
      const r = computeWhatsOn(famFixture({ holidays: [{ school_id: "s1", start_date: "2026-10-21", end_date: "2026-10-22" }],
        childReminders: [{ id: "r", child_id: "k1", title: "PE kit", emoji: null, day_of_week: "Wednesday", reminder_time: "both", active: true, recurrence_interval: 1, anchor_date: null }],
        lunchPlans: [{ id: "l", child_id: "k1", week_start: "2026-10-19", packed_lunch_days: ["Wednesday", "Friday"] }],
        schoolReminders: [{ id: "sr", school_id: "s1", title: "Harvest", emoji: null, day_of_week: null, due_date: "2026-10-22", active: true }] }), "2026-10-19", "2026-10-25");
      const got = r.map((i) => `${i.date}:${i.title}`).join(" | ");
      return { reason: got === "2026-10-23:Packed lunch" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: clock-change week (25 Oct) — UK dates stay right across BST→GMT", async () => {
      const r = computeWhatsOn(famFixture({
        childReminders: [{ id: "r", child_id: "k1", title: "Cubs", emoji: null, day_of_week: "Sunday", reminder_time: "evening", active: true, recurrence_interval: 1, anchor_date: null }],
        schoolEvents: [{ id: "e", school_id: "s1", title: "Late event", start_at: "2026-10-24T23:30:00Z", year_group: null }, { id: "e2", school_id: "s1", title: "GMT event", start_at: "2026-10-25T23:30:00Z", year_group: null }] }), "2026-10-24", "2026-10-26");
      const got = r.map((i) => `${i.date}:${i.title}`).join(" | ");
      return { reason: got === "2026-10-25:GMT event | 2026-10-25:Late event | 2026-10-25:Cubs" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: inactive reminder excluded, duplicates for same child/day shown once, all-opted-out family empty", async () => {
      const base = { emoji: null, day_of_week: "Monday", reminder_time: "both", recurrence_interval: 1, anchor_date: null, child_id: "k1" };
      const f = famFixture({ childReminders: [{ ...base, id: "a", title: "Library book", active: false }, { ...base, id: "b", title: "PE kit", active: true }, { ...base, id: "c", title: "PE  Kit", active: true }] });
      const r = computeWhatsOn(f, "2026-10-12", "2026-10-12");
      const o = computeWhatsOn({ ...f, allOptedOut: true }, "2026-10-12", "2026-10-12");
      return { reason: r.length === 1 && /^pe\s+kit$/i.test(r[0].title) && r[0].source.id !== "a" && o.length === 0 ? null : `got ${JSON.stringify(r.map((i) => i.title))}, opted-out ${o.length}` };
    }],
    // ── School events in reminders (Matt's rule): year-group events in, opt-in activities out unless the parent saved them ──
    ["What's on: Y3 trip is included for a Year 3 child", async () => {
      const r = computeWhatsOn(famFixture({ schoolEvents: [{ id: "e", school_id: "s1", title: "Y3 Trip to Jodrell Bank", start_at: "2026-10-21T08:30:00Z", year_group: "Year 3" }] }), "2026-10-21", "2026-10-21");
      return { reason: r.length === 1 && r[0].kind === "school event" && !r[0].optIn ? null : `got ${JSON.stringify(r)}` };
    }],
    ["What's on: 'Y3/4 Mixed Football Tournament' is opt-in (flagged, not for reminders) unless the parent saved it", async () => {
      const r = computeWhatsOn(famFixture({ schoolEvents: [{ id: "e", school_id: "s1", title: "Y3/4 Mixed Football Tournament @ Macc FC", start_at: "2026-10-21T15:00:00Z", year_group: "Year 3,Year 4" }] }), "2026-10-21", "2026-10-21");
      const forReminders = r.filter((i) => !i.optIn);
      return { reason: r.length === 1 && r[0].optIn === true && forReminders.length === 0 ? null : `got ${JSON.stringify(r)}` };
    }],
    ["What's on: once the parent saves the tournament it appears exactly once (event title or own words)", async () => {
      const ev = [{ id: "e", school_id: "s1", title: "Y3/4 Mixed Football Tournament @ Macc FC", start_at: "2026-10-21T15:00:00Z", year_group: "Year 3,Year 4" }];
      const note = (summary: string) => [{ id: "n", summary, child_name: "Harry", extracted_dates: [{ date: "2026-10-21" }] }];
      const a = computeWhatsOn(famFixture({ schoolEvents: ev, notes: note("Y3/4 Mixed Football Tournament at Macc FC") }), "2026-10-21", "2026-10-21").filter((i) => !i.optIn);
      const b = computeWhatsOn(famFixture({ schoolEvents: ev, notes: note("Harry's football tournament after school") }), "2026-10-21", "2026-10-21").filter((i) => !i.optIn);
      const c = computeWhatsOn(famFixture({ schoolEvents: ev, childReminders: [{ id: "r", child_id: "k1", title: "Mixed Football Tournament @ Macc FC", emoji: null, day_of_week: "Wednesday", reminder_time: "both", active: true, recurrence_interval: 1, anchor_date: null }] }), "2026-10-21", "2026-10-21").filter((i) => !i.optIn);
      const got = [a, b, c].map((x) => x.map((i) => `${i.kind}:${i.title}`).join("+")).join(" | ");
      return { reason: [a, b, c].every((x) => x.length === 1 && x[0].kind !== "school event") ? null : `got ${got}`, reply: got };
    }],
    ["What's on: 'ASC Harry Potter Party' is opt-in; whole-school 'Halloween Disco' is included", async () => {
      const r = computeWhatsOn(famFixture({ schoolEvents: [
        { id: "p", school_id: "s1", title: "ASC Harry Potter Party", start_at: "2026-10-22T15:30:00Z", year_group: "all" },
        { id: "d", school_id: "s1", title: "Halloween Disco", start_at: "2026-10-22T17:00:00Z", year_group: "all" },
        { id: "d2", school_id: "s1", title: "PTA Halloween Disco Party", start_at: "2026-10-22T17:00:00Z", year_group: null },
      ] }), "2026-10-22", "2026-10-22");
      const got = r.map((i) => `${i.title}${i.optIn ? " (opt-in)" : ""}`).join(" | ");
      // "Halloween Disco" is contained in "PTA Halloween Disco Party" on the same day → shown once (the longer title).
      return { reason: got === "ASC Harry Potter Party (opt-in) | PTA Halloween Disco Party" ? null : `got ${got}`, reply: got };
    }],
    // ── 22 Oct fixes: after-school sport = opt-in, key-stage discos, same-day calendar markers ──
    ["What's on: 'Y3/4 Football' Tue 16:30 and 'Y5/6 Football' are opt-in; a Y4 16:30 session is opt-in by time, 'Y4 Parents' Evening' 16:30 isn't", async () => {
      const kids = [{ id: "k1", first_name: "Harry", school_id: "s1", year_group: "Year 4" }, { id: "k2", first_name: "Jude", school_id: "s1", year_group: "Year 5" }];
      const r = computeWhatsOn(famFixture({ children: kids, schoolEvents: [
        { id: "f1", school_id: "s1", title: "Y3/4 Football", start_at: "2026-10-20T15:30:00Z", year_group: "Year 3,Year 4" },
        { id: "f2", school_id: "s1", title: "Y5/6 Football", start_at: "2026-10-22T15:30:00Z", year_group: "Year 5,Year 6" },
        { id: "t1", school_id: "s1", title: "Y4 Science Explorers", start_at: "2026-10-21T15:30:00Z", year_group: "Year 4" },
        { id: "t2", school_id: "s1", title: "Y4 Parents' Evening", start_at: "2026-10-21T15:30:00Z", year_group: "Year 4" },
      ] }), "2026-10-19", "2026-10-23");
      const got = r.map((i) => `${i.childName}:${i.title}${i.optIn ? " (opt-in)" : ""}`).join(" | ");
      const want = "Harry:Y3/4 Football (opt-in) | Harry:Y4 Parents' Evening | Harry:Y4 Science Explorers (opt-in) | Jude:Y5/6 Football (opt-in)";
      return { reason: got === want ? null : `got ${got}`, reply: got };
    }],
    ["What's on: 'Y4/5/6 Swimming' (all day) stays included; whole-school 'Halloween Disco' is included", async () => {
      const kids = [{ id: "k1", first_name: "Harry", school_id: "s1", year_group: "Year 4" }];
      const r = computeWhatsOn(famFixture({ children: kids, schoolEvents: [
        { id: "s", school_id: "s1", title: "Y4/5/6 Swimming", start_at: "2026-10-20T00:00:00Z", year_group: "Year 4,Year 5,Year 6" },
        { id: "d", school_id: "s1", title: "Halloween Disco", start_at: "2026-10-22T17:00:00Z", year_group: "all" },
      ] }), "2026-10-19", "2026-10-23");
      const got = r.map((i) => `${i.date}:${i.title}${i.optIn ? " (opt-in)" : ""}`).join(" | ");
      return { reason: got === "2026-10-20:Y4/5/6 Swimming | 2026-10-22:Halloween Disco" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: 'PTA KS1 Disco' stored as 'all' reaches Reception/Y1/Y2 only, not a Year 4 child", async () => {
      const kids = [{ id: "k1", first_name: "Ava", school_id: "s1", year_group: "Reception" }, { id: "k2", first_name: "Ben", school_id: "s1", year_group: "Year 1" },
        { id: "k3", first_name: "Cal", school_id: "s1", year_group: "Year 2" }, { id: "k4", first_name: "Dot", school_id: "s1", year_group: "Year 4" }];
      const r = computeWhatsOn(famFixture({ children: kids, schoolEvents: [{ id: "d", school_id: "s1", title: "PTA KS1 Disco", start_at: "2026-10-22T17:00:00Z", year_group: "all" }] }), "2026-10-22", "2026-10-22");
      const got = r.map((i) => `${i.childName}${i.optIn ? " (opt-in)" : ""}`).join(",");
      return { reason: got === "Ava,Ben,Cal" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: 'PTA KS2 Disco' → Year 3 child yes, Year 1 child no (from 'all'); a stored year group is never widened", async () => {
      const kids = [{ id: "k1", first_name: "Ben", school_id: "s1", year_group: "Year 1" }, { id: "k2", first_name: "Harry", school_id: "s1", year_group: "Year 3" }];
      const a = computeWhatsOn(famFixture({ children: kids, schoolEvents: [{ id: "d", school_id: "s1", title: "PTA KS2 Disco", start_at: "2026-10-22T18:15:00Z", year_group: "all" }] }), "2026-10-22", "2026-10-22");
      const b = computeWhatsOn(famFixture({ children: kids, schoolEvents: [{ id: "d", school_id: "s1", title: "PTA KS2 Disco", start_at: "2026-10-22T18:15:00Z", year_group: "Year 5" }] }), "2026-10-22", "2026-10-22");
      const got = `all: ${a.map((i) => `${i.childName}${i.optIn ? " (opt-in)" : ""}`).join(",")} / Year 5: ${b.map((i) => i.childName).join(",") || "none"}`;
      return { reason: got === "all: Harry / Year 5: none" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: same-day markers shown once — 'School closes' + 'October Half Term begins (school closes)', 'School opens' + '…ends (school reopens)', 'Inset Day' ×2", async () => {
      const ev = (id: string, title: string, start_at: string) => ({ id, school_id: "s1", title, start_at, year_group: "all" });
      const r = computeWhatsOn(famFixture({ schoolEvents: [
        ev("c1", "School closes", "2026-10-22T15:20:00Z"), ev("c2", "October Half Term begins (school closes)", "2026-10-22T15:20:00Z"),
        ev("i1", "Inset Day", "2026-10-23T00:00:00Z"), ev("i2", "Inset Day", "2026-10-23T08:50:00Z"),
        ev("o1", "October Half Term ends (school reopens)", "2026-11-02T08:50:00Z"), ev("o2", "School opens", "2026-11-02T08:50:00Z"),
      ] }), "2026-10-22", "2026-11-02");
      const got = r.map((i) => `${i.date}:${i.title}`).join(" | ");
      return { reason: got === "2026-10-22:October Half Term begins (school closes) | 2026-10-23:Inset Day | 2026-11-02:October Half Term ends (school reopens)" ? null : `got ${got}`, reply: got };
    }],
    ["What's on: linked partner gets exactly the same list (incl. partner's notes)", async () => {
      await resetTestData();
      await seedFamily("A", { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }], notes: [{ child: "Jude", summary: "Jude recorder", date: "2026-10-09" }] });
      const a = await ensureTestUser(FAMILIES.A.phone), b = await ensureTestUser(FAMILIES.C.phone);
      await admin.from("parent_notes").insert({ phone_number: FAMILIES.C.phone, raw_content: "x", summary: "Harry dentist", extracted_dates: [{ date: "2026-10-08" }], source_type: "whatsapp", child_name: "Harry" });
      await admin.from("linked_accounts").insert({ primary_user_id: a, linked_user_id: b, status: "accepted" });
      try {
        const [wa, wb] = await Promise.all([getWhatsOn(admin as any, a, "2026-10-05", "2026-10-11"), getWhatsOn(admin as any, b, "2026-10-05", "2026-10-11")]);
        const s1 = JSON.stringify(wa.items), s2 = JSON.stringify(wb.items);
        const titles = wa.items.map((i) => `${i.date}:${i.title}`).join(" | ");
        return { reason: s1 === s2 && wa.familyId === wb.familyId && /Harry dentist/.test(titles) && /Jude recorder/.test(titles) && /PE kit/.test(titles) ? null : `A: ${titles} | B: ${wb.items.map((i) => i.title).join(", ")}`, reply: titles };
      } finally {
        await admin.from("linked_accounts").delete().eq("primary_user_id", a).eq("linked_user_id", b);
        await admin.from("parent_notes").delete().eq("phone_number", FAMILIES.C.phone);
        await resetTestData();
      }
    }],
  ];
  void t;
  for (const [scenario, fn] of cases) {
    try { const r = await fn(); out.push({ scenario, category: "whats-on", status: r.reason ? "fail" : "pass", reply: r.reply ?? null, reason: r.reason }); }
    catch (e) { out.push({ scenario, category: "whats-on", status: "fail", reply: null, reason: (e as Error).message }); }
  }
  return out;
}

// ── Dashboard list through the real whats-on function (test users' own JWTs; no AI, no sends) ──
async function testUserJwt(userId: string): Promise<string> {
  const { data: u } = await admin.auth.admin.getUserById(userId);
  const email = u.user?.email;
  if (!email?.endsWith(TEST_EMAIL_DOMAIN)) throw new Error("not a test user");
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email }); // generates only, never emails
  if (error || !data.properties?.hashed_token) throw new Error(`generateLink: ${error?.message}`);
  const anon = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e2 } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: data.properties.hashed_token });
  if (e2 || !s.session) throw new Error(`verifyOtp: ${e2?.message}`);
  return s.session.access_token;
}
async function callWhatsOnAs(userId: string, body: Record<string, unknown>) {
  const jwt = await testUserJwt(userId);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/whats-on`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: Deno.env.get("SUPABASE_ANON_KEY")!, "x-monty-test-secret": TEST_SECRET },
  });
  return { status: res.status, data: await res.json().catch(() => ({})) as any };
}
const dayLines = (d: any) => ((d?.days ?? []) as { date: string; lines: { line: string; optIn: boolean }[] }[])
  .map((x) => `${x.date}: ${x.lines.map((l) => l.line + (l.optIn ? " [optional]" : "")).join(" / ")}`).join(" | ");

async function runDashboardTests(): Promise<Result[]> {
  const out: Result[] = [];
  const kidId = async (name: string) => (await admin.from("children").select("id").in("parent_id", await testUserIds()).eq("first_name", name).limit(1).single()).data!.id;
  const addRem = async (child: string, title: string, day: string, extra: Record<string, unknown> = {}) => {
    const parent_id = await ensureTestUser(FAMILIES.A.phone);
    const { error } = await admin.from("child_reminders").insert({ child_id: await kidId(child), parent_id, title, emoji: null, day_of_week: day, reminder_time: "both", active: true, recurrence_interval: 1, ...extra });
    if (error) throw new Error(`seed reminder: ${error.message}`);
  };
  const cases: [string, () => Promise<{ reason: string | null; reply?: string }>][] = [
    ["Dashboard (whats-on function): linked partner sees exactly the same list, incl. each other's notes", async () => {
      await resetTestData();
      await seedFamily("A", { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }], notes: [{ child: "Jude", summary: "Jude recorder", date: "2026-10-09" }] });
      const a = await ensureTestUser(FAMILIES.A.phone), b = await ensureTestUser(FAMILIES.C.phone);
      await admin.from("parent_notes").insert({ phone_number: FAMILIES.C.phone, raw_content: "x", summary: "Harry dentist", extracted_dates: [{ date: "2026-10-08" }], source_type: "whatsapp", child_name: "Harry" });
      await admin.from("linked_accounts").insert({ primary_user_id: a, linked_user_id: b, status: "accepted" });
      try {
        const body = { mode: "dashboard", source: "new", now: "2026-10-05T09:00:00Z", scenario: "dashboard partner" };
        const [ra, rb] = await Promise.all([callWhatsOnAs(a, body), callWhatsOnAs(b, body)]);
        const la = dayLines(ra.data), lb = dayLines(rb.data);
        return { reason: ra.status !== 200 || rb.status !== 200 ? `HTTP ${ra.status}/${rb.status}` : la !== lb ? `A: ${la} || B: ${lb}` :
          !/2026-10-08: 📝 Harry: dentist/.test(la) || !/Jude: recorder/.test(la) || !/2026-10-06: \S+ Harry: PE kit/.test(la) ? `missing items: ${la}` : null, reply: la };
      } finally {
        await admin.from("linked_accounts").delete().eq("primary_user_id", a).eq("linked_user_id", b);
        await admin.from("parent_notes").delete().eq("phone_number", FAMILIES.C.phone);
      }
    }],
    ["Dashboard: fortnightly off-week and holiday days skipped (Forest School 16 Oct only; Friday PE skipped in half term)", async () => {
      await resetTestData();
      await seedFamily("A");
      await addRem("Harry", "Forest School", "Friday", { recurrence_interval: 2, anchor_date: "2026-10-02" });
      await addRem("Harry", "PE kit", "Friday");
      await admin.from("school_holidays").insert({ school_id: TEST_SCHOOL_ID, label: "Test half term", start_date: "2026-10-23", end_date: "2026-11-01" });
      const r = await callWhatsOnAs(await ensureTestUser(FAMILIES.A.phone), { mode: "dashboard", source: "new", now: "2026-10-12T09:00:00Z", scenario: "dashboard fortnightly" });
      const got = dayLines(r.data);
      return { reason: got === "2026-10-16: 👟 Harry: PE kit / 🌳 Harry: Forest School" ? null : `got ${got}`, reply: got };
    }],
    ["Dashboard: 23:30 UTC Sat 24 Oct is already Sunday 25 in the UK (today = 25th, Sunday swimming first)", async () => {
      await resetTestData();
      await seedFamily("A");
      await addRem("Harry", "Swimming", "Sunday");
      const r = await callWhatsOnAs(await ensureTestUser(FAMILIES.A.phone), { mode: "dashboard", source: "new", now: "2026-10-24T23:30:00Z", scenario: "dashboard 23:30" });
      const first = r.data.days?.[0];
      return { reason: r.data.today !== "2026-10-25" ? `today = ${r.data.today}` : first?.date !== "2026-10-25" || !/🏊 Harry: swimming/.test(first.lines[0]?.line ?? "") ? `first day: ${JSON.stringify(first)}` : r.data.to !== "2026-11-07" ? `to = ${r.data.to}` : null,
        reply: `today ${r.data.today}: ${dayLines(r.data).slice(0, 120)}` };
    }],
    ["Dashboard: opt-in club shown and marked optional; whole-school event once as 'Everyone'", async () => {
      await resetTestData();
      await seedFamily("A", { events: [
        { title: "Halloween Disco", start: "2026-10-13T17:00:00Z", year_group: "all" },
        { title: "Y3/4 Football", start: "2026-10-13T15:30:00Z", year_group: "Year 3,Year 4" },
      ] });
      const r = await callWhatsOnAs(await ensureTestUser(FAMILIES.A.phone), { mode: "dashboard", source: "new", now: "2026-10-12T09:00:00Z", scenario: "dashboard opt-in" });
      const got = dayLines(r.data);
      return { reason: got === "2026-10-13: 🎉 Everyone: Halloween Disco / ⚽ Harry: football [optional]" ? null : `got ${got}`, reply: got };
    }],
    ["Dashboard: with no override the function follows app_settings.dashboard_source", async () => {
      await resetTestData();
      await seedFamily("A");
      const { data: setting } = await admin.from("app_settings").select("value").eq("key", "dashboard_source").maybeSingle();
      const r = await callWhatsOnAs(await ensureTestUser(FAMILIES.A.phone), { mode: "dashboard", scenario: "dashboard setting" });
      return { reason: r.data.source === (setting?.value === "new" ? "new" : "legacy") ? null : `setting ${setting?.value}, function said ${r.data.source}`, reply: `setting ${setting?.value} → ${r.data.source}` };
    }],
    ["Chat context (no AI): new list has partner's note + due-dated school reminder, skips fortnight off-week + holiday; old context doesn't", async () => {
      await resetTestData();
      await seedFamily("A", { reminders: [{ child: "Harry", title: "Forest School", day: "Thursday", interval: 2, anchor: "2026-10-01" }, { child: "Jude", title: "PE kit", day: "Tuesday" }],
        holidays: [{ start: "2026-10-13", end: "2026-10-13" }], partner: "C" });
      await admin.from("parent_notes").insert({ phone_number: FAMILIES.C.phone, raw_content: "x", summary: "Harry dentist", extracted_dates: [{ date: "2026-10-07" }], source_type: "whatsapp", child_name: "Harry" });
      await admin.from("school_reminders").insert({ school_id: TEST_SCHOOL_ID, title: "Book fair", emoji: "📚", due_date: "2026-10-09", active: true });
      const now = new Date("2026-10-05T08:00:00Z");
      const old = legacyUpcoming((await loadLegacyChatContext(admin as any, FAMILIES.A.phone, now))!, "2026-10-05", 14).map((x) => `${x.date}:${x.title}`);
      const neu = (await loadChatWhatsOn(admin as any, await ensureTestUser(FAMILIES.A.phone), now)).items.map((x) => `${x.date}:${x.title}`);
      const has = (l: string[], k: string) => l.includes(k);
      const reason = firstFail(!has(neu, "2026-10-07:Harry dentist") && "new: partner note missing", has(old, "2026-10-07:Harry dentist") && "old saw the partner note?",
        !has(neu, "2026-10-09:Book fair") && "new: due-dated school reminder missing", !has(neu, "2026-10-15:Forest School") && "new: Forest School on-week missing",
        has(neu, "2026-10-08:Forest School") && "new: off-week Forest School listed", !has(old, "2026-10-08:Forest School") && "old should list it every week",
        has(neu, "2026-10-13:PE kit") && "new: PE kit on the holiday", !has(neu, "2026-10-06:PE kit") && "new: normal PE kit missing");
      return { reason, reply: `new: ${neu.join(", ")} | old: ${old.join(", ")}` };
    }],
    ["Dashboard: dashboard_source 'legacy' → function says legacy (dashboard keeps its old list)", async () => {
      await resetTestData();
      await seedFamily("A");
      const r = await callWhatsOnAs(await ensureTestUser(FAMILIES.A.phone), { mode: "dashboard", source: "legacy", scenario: "dashboard legacy" });
      return { reason: r.data.source === "legacy" && !r.data.days ? null : `got ${JSON.stringify(r.data).slice(0, 200)}` };
    }],
  ];
  for (const [scenario, fn] of cases) {
    try { const r = await fn(); out.push({ scenario, category: "whats-on", status: r.reason ? "fail" : "pass", reply: r.reply ?? null, reason: r.reason }); }
    catch (e) { out.push({ scenario, category: "whats-on", status: "fail", reply: null, reason: (e as Error).message }); }
  }
  await resetTestData();
  return out;
}

// ── Morning/evening layout — pure tests (no AI, no database) ──
function runFormatTests(): Result[] {
  const it = (childName: string, title: string, emoji: string, type: FmtItem["type"] = "reminder"): FmtItem => ({ childName, title, emoji, type });
  const today = [it("Caspian", "Homework needed", "📝"), it("Caspian", "Packed lunch", ""), it("Caspian", "Caspian needs change for the Poppy Appeal", "📝", "note")];
  const cases: [string, () => { got: string; want: string }][] = [
    ["Reminder layout: one child, three items (window open)", () => ({ got: formatFreeform(today, "morning"),
      want: "Good morning! ☀️ Here's what's on today:\n📚 Caspian: homework due\n🥪 Caspian: packed lunch\n🪙 Caspian: change for the Poppy Appeal\nHave a great day!" })],
    ["Reminder layout: two children grouped by child (window open)", () => ({ got: formatFreeform([it("Ivy", "Reading books returned", "📖"), it("Caspian", "PE kit", "👟"), it("Ivy", "Packed lunch", "🥪")], "evening"),
      want: "Good evening! 🌙 A few things to get ready for tomorrow:\n📖 Ivy: reading books returned\n🥪 Ivy: packed lunch\n👟 Caspian: PE kit\nHope you have a lovely evening!" })],
    ["Reminder layout: item with no emoji gets a default by type", () => ({ got: formatFreeform([it("Caspian", "Harvest festival", "", "event"), it("Caspian", "Bring a jumper", "", "reminder")], "morning"),
      want: "Good morning! ☀️ Here's what's on today:\n🏫 Caspian: harvest festival\n✅ Caspian: bring a jumper\nHave a great day!" })],
    ["Reminder layout: long note cut to a short headline at a natural break, its deadline kept", () => ({ got: formatLines([it("Caspian", "Caspian needs to bring £2 for the cake sale on Friday, please send it in a named envelope to the office by 9am", "📝", "note")]).join("\n"),
      want: "🪙 Caspian: £2 for the cake sale on Friday… by 9am" })],
    ["Reminder layout: no links or phone numbers in the line", () => ({ got: formatLines([it("Ivy", "Jodrell Bank trip money due, pay at https://pay.example.uk/trip or call 01625 383838", "📝", "note"),
      it("Ivy", "Call the school office on 01625 383 838 about the Jodrell Bank trip, details at https://deanvalley.example/trip", "📝", "note")]).join("\n"),
      want: "🪙 Ivy: Jodrell Bank trip money due\n🚌 Ivy: call the school office about the Jodrell Bank trip" })],
    ["Reminder layout: no break → cut at a whole word (never mid-word), under ~70 characters", () => {
      const src = "completed reading record and signed permission slip for the museum visit next week";
      const line = formatLines([it("Harry", `Harry needs to bring in his ${src}`, "📝", "note")])[0];
      const text = line.replace(/^\S+ Harry: /, ""), body = text.replace(/…$/, "");
      const ok = text.endsWith("…") && text.length <= 71 && `his ${src}`.startsWith(body) && `his ${src}`[body.length] === " ";
      return { got: ok ? "ok" : line, want: "ok" };
    }],
    ["Reminder layout: title tidy on every item ('Outdoor PE kit' → 'outdoor PE kit', acronyms and proper names kept)", () => ({
      got: formatLines([it("Harry", "Outdoor PE kit", "👟"), it("Harry", "PE kit", "👟"), it("Harry", "Forest School", "🌳"), it("Harry", "Halloween disco", "", "event")]).join("\n"),
      want: "👟 Harry: outdoor PE kit\n👟 Harry: PE kit\n🌳 Harry: Forest School\n🎉 Harry: Halloween disco" })],
    ["Reminder layout: swimming always uses 🏊", () => ({ got: formatLines([it("Rosa", "Swimming kit", "👟"), it("Rosa", "Swim bag", ""), it("Rosa", "Swimming", "🩴")]).join("\n"),
      want: "🏊 Rosa: swimming kit\n🏊 Rosa: swim bag\n🏊 Rosa: swimming" })],
    ["Reminder layout: template path is one line, no newlines", () => {
      const got = formatTemplateVar([...today, it("Ivy", "PE kit", "👟")]);
      return { got: /[\r\n]/.test(got) ? "CONTAINS NEWLINE: " + got : got, want: "Caspian: 📚 homework due • 🥪 packed lunch • 🪙 change for the Poppy Appeal; Ivy: 👟 PE kit" };
    }],
  ];
  // ── Reminder polish (1 Nov): shared events once per family, deadline words kept, one line per topic, always-include wins ──
  const kid = (id: string, first_name: string, year_group: string, school_id = "s1") => ({ id, first_name, school_id, year_group });
  const ev = (id: string, title: string, start_at: string, year_group = "all", school_id = "s1") => ({ id, school_id, title, start_at, year_group });
  const lines = (f: FamilyData, d: string, tmpl = false) => {
    const w = computeWhatsOn(f, d, d).filter((i) => !i.optIn);
    const fi = w.map((i) => fmtFromWhatsOn(i, i.childName ?? (f.children.length === 1 ? f.children[0].first_name : "the children")));
    const fam = f.children.map((c) => c.first_name);
    return tmpl ? formatTemplateVar(fi, fam) : formatLines(fi, fam).join("\n");
  };
  const closes = ev("c", "October Half Term begins (school closes)", "2026-10-22T15:20:00Z");
  cases.push(
    ["Shared events: two children, same school, whole-school event → one 'Everyone' line", () => ({
      got: lines(famFixture({ children: [kid("k1", "Freddie", "Year 6"), kid("k2", "Tommy", "Year 4")], schoolEvents: [closes] }), "2026-10-22"),
      want: "🏫 Everyone: school closes for half term" })],
    ["Shared events: three children, event reaches two → 'Freddie & Tommy:' line, Everyone first", () => ({
      got: lines(famFixture({ children: [kid("k1", "Amy", "Year 1"), kid("k2", "Freddie", "Year 6"), kid("k3", "Tommy", "Year 4")],
        schoolEvents: [ev("d", "PTA KS2 Disco", "2026-10-22T17:15:00Z"), closes] }), "2026-10-22"),
      want: "🏫 Everyone: school closes for half term\n🎉 Freddie & Tommy: PTA KS2 Disco" })],
    ["Shared events: children at two schools → only the event's school's children grouped", () => ({
      got: lines(famFixture({ children: [kid("k1", "Amy", "Year 1", "s1"), kid("k2", "Ben", "Year 3", "s1"), kid("k3", "Cal", "Year 5", "s2")],
        schoolEvents: [ev("c1", "Inset Day", "2026-11-02T08:50:00Z", "all", "s1"), ev("c2", "Book Fair", "2026-11-02T08:50:00Z", "all", "s2")] }), "2026-11-02"),
      want: "🏫 Amy & Ben: Inset Day\n📖 Cal: Book Fair" })],
    ["Shared events: template one-line version uses 'Everyone:' too (no newlines)", () => {
      const got = lines(famFixture({ children: [kid("k1", "Freddie", "Year 6"), kid("k2", "Tommy", "Year 4")], schoolEvents: [closes],
        lunchPlans: [{ id: "l", child_id: "k2", week_start: "2026-10-19", packed_lunch_days: ["Thursday"] }] }), "2026-10-22", true);
      return { got: /[\r\n]/.test(got) ? "NEWLINE: " + got : got, want: "Everyone: 🏫 school closes for half term; Tommy: 🥪 packed lunch" };
    }],
    ["Deadline words kept: 'selections lock tomorrow' on a Wednesday item → 'selections lock Thursday'", () => ({
      got: formatLines([{ childName: "the children", title: "Book next week's school meals on the Parent Portal — selections lock tomorrow", emoji: "", type: "announcement", date: "2026-11-04" }]).join("\n"),
      want: "📖 Everyone: book next week's school meals on the Parent Portal — selections lock Thursday" })],
    ["Deadline words kept: 'by 3pm today' on a long note is never cut off", () => {
      const got = formatLines([{ childName: "Toby", title: "Deadline: Consent and payment of £12.66 for Safety Central trip must be completed on Arbor by 3pm today.", emoji: "📝", type: "note", date: "2026-10-26" }])[0];
      return { got: /by 3pm Monday$/.test(got) ? "ok" : got, want: "ok" };
    }],
    ["One line per topic: parent note 'Halloween disco' + school 'PTA KS2 Disco' same child/day → one line", () => ({
      got: lines(famFixture({ schoolEvents: [ev("d", "PTA KS2 Disco", "2026-10-22T17:15:00Z")], notes: [{ id: "n", summary: "Halloween disco", child_name: "Harry", extracted_dates: [{ date: "2026-10-22" }] }] }), "2026-10-22"),
      want: "🎉 Harry: PTA KS2 Disco" })],
    ["One line per topic: parent note 'disco, bring £2' + school disco → one line containing '£2'", () => ({
      got: lines(famFixture({ schoolEvents: [ev("d", "PTA KS2 Disco", "2026-10-22T17:15:00Z")], notes: [{ id: "n", summary: "Disco, bring £2", child_name: "Harry", extracted_dates: [{ date: "2026-10-22" }] }] }), "2026-10-22"),
      want: "🎉 Harry: PTA KS2 Disco, bring £2" })],
    ["One line per topic: weekly 'Swimming kit needed' + 'Y4/5/6 Swimming' → one line keeping the kit", () => ({
      got: lines(famFixture({ children: [kid("k1", "Rosa", "Year 6")], schoolEvents: [ev("s", "Y4/5/6 Swimming", "2026-11-03T00:00:00Z", "Year 4,Year 5,Year 6")],
        childReminders: [{ id: "r", child_id: "k1", title: "Swimming kit needed", emoji: "🩴", day_of_week: "Tuesday", reminder_time: "both", active: true, recurrence_interval: 1, anchor_date: null }] }), "2026-11-03"),
      want: "🏊 Rosa: swimming, bring kit" })],
    ["Always-include beats club words: 'Choir concert', 'Football match vs parents (assembly)', 'Dance performance' in; 'Choir' at 15:30 opt-in", () => {
      const got = [isOptInEvent("Choir concert", "Year 3", "2026-11-05T15:30:00Z"), isOptInEvent("Football match vs parents (assembly)", "all", "2026-11-05T09:00:00Z"),
        isOptInEvent("Dance performance", "Year 4", "2026-11-05T16:00:00Z"), isOptInEvent("Choir", "Year 3", "2026-11-05T15:30:00Z")].map((x) => (x ? "opt-in" : "in")).join(", ");
      return { got, want: "in, in, in, opt-in" };
    }],
  );
  const em = (o: Partial<SchoolEmailInfo>): SchoolEmailInfo => ({ message: "⚽ The football tournament is on Wednesday 21st October.", yearGroups: ["Year 3", "Year 4"], links: [], ...o });
  cases.push(
    ["School email: targeted email starts with the family's children", () => ({ got: buildSchoolMessage(em({}), ["Caspian", "Ivy"]), want: "For Caspian and Ivy: ⚽ The football tournament is on Wednesday 21st October." })],
    ["School email: whole-school email has no names", () => ({ got: buildSchoolMessage(em({ yearGroups: ["all"] }), ["Caspian"]), want: "⚽ The football tournament is on Wednesday 21st October." })],
    ["School email: no newlines in the sent text", () => { const got = buildSchoolMessage(em({ message: "📸 Photos on Tuesday.\nOrder by Friday.\r\nThanks" }), ["Caspian"]); return { got: /[\r\n]/.test(got) ? "NEWLINE: " + got : got, want: "For Caspian: 📸 Photos on Tuesday. Order by Friday. Thanks" }; }],
    ["School email: links appended once (dupes, mailto dropped)", () => ({ got: buildSchoolMessage(em({ yearGroups: ["all"], links: ["https://x.uk/book", "https://x.uk/book", "mailto:a@b.uk"] })), want: "⚽ The football tournament is on Wednesday 21st October. https://x.uk/book" })],
    ["School email: empty message falls back to a plain sentence", () => ({ got: buildSchoolMessage(em({ message: "", yearGroups: ["all"], what: "School photos", when: "Tuesday 3rd November", cost: null, action: "Order online by Friday 13th November" })), want: "School photos on Tuesday 3rd November. Order online by Friday 13th November." })],
  );
  // Sign-up alerts + school labels (pure, no AI)
  const stJoe = { name: "St Joseph's Catholic Primary School, a Voluntary Academy", address: "Marlborough Road", town: "Sale", postcode: "M33 3AF" };
  const stJoeSk = { name: "St Joseph's Catholic Primary School, a Voluntary Academy", address: "Etchells Street, St Petersgate", town: "Stockport", postcode: "SK1 1EF" };
  const dv = { name: "Dean Valley Community Primary School", address: "Albert Road, Bollington", town: "Macclesfield", postcode: "SK10 5HS" };
  const at = new Date("2026-09-25T06:29:13Z");
  cases.push(
    ["Sign-up alert: exact text (new parent, new school, town + postcode, UK time)", () => ({
      got: buildSignupAlert({ parentFirstName: "Sarah Jones", newParent: true, children: [{ firstName: "Hallie", yearGroup: "Year 1", school: { ...stJoe, known: false } }], signedUpAt: at }),
      want: `Monty alert: New sign-up. Sarah added Hallie (Year 1) at St Joseph's Catholic Primary School, a Voluntary Academy, Marlborough Road, Sale M33 3AF: NEW school (no calendar loaded yet). Signed up ${ukTime(at)} (UK time).` })],
    ["Sign-up alert: known school vs new school wording, two children", () => {
      const t = buildSignupAlert({ parentFirstName: null, newParent: false, children: [{ firstName: "Ike", yearGroup: "Year 3", school: { ...dv, known: true } }, { firstName: "Hallie", yearGroup: "Year 1", school: { ...stJoe, known: false } }], signedUpAt: at });
      const ok = /^Monty alert: Child added\. A parent \(no name given\) added Ike \(Year 3\) at Dean Valley[^;]*: known school[^;]*; Hallie \(Year 1\) at St Joseph's[^:]*: NEW school/.test(t);
      return { got: ok ? "ok" : t, want: "ok" };
    }],
    ["Sign-up alert: no phone numbers or email addresses ever in the text", () => {
      const t = buildSignupAlert({ parentFirstName: "sarah.jones@gmail.com", newParent: true, children: [{ firstName: "Hallie", yearGroup: "Year 1", school: { ...stJoe, address: "Marlborough Road, Tel 0161 973 4938", known: false } }], signedUpAt: at });
      const bad = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t) || /\d[\d\s]{8,}\d/.test(t.replace(/Signed up.*$/, ""));
      return { got: bad ? t : "clean", want: "clean" };
    }],
    ["School label: same-name results show town + postcode first", () => {
      const rep = repeatedNames([stJoe, stJoeSk, dv]);
      return { got: [schoolResultLabel(stJoe, rep).primary, schoolResultLabel(stJoeSk, rep).primary, schoolResultLabel(dv, rep).primary, schoolResultLabel(dv, rep).secondary].join(" | "),
        want: "Sale, M33 3AF | Stockport, SK1 1EF | Dean Valley Community Primary School | Albert Road, Bollington, Macclesfield, SK10 5HS" };
    }],
    ["School label: one line for confirmations", () => ({ got: schoolOneLine(stJoe), want: "St Joseph's Catholic Primary School, a Voluntary Academy, Marlborough Road, Sale M33 3AF" })],
    ["Wrong-school phrases caught; ordinary messages ignored", () => {
      const yes = ["I'm not with that school", "wrong school", "That's not my school", "she doesn't go there", "Hallie doesn't go to that school", "that's not Hallie's school", "We're not at that school"];
      const no = ["the bus stop moved", "she doesn't go there on Fridays any more, the club stopped", "Is school open on Monday?", "Hallie needs PE kit tomorrow", "What's on at school this week?"];
      const miss = [...yes.filter((m) => !isWrongSchoolMessage(m)).map((m) => `missed: ${m}`), ...no.filter((m) => isWrongSchoolMessage(m)).map((m) => `false: ${m}`)];
      return { got: miss.join("; ") || "ok", want: "ok" };
    }],
    ["What's on: 'just this week' skip drops only that date (weekly carries on)", () => {
      const f = famFixture({ childReminders: [{ id: "sw", child_id: "k1", title: "Swimming", emoji: "🏊", day_of_week: "Wednesday", reminder_time: "both", active: true, recurrence_interval: 1, anchor_date: null }], skips: [{ reminder_id: "sw", skip_date: "2026-10-07" }] } as any);
      return { got: computeWhatsOn(f, "2026-10-05", "2026-10-18").map((i) => i.date).join(","), want: "2026-10-14" };
    }],
    ["Ask Monty wording: look-up answer, empty answer, confirm question and done line", () => {
      const days = [{ date: "2026-10-06", lines: [{ child: "Harry", emoji: "👟", text: "PE kit", line: "👟 Harry: PE kit", optIn: false, tag: "weekly" as const, sources: [] }, { child: "Harry", emoji: "⚽", text: "football", line: "⚽ Harry: football", optIn: true, tag: "school" as const, sources: [] }] }];
      const plan = { op: { op: "skip_date" as const, reminder_id: "x", date: "2026-11-03" }, child: "Harry", title: "Swimming", needsConfirm: true };
      return { got: [lookupReply({ from: "2026-10-06", to: "2026-10-06", today: "2026-10-05", days }), lookupReply({ from: "2026-10-05", to: "2026-10-11", today: "2026-10-05", item: "Forest School", days: [] }),
        lookupReply({ from: "2026-10-09", to: "2026-10-09", today: "2026-10-05", item: "unicorn parade", days: [] }, true), confirmQuestion(plan), doneLine(plan),
        rangePhrase("2026-10-05", "2026-10-05", "2026-10-05"), String(matchesQuery("Swimming lessons", "swim")) + String(matchesQuery("PE kit", "football"))].join(" | "),
        want: "Here's what's on tomorrow (Tuesday 6th October):\n👟 Harry: PE kit\n⚽ Harry: football (optional) | There's nothing saved for Forest School between Monday 5th October and Sunday 11th October. | I can't find \"unicorn parade\" on Friday 9th October, so I haven't changed anything. | Cancel Harry's swimming just this Tuesday 3rd? Yes / No | Done, Harry's swimming is off for Tuesday 3rd ✅ | today (Monday 5th October) | truefalse" };
    }],
    ["School search words: child names and filler removed, postcode kept", () => ({
      got: [schoolSearchQuery("Hallie goes to St Joseph's in Stockport", ["Hallie"]), schoolSearchQuery("it's the one at m33 3af", [])].join(" | "), want: "st josephs stockport | M333AF" })],
  );
  return cases.map(([scenario, fn]) => {
    try { const { got, want } = fn(); return { scenario, category: "sender", status: got === want ? "pass" : "fail", reply: got, reason: got === want ? null : `expected ${JSON.stringify(want)}` } as Result; }
    catch (e) { return { scenario, category: "sender", status: "fail", reply: null, reason: (e as Error).message } as Result; }
  });
}

// ── Reply safety check (no AI): conditional offers and questions are kept, plain promises with no save are still caught ──
function runReplyGuardTests(): Result[] {
  const kept: [string, string][] = [
    ["'Jude has cooking club every other Friday' → asks for the next date", "Cooking club every other Friday sounds fun! When's Jude's next one? Once I have the date, I'll set up the reminders."],
    ["'once …, I'll set up'", "Once I have the date, I'll set up the reminders 😊"],
    ["'tell me … and I'll'", "Just tell me the date and I'll set up a reminder."],
    ["'let me know … and I'll'", "Let me know which Friday it starts and I'll add it for Jude."],
    ["'if …, I'll'", "If you'd like, I'll add a reminder for Harry's trip."],
    ["'when you …, I'll'", "When you have the letter, I'll note the date for Jude."],
    ["'as soon as …, I'll'", "As soon as you tell me the day, I'll set it up."],
    ["question ending with '?'", "Shall I add Harry's swimming for Tuesday?"],
  ];
  const blocked: [string, string][] = [
    ["'I'll save that now'", "Lovely, I'll save that now."],
    ["'I'll set that up'", "No problem — I'll set that up for Jude."],
    ["'Let me add it'", "Let me add it to Harry's reminders."],
    ["conditional sentence + a separate plain promise", "When's the next one? I'll save Jude's cooking club now."],
  ];
  const out: Result[] = [];
  for (const [n, t] of kept) {
    const r = hasPlainPromise(t) ? "treated as a plain promise (reply would be replaced)" : null;
    out.push({ scenario: `Reply check keeps a conditional offer/question: ${n}`, category: "reply-guard", status: r ? "fail" : "pass", reply: t, reason: r });
  }
  for (const [n, t] of blocked) {
    const r = !hasPlainPromise(t) ? "plain promise not caught" : null;
    out.push({ scenario: `Reply check still blocks a plain promise with no save: ${n}`, category: "reply-guard", status: r ? "fail" : "pass", reply: t, reason: r });
  }
  const d = dropPlainPromises("When's the next one? I'll save Jude's cooking club now.");
  out.push({ scenario: "Reply check: dropping promises keeps the question", category: "reply-guard", status: d === "When's the next one?" ? "pass" : "fail", reply: d, reason: d === "When's the next one?" ? null : `got "${d}"` });
  return out;
}

// ── Prompt caching layout (no AI): static block identical for everyone, breakpoints within Anthropic's limit of 4 ──
async function runPromptCacheTests(): Promise<Result[]> {
  const out: Result[] = [];
  await resetTestData();
  await seedFamily("A"); await seedFamily("B");
  const blocks = (fam: "A" | "B", now: string, src: "legacy" | "new") =>
    callFn("whatsapp-webhook", { action: "prompt_blocks", phone: FAMILIES[fam].phone, now, chat_source: src, scenario: "prompt-cache layout" }).then((r) => r.data);
  for (const src of ["legacy", "new"] as const) {
    const a1 = await blocks("A", "2026-10-06T07:03:00Z", src), a2 = await blocks("A", "2026-10-08T17:41:00Z", src), b1 = await blocks("B", "2026-10-06T07:03:00Z", src);
    const r = firstFail(!a1.static_sha && `no prompt blocks: ${JSON.stringify(a1).slice(0, 200)}`,
      a1.chat_source !== src && `chat_source ${a1.chat_source}, wanted ${src}`,
      (a1.static_sha !== a2.static_sha || a1.static_sha !== b1.static_sha) && "static block differs between parents or times",
      a1.family_sha === b1.family_sha && "family block is the same for two different families",
      a1.now_sha === a2.now_sha && "now block didn't change with the time",
      /2026-10-0[68]|October 2026|0?8:03\b/.test(a1.static_text || "") && "static block contains the test's date or time",
      !a1.now_last && "NOW block (and SYSTEM CHECK) not last/uncached",
      (a1.tool_breakpoints !== 1 || !a1.last_tool_cached) && `tool breakpoints ${a1.tool_breakpoints}, last cached ${a1.last_tool_cached}`,
      a1.system_breakpoints !== 2 && `system breakpoints ${a1.system_breakpoints}`,
      a1.message_breakpoints !== 1 && `message breakpoints ${a1.message_breakpoints} after two rounds`,
      a1.total_breakpoints > 4 && `total breakpoints ${a1.total_breakpoints} > 4`,
      JSON.stringify(a1.tool_names) !== JSON.stringify(b1.tool_names) && "tool list differs between families");
    out.push({ scenario: `Prompt caching (${src}): static block byte-identical across parents/times; ≤4 breakpoints; NOW last`, category: "prompt-cache", status: r ? "fail" : "pass", reply: null, reason: r,
      details: { static_sha: a1.static_sha, tools: a1.tool_names, breakpoints: a1.total_breakpoints } });
  }
  const c = estimateCostUsd("claude-sonnet-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000);
  const r2 = Math.abs(c - (3 + 15 + 3.75 + 0.3)) > 1e-9 ? `1M each of input/output/cache write/cache read = $${c}, want $22.05` : null;
  out.push({ scenario: "AI cost: Sonnet cache write = 1.25× input, cache read = 0.1× input", category: "prompt-cache", status: r2 ? "fail" : "pass", reply: null, reason: r2 });
  await resetTestData();
  return out;
}

// ── Outbound history: everything Monty sends is in the parent's conversation (no AI, stub sends, never Twilio) ──
async function sentRows(phone: string, source: string) {
  const { data: c } = await admin.from("conversations").select("id").eq("phone_number", phone).maybeSingle();
  if (!c) return [] as any[];
  const { data } = await admin.from("messages").select("content, source, school_email_id, metadata, message_type").eq("conversation_id", c.id).eq("direction", "outbound").eq("source", source);
  return data ?? [];
}
async function runOutboundTests(): Promise<Result[]> {
  const out: Result[] = [];
  const push = (scenario: string, reason: string | null | false, reply: string | null = null, details?: unknown) =>
    out.push({ scenario, category: "outbound", status: reason ? "fail" : "pass", reply, reason: reason || null, details } as Result);
  const pure = (scenario: string, f: () => string | null | false) => { try { push(scenario, f()); } catch (e) { push(scenario, (e as Error).message); } };
  pure("Short replies classified in code: yes / seen / thanks / 👍 / no; real content left to the AI", () => {
    const cases: [string, string | null][] = [["Yes", "yes"], ["yes please", "yes"], ["save it", "yes"], ["Add it for Ava", "yes"], ["Seen", "ack"], ["ok", "ack"], ["👍", "ack"],
      ["thanks!", "thanks"], ["Cheers", "thanks"], ["no thanks", "no"], ["the bus stop moved", null], ["Thanks Monty, that's brilliant", null], ["Ava", null], ["Mrs Smith is off sick", null]];
    const bad = cases.filter(([m, k]) => shortReplyKind(m, ["Ava", "Jude"]) !== k);
    return bad.length ? `wrong: ${bad.map(([m, k]) => `"${m}" → ${shortReplyKind(m, ["Ava", "Jude"])} (want ${k})`).join("; ")}` : null;
  });
  pure("Reply guard catches robotic wording ('no open question', 'not sure what you're saying yes to', how Monty works)", () => {
    const bad = ["Thanks! I'm not sure what you're saying yes to, though, because I don't have an open question for you.", "I don't have an open question right now.", "That's just how Monty works."].filter((x) => !isRoboticReply(x));
    return bad.length ? `missed: ${bad.join(" | ")}` : isRoboticReply("Great 😊") ? "flagged a normal reply" : null;
  });
  pure("'Mrs Smith is off sick' → a well-wish naming a child is dropped; 'she' becomes Mrs Smith", () => {
    const a = dropMisplacedWellWishes("Thanks for letting me know. I hope Harry's back soon!", "Mrs Smith is off sick", ["Harry"]);
    const b = dropMisplacedWellWishes("Thanks for letting me know, hope she's back soon!", "mrs smith is off sick", ["Harry"]);
    const c = dropMisplacedWellWishes("Oh no, I hope Harry feels better soon!", "Harry is off sick today", ["Harry"]);
    return firstFail(/Harry/.test(a) && `kept: "${a}"`, !/Mrs Smith is back soon/.test(b) && `got: "${b}"`, c !== "Oh no, I hope Harry feels better soon!" && `changed a real child illness: "${c}"`);
  });
  pure("Opt-in email rule: tournament / girls-only / 'selected' are opt-in; photos and trips aren't", () => {
    const want: [string, boolean][] = [["Y3/4 Girls Football Tournament", true], ["Year 6 boys netball", true], ["Children selected for cross country", true], ["Year 3 class photos", false], ["Y4 trip to Chester Zoo", false], ["Boys and girls football festival", false]];
    const bad = want.filter(([t, w]) => isOptInEmail(t) !== w);
    return bad.length ? `wrong: ${bad.map(([t]) => t).join(", ")}` : null;
  });
  pure("Template text is rendered with its fixed wording (body, variables, buttons)", () => {
    const t = contentText({ types: { "twilio/quick-reply": { body: "📢 From school: {{1}}", actions: [{ title: "Thanks" }] } } }, { "1": "Photos on Tuesday." });
    return t !== "📢 From school: Photos on Tuesday.\n[Thanks]" ? `got: ${JSON.stringify(t)}` : null;
  });

  // School email → test family A (Jude Y6, Harry Y3) + linked partner C, through the real handle-school-email pipeline.
  try {
    await resetTestData();
    await seedFamily("A", { partner: "C" });
    const send = (subject: string, extracted: Record<string, unknown>) => callFn("handle-school-email", { test_send: true, school_id: TEST_SCHOOL_ID, only_phones: [FAMILIES.A.phone, FAMILIES.C.phone], subject, extracted });
    const ex = { message: "⚽ The Y3/4 girls' football tournament is at Macc FC on Wednesday 21st October after school.", what: "Y3/4 girls' football tournament", yearGroups: ["Year 3", "Year 4"],
      eventTitle: "Y3/4 girls' football tournament", eventDate: "2026-10-21", optInGroup: "the Y3/4 girls' football team", links: [] };
    const r = await send("Y3/4 Girls Football Tournament", ex);
    const { data: log } = await admin.from("school_email_log").select("*").eq("id", r.data?.log_id ?? "00000000-0000-0000-0000-000000000000").maybeSingle();
    const a = await sentRows(FAMILIES.A.phone, "school_email"), c = await sentRows(FAMILIES.C.phone, "school_email");
    push("School email logged in school_email_log (subject, built message, year groups, opt-in, event, 1 family / 2 phones)",
      r.status !== 200 ? `HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` : !log ? "no log row"
        : firstFail(!log.opt_in && "opt_in false", log.families_count !== 1 && `families ${log.families_count}`, log.phones_count !== 2 && `phones ${log.phones_count}`,
          log.event_date !== "2026-10-21" && `event_date ${log.event_date}`, JSON.stringify(log.year_groups) !== JSON.stringify(["Year 3", "Year 4"]) && `years ${JSON.stringify(log.year_groups)}`, !log.is_test && "not marked as a test"),
      log?.message ?? null, log);
    push("School email written to each recipient's conversation (source school_email, linked to the log; partner gets their own copy)",
      firstFail(a.length !== 1 && `parent rows ${a.length}`, c.length !== 1 && `partner rows ${c.length}`,
        a[0] && a[0].school_email_id !== log?.id && "parent row not linked to the log", c[0] && c[0].school_email_id !== log?.id && "partner row not linked to the log",
        a[0] && !a[0].metadata?.rendered && "template wording couldn't be read (stored the variable only)"),
      a[0]?.content ?? null, { parent: a, partner: c });
    const v1 = a[0]?.metadata?.variables?.["1"] ?? "";
    push("Opt-in email starts with the conditional line naming the child: \"If Harry's in the Y3/4 girls' football team: …\"",
      firstFail(!v1.startsWith("If Harry's in the Y3/4 girls' football team: ⚽") && `got: "${v1}"`, /[\r\n]/.test(v1) && "newline in the template variable", /Jude/.test(v1) && "named the Year 6 child"), v1);
    push("Girls-only title: Harry still gets it (no gender filtering), worded conditionally", firstFail(a.length !== 1 && "not sent to Harry's family", !/^If Harry's in/.test(v1) && "no conditional line"), v1);
    await resetTestData();
    await seedFamily("A");
    const r2 = await send("Year 3 class photos", { message: "📸 Year 3 class photos are on Tuesday 3rd November.", what: "Year 3 class photos", yearGroups: ["Year 3"], eventTitle: "Year 3 class photos", eventDate: "2026-11-03", links: [] });
    const a2 = await sentRows(FAMILIES.A.phone, "school_email");
    const v2 = a2[0]?.metadata?.variables?.["1"] ?? "";
    push("Ordinary year-targeted email: \"For Harry: …\", not conditional, opt_in false",
      firstFail(r2.status !== 200 && `HTTP ${r2.status}`, r2.data?.opt_in !== false && "marked opt-in", !v2.startsWith("For Harry: 📸") && `got: "${v2}"`), v2);
    const refused = await callFn("handle-school-email", { test_send: true, school_id: TEST_SCHOOL_ID, only_phones: ["+447700900123"], subject: "x", extracted: ex });
    push("School email test send refuses a non-test phone number", refused.status !== 403 && `expected 403, got ${refused.status}`);
  } catch (e) { push("School email outbound tests: setup", (e as Error).message); }

  // Reminders (stub delivery) → morning/evening source in the conversation.
  try {
    await resetTestData();
    await seedSenderFixtures();
    const ev = await callFn("send-reminders", { scenario: "outbound: evening stub", period: "evening", now: "2026-10-06T17:00:00Z", scope: "test", only_phones: [FAMILY_A_PHONE], stub_send: true });
    const mo = await callFn("send-reminders", { scenario: "outbound: morning stub", period: "morning", now: "2026-10-06T06:00:00Z", scope: "test", only_phones: [FAMILY_A_PHONE], stub_send: true });
    const e = await sentRows(FAMILY_A_PHONE, "evening_reminder"), m = await sentRows(FAMILY_A_PHONE, "morning_reminder");
    push("Evening and morning reminders written to the conversation with their source (exact text sent)",
      firstFail(ev.status !== 200 && `evening HTTP ${ev.status}`, mo.status !== 200 && `morning HTTP ${mo.status}`, e.length !== 1 && `evening rows ${e.length}`, m.length !== 1 && `morning rows ${m.length}`,
        e[0] && !/gymnastics/i.test(e[0].content) && `evening text: ${e[0].content}`, m[0] && !/PE kit/i.test(m[0].content) && `morning text: ${m[0].content}`,
        e[0] && !e[0].metadata?.rendered && "reminder template wording couldn't be read"),
      `${e[0]?.content ?? ""}\n---\n${m[0]?.content ?? ""}`);
  } catch (e) { push("Reminder outbound tests: setup", (e as Error).message); }

  // Sunday check-in (stub) → sunday_checkin source with the week it covers.
  try {
    await resetTestData();
    const parentId = await ensureTestUser(SUNDAY_PHONE);
    const { data: kid } = await admin.from("children").insert({ parent_id: parentId, school_id: TEST_SCHOOL_ID, first_name: "Mila", year_group: "Year 5" }).select("id").single();
    await admin.from("child_reminders").insert({ child_id: kid!.id, parent_id: parentId, title: "PE kit", emoji: "👟", day_of_week: "Monday", reminder_time: "both", active: true, recurrence_interval: 1 });
    const s1 = await callFn("sunday-lunch-checkin", { scenario: "outbound: sunday stub", now: "2026-11-01T17:00:00Z", scope: "test", only_phones: [SUNDAY_PHONE], stub_send: true });
    const rows = await sentRows(SUNDAY_PHONE, "sunday_checkin");
    push("Sunday check-in written to the conversation (source sunday_checkin, week_start kept for 'yes')",
      firstFail(s1.status !== 200 && `HTTP ${s1.status}`, rows.length !== 1 && `rows ${rows.length}`, rows[0] && rows[0].metadata?.week_start !== "2026-11-02" && `week ${rows[0].metadata?.week_start}`,
        rows[0] && !/Mila/.test(rows[0].content) && `text: ${rows[0].content}`), rows[0]?.content ?? null);
  } catch (e) { push("Sunday outbound tests: setup", (e as Error).message); }

  // Family updates and alerts use the same helper (their real senders call it after Twilio accepts the message).
  try {
    await resetTestData();
    const id1 = await recordOutbound({ phone: FAMILIES.B.phone, source: "family_update", contentSid: Deno.env.get("TWILIO_FAMILY_UPDATE_TEMPLATE_SID") || "HX2b134e5257d687bab6f38904e73043b9", variables: { "1": "Rosa's swimming moved to Thursday (changed by Sam)" } });
    const id2 = await recordOutbound({ phone: FAMILIES.B.phone, source: "alert", text: "Monty system alert (not from a school): test" });
    const fu = await sentRows(FAMILIES.B.phone, "family_update"), al = await sentRows(FAMILIES.B.phone, "alert");
    push("Family update and alert records: right source, rendered text", firstFail(!id1 && "family update not recorded", !id2 && "alert not recorded",
      fu[0] && !/Rosa's swimming moved to Thursday/.test(fu[0].content) && `family update text: ${fu[0].content}`, fu[0] && !fu[0].metadata?.rendered && "family-update template wording couldn't be read",
      al.length !== 1 && `alert rows ${al.length}`), fu[0]?.content ?? null);
  } catch (e) { push("Family update outbound tests: setup", (e as Error).message); }
  await resetTestData();
  return out;
}

async function runSenderSuite(quick = false, free = false): Promise<Result[]> {
  // free = no AI at all (the "free tests"): skips the contact checks, which need the AI.
  const results: Result[] = [...(await runAlertTests()), ...(await runOptOutTests(quick || free)), ...(free ? [] : await runContactTests(quick)), ...(await runDeleteParentTests())];
  results.push(...(await runWhatsOnTests()));
  results.push(...(await runDashboardTests()));
  results.push(...runFormatTests());
  results.push(...(await runPromptCacheTests()));
  results.push(...runReplyGuardTests());
  await seedSenderFixtures();
  for (const c of SENDER_CASES) {
    const { status, data } = await callFn("send-reminders", {
      scenario: c.name, period: c.period, now: c.now, scope: "test", only_phones: [FAMILY_A_PHONE], ...(c.source ? { whats_on_source: c.source } : {}),
    });
    const msgs: string[] = (data.messages ?? []).map((m: any) => m.message);
    const reply = msgs[0] ?? null;
    let reason: string | null = null;
    if (status !== 200) reason = `HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`;
    else if (data.target_date !== c.expectTarget) reason = `target date ${data.target_date}, expected ${c.expectTarget}`;
    else if (c.expect === null && msgs.length > 0) reason = `expected no message, got: ${reply}`;
    else if (c.expect !== null) {
      if (msgs.length !== 1) reason = `expected 1 message, got ${msgs.length}`;
      else if (reply !== c.expect) reason = `expected "${c.expect}", got "${reply}"`;
      else if (/[\r\n]/.test(reply)) reason = "template variable contains a newline";
    }
    results.push({ scenario: c.name, category: "sender", status: reason ? "fail" : "pass", reply, reason, details: { now: c.now, period: c.period, source: data.source } });
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
  results.push(...(await runSundayCheckinTests()));
  return results;
}

// ── Sunday week-ahead check-in: whole-week holiday skip (no AI, stub send, never Twilio) ──
const SECOND_TEST_SCHOOL_ID = "6eebb5e3-5e2e-436f-ac72-c5c64d6ee8ff"; // registry school with no holidays/children/events
const SUNDAY_PHONE = "+447000000003";
async function runSundayCheckinTests(): Promise<Result[]> {
  const out: Result[] = [];
  const parentId = await ensureTestUser(SUNDAY_PHONE);
  const clearLog = () => admin.from("lunch_checkin_log").delete().eq("parent_id", parentId);
  const logRows = async (week: string) => (await admin.from("lunch_checkin_log").select("id").eq("parent_id", parentId).eq("week_start", week)).data?.length ?? -1;
  const run = (scenario: string, now: string) => callFn("sunday-lunch-checkin", { scenario, now, scope: "test", only_phones: [SUNDAY_PHONE], stub_send: true });
  const push = (scenario: string, reason: string | null, reply: string | null, details?: unknown) =>
    out.push({ scenario, category: "sender", status: reason ? "fail" : "pass", reply, reason, details } as Result);
  const holidayIds: string[] = [];
  const kidIds: string[] = [];
  try {
    await clearLog();
    const { data: mila, error } = await admin.from("children").insert({ parent_id: parentId, school_id: TEST_SCHOOL_ID, first_name: "Mila", year_group: "Year 5" }).select("id").single();
    if (error) throw new Error(`seed child: ${error.message}`);
    kidIds.push(mila.id);
    const r = (child_id: string, title: string, emoji: string, day: string) => ({ child_id, parent_id: parentId, title, emoji, day_of_week: day, reminder_time: "both", active: true, recurrence_interval: 1 });
    await admin.from("child_reminders").insert([r(mila.id, "PE kit", "👟", "Monday"), r(mila.id, "Library books", "📚", "Wednesday")]);
    const { data: hs } = await admin.from("school_holidays").insert([
      { school_id: TEST_SCHOOL_ID, label: "Test October half term", start_date: "2026-10-24", end_date: "2026-11-01" },
      { school_id: TEST_SCHOOL_ID, label: "Test INSET day", start_date: "2026-11-09", end_date: "2026-11-09" },
    ]).select("id");
    holidayIds.push(...(hs ?? []).map((h) => h.id));

    // 1) Whole week is a holiday → no message, no log row.
    const a = await run("sunday: whole-week holiday", "2026-10-25T17:00:00Z");
    const aRows = await logRows("2026-10-26");
    push("Sunday check-in: school on holiday all week (26–30 Oct) → no message, no log row",
      a.status !== 200 ? `HTTP ${a.status}: ${JSON.stringify(a.data).slice(0, 200)}`
        : a.data.week_start !== "2026-10-26" ? `week ${a.data.week_start}`
        : (a.data.delivered?.length ?? -1) !== 0 ? `expected no message, got ${JSON.stringify(a.data.delivered)}`
        : a.data.skipped_holiday !== 1 ? `skipped_holiday ${a.data.skipped_holiday}, expected 1`
        : aRows !== 0 ? `expected no lunch_checkin_log row, found ${aRows}` : null,
      null, a.data);

    // 2) Following week, school back → sent (and logged).
    const b = await run("sunday: school back", "2026-11-01T17:00:00Z");
    const bMsg = b.data.delivered?.[0]?.summary ?? null;
    const bWant = "*Monday:* 👟 Mila's PE kit | *Wednesday:* 📚 Mila's Library books";
    push("Sunday check-in: same family the following week (school back, 2 Nov) → message sent",
      b.status !== 200 ? `HTTP ${b.status}` : b.data.week_start !== "2026-11-02" ? `week ${b.data.week_start}`
        : (b.data.delivered?.length ?? 0) !== 1 ? `expected 1 message, got ${b.data.delivered?.length}`
        : bMsg !== bWant ? `expected "${bWant}"` : (await logRows("2026-11-02")) !== 1 ? "expected one log row for 2 Nov" : null,
      bMsg, b.data);

    // 3) One INSET day (Mon 9 Nov) → sent, Monday left out.
    const c = await run("sunday: one INSET day", "2026-11-08T17:00:00Z");
    const cMsg = c.data.delivered?.[0]?.summary ?? null;
    const cWant = "*Wednesday:* 📚 Mila's Library books";
    push("Sunday check-in: week with one INSET day (Mon 9 Nov) → sent, INSET day left out",
      c.status !== 200 ? `HTTP ${c.status}` : (c.data.delivered?.length ?? 0) !== 1 ? `expected 1 message, got ${c.data.delivered?.length}`
        : cMsg !== cWant ? `expected "${cWant}"` : null,
      cMsg, c.data);

    // 4) Two children at different schools, only one on holiday all week → sent.
    await clearLog();
    const { data: tom, error: tErr } = await admin.from("children").insert({ parent_id: parentId, school_id: SECOND_TEST_SCHOOL_ID, first_name: "Tom", year_group: "Year 2" }).select("id").single();
    if (tErr) throw new Error(`seed child 2: ${tErr.message}`);
    kidIds.push(tom.id);
    await admin.from("child_reminders").insert([r(tom.id, "Swimming", "🏊", "Tuesday")]);
    const d = await run("sunday: two schools, one on holiday", "2026-10-25T17:00:00Z");
    const dMsg = d.data.delivered?.[0]?.summary ?? null;
    const dWant = "*Tuesday:* 🏊 Tom's Swimming";
    push("Sunday check-in: two children at different schools, only one on holiday all week → sent",
      d.status !== 200 ? `HTTP ${d.status}` : (d.data.delivered?.length ?? 0) !== 1 ? `expected 1 message, got ${d.data.delivered?.length}`
        : d.data.skipped_holiday !== 0 ? `skipped_holiday ${d.data.skipped_holiday}` : dMsg !== dWant ? `expected "${dWant}"`
        : d.data.delivered[0].names !== "Mila and Tom" ? `names ${d.data.delivered[0].names}` : null,
      dMsg, d.data);

    // Safety: the entry point refuses a real number.
    const refused = await callFn("sunday-lunch-checkin", { scenario: "safety: real number refused", scope: "test", only_phones: ["+447700900123"], stub_send: true });
    out.push({ scenario: "Sunday check-in test entry refuses a non-test phone number", category: "safety", status: refused.status === 403 ? "pass" : "fail", reply: null, reason: refused.status === 403 ? null : `expected 403, got ${refused.status}` } as Result);
  } catch (e) {
    push("Sunday check-in tests: setup", (e as Error).message, null);
  } finally {
    await clearLog();
    if (kidIds.length) { await admin.from("child_reminders").delete().in("child_id", kidIds); await admin.from("children").delete().in("id", kidIds); }
    if (holidayIds.length) await admin.from("school_holidays").delete().in("id", holidayIds);
  }
  return out;
}

// ── Handler scenarios (real AI, dry run, never Twilio) ──

const FAMILIES: Record<string, { phone: string; kids: { name: string; year: string }[] }> = {
  A: { phone: "+447000000001", kids: [{ name: "Jude", year: "Year 6" }, { name: "Harry", year: "Year 3" }] },
  B: { phone: "+447000000002", kids: [{ name: "Rosa", year: "Year 4" }, { name: "Tom", year: "Year 2" }] },
  C: { phone: "+447000000003", kids: [{ name: "Mila", year: "Year 5" }] },
  D: { phone: "+447000000004", kids: [{ name: "Caspian", year: "Year 3" }, { name: "Ivy", year: "Year 1" }] },
};
const REAL_CONVERSATION_ID = "21634d6e-1eda-4198-b9be-5b8b1d716d54"; // read-only source for the replay test
const SYSTEM_WORDS = /NOT SAVED|POSSIBLE_DUPLICATE|ALREADY_SAVED|PENDING|TIMING|WAITING_FOR_PARENT|CONFIRM_STORED|ungrounded|tool_result|child_name|recurrence_interval/i;

type Msg = { role: "user" | "assistant"; content: string; at: string };
interface Seed {
  reminders?: { child: string; title: string; day: string; interval?: number; anchor?: string }[];
  holidays?: { start: string; end: string }[];
  partner?: keyof typeof FAMILIES; // that family's test number is linked as this family's partner (no children of its own)
  notes?: { child: string | null; summary: string; date: string }[];
  lunches?: { child: string; days: string[]; week: string }[];
  events?: { title: string; start: string; year_group: string | null }[];
  history?: Msg[];
  realHistory?: { from: string; to: string };
  // Messages Monty sent on its own (school email / reminder / Sunday check-in), stored like the real senders do.
  sent?: { source: string; text: string; at: string; meta?: Record<string, unknown>; email?: { subject: string; title: string | null; date: string | null; years: string[]; optIn?: boolean } }[];
}
interface Step { message: string; now?: string; fail_db?: boolean; fail_followup?: boolean; fail_claude?: boolean; from?: keyof typeof FAMILIES }
interface Rows {
  notes: { child: string | null; summary: string; dates: string[] }[];
  reminders: { child: string; title: string; day: string; interval: number; anchor: string | null }[];
  lunches: { child: string; days: string[]; week: string }[];
  pending: unknown;
  inactive: number;
  failedInbound: number;
  inbound: number;
  schools: Record<string, string>; // child name → school_id
  schoolChanges: number;           // school_changed decisions logged for this family's phone
  skips: string[];                 // child_reminder_skips dates ("Harry:Swimming:2026-10-07")
  exclusions: string[];            // event_exclusions ("Harry:Halloween Disco")
}
type StepOut = { familyUpdates: unknown[]; toolCalls: any[]; chatSource?: string };
interface HandlerCase {
  name: string; family: keyof typeof FAMILIES; now: string; seed?: Seed; steps: Step[];
  check: (after: Rows[], replies: string[], steps: StepOut[]) => string | null | Promise<string | null>;
  chatSource?: "legacy" | "new"; // forces chat_source for this case (Ask Monty cases need 'new')
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
      child_id: id(r.child), parent_id: parentId, title: r.title, emoji: "📌", day_of_week: r.day, reminder_time: "both", active: true, recurrence_interval: r.interval ?? 1, anchor_date: r.anchor ?? null,
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
  if (seed.events?.length) {
    const { error: e } = await admin.from("school_events").insert(seed.events.map((ev, i) => ({
      school_id: TEST_SCHOOL_ID, title: ev.title, start_at: ev.start, all_day: false, year_group: ev.year_group, uid: `monty-test-${i}-${Date.now()}`,
    })));
    if (e) throw new Error(`seed events: ${e.message}`);
  }
  if (seed.holidays?.length) {
    const { error: e } = await admin.from("school_holidays").insert(seed.holidays.map((h) => ({ school_id: TEST_SCHOOL_ID, label: "Test holiday", start_date: h.start, end_date: h.end })));
    if (e) throw new Error(`seed holidays: ${e.message}`);
  }
  if (seed.partner) {
    const partnerId = await ensureTestUser(FAMILIES[seed.partner].phone);
    const { error: e } = await admin.from("linked_accounts").insert({ primary_user_id: parentId, linked_user_id: partnerId, status: "accepted" });
    if (e) throw new Error(`seed partner: ${e.message}`);
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
  if (history.length || seed.sent?.length) {
    const { data: convo, error: ce } = await admin.from("conversations").insert({ phone_number: f.phone, current_step: "active" }).select("id").single();
    if (ce) throw new Error(`seed conversation: ${ce.message}`);
    if (history.length) await admin.from("messages").insert(history.map((m) => ({
      conversation_id: convo.id, direction: m.role === "user" ? "inbound" : "outbound", content: m.content, created_at: m.at,
    })));
    for (const m of seed.sent ?? []) {
      let logId: string | null = null;
      if (m.email) {
        const { data: log, error: le } = await admin.from("school_email_log").insert({ school_id: TEST_SCHOOL_ID, subject: m.email.subject, extracted: { what: m.email.title }, message: m.text,
          year_groups: m.email.years, opt_in: m.email.optIn ?? false, event_title: m.email.title, event_date: m.email.date, is_test: true, received_at: m.at }).select("id").single();
        if (le) throw new Error(`seed school email: ${le.message}`);
        logId = log.id;
      }
      const { error: me } = await admin.from("messages").insert({ conversation_id: convo.id, direction: "outbound", content: m.text, message_type: "template", source: m.source, school_email_id: logId, metadata: m.meta ?? null, created_at: m.at });
      if (me) throw new Error(`seed sent message: ${me.message}`);
    }
  }
}

async function familyRows(fam: keyof typeof FAMILIES): Promise<Rows> {
  const f = FAMILIES[fam];
  const ids = await testUserIds();
  const { data: kids } = await admin.from("children").select("id, first_name, school_id").in("parent_id", ids);
  const kidIds = (kids ?? []).map((k) => k.id);
  const { count: schoolChanges } = await admin.from("dedup_decisions").select("id", { count: "exact", head: true }).eq("phone_number", f.phone).eq("decision", "school_changed");
  const nameOf = (id: string) => kids?.find((k) => k.id === id)?.first_name ?? "?";
  const [notes, rems, lunches, convo, inact, fin] = await Promise.all([
    admin.from("parent_notes").select("child_name, summary, extracted_dates").eq("phone_number", f.phone),
    kidIds.length ? admin.from("child_reminders").select("child_id, title, day_of_week, recurrence_interval, anchor_date").eq("active", true).in("child_id", kidIds) : Promise.resolve({ data: [] as any[] }),
    kidIds.length ? admin.from("weekly_lunch_plans").select("child_id, packed_lunch_days, week_start").in("child_id", kidIds) : Promise.resolve({ data: [] as any[] }),
    admin.from("conversations").select("context").eq("phone_number", f.phone).maybeSingle(),
    kidIds.length ? admin.from("child_reminders").select("id", { count: "exact", head: true }).eq("active", false).in("child_id", kidIds) : Promise.resolve({ count: 0 } as any),
    admin.from("failed_inbound").select("id", { count: "exact", head: true }).eq("phone_number", f.phone).is("archived_at", null),
  ]);
  const { data: skipRows } = kidIds.length ? await admin.from("child_reminder_skips").select("skip_date, child_reminders!inner(title, child_id)").in("child_reminders.child_id", kidIds) : { data: [] as any[] };
  const { data: excRows } = kidIds.length ? await admin.from("event_exclusions").select("child_id, keyword").in("child_id", kidIds) : { data: [] as any[] };
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
    schools: Object.fromEntries((kids ?? []).map((k: any) => [k.first_name, k.school_id])),
    schoolChanges: schoolChanges ?? 0,
    skips: (skipRows ?? []).map((x: any) => `${nameOf(x.child_reminders.child_id)}:${x.child_reminders.title}:${x.skip_date}`).sort(),
    exclusions: (excRows ?? []).map((x: any) => `${nameOf(x.child_id)}:${x.keyword}`).sort(),
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
    check: ([r], [reply]) => firstFail(r.reminders.length > 0 && `saved without anchor: ${JSON.stringify(r.reminders)}`, !asks(reply) && "didn't ask a question", !/when|date|next/i.test(reply) && "didn't ask for the next date",
      /haven'?t saved anything yet/i.test(reply) && "reply replaced by the 'haven't saved' fallback") },
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

// ── held as a possible duplicate of a school event (real bug, Sun 18 Oct) ──
// Year groups use the real row's format ("Year 3,Year 4"), so each test asks/saves for the reason in its name.
const FOOTBALL_EVENT = { title: "Y3/4 Mixed Football Tournament @ Macc FC", start: "2026-10-21T14:00:00Z", year_group: "Year 3,Year 4" };
const SUN_PM = "2026-10-18T17:28:00Z"; // Sun 18 Oct 18:28 BST
const SCHOOL_EVENT_Y5 = { title: "Y5 Football Tournament", start: "2026-10-21T14:00:00Z", year_group: "Year 5" };
const SCHOOL_EVENT_NO_TOPIC = { title: "Y3/4 Mixed Tournament @ Macc FC", start: "2026-10-21T14:00:00Z", year_group: "Year 3,Year 4" };
const SCHOOL_EVENT_NO_YEAR = { title: "Y3/4 Mixed Football Tournament @ Macc FC", start: "2026-10-21T14:00:00Z", year_group: null };
const CASPIAN_MSG = "Caspian has a football tournament after school on Wednesday";
/** Clear match (Year 3 on a Y3/4 event, same day, shared "football"): saves at once, no question. */
const clearMatchCheckFor = (titleRe: RegExp, notRe?: RegExp) => ([r]: Rows[], [a]: string[]) => {
  const n = noteFor(r, "Caspian", "2026-10-21", titleRe);
  if (notRe && r.notes.some((x: any) => notRe.test(x.summary || ""))) return `saved under the wrong event: ${JSON.stringify(r.notes)}`;
  return firstFail(n.length !== 1 && `expected one Caspian note on 21 Oct under the school event's title: ${JSON.stringify(r.notes)}`,
    r.notes.length !== 1 && `extra notes: ${JSON.stringify(r.notes)}`, r.reminders.length > 0 && "weekly reminder saved",
    asks(a) && `asked a question: "${a}"`, !/caspian/i.test(a) && "reply doesn't name Caspian", !/✅/.test(a) && `not the short confirmation: "${a}"`,
    r.pending !== null && "left a pending question");
};
const clearMatchCheck = clearMatchCheckFor(/Macc FC/i);
const GIRLS_EVENT = { title: "Y3/4 Girls Football Tournament @ Macc FC", start: "2026-10-21T14:00:00Z", year_group: "Year 3,Year 4" };
/** Real doubt: must ask the stored "different one?" question first, then save exactly one note. */
const stillAsksCheck = (eventRe: RegExp, savedRe: RegExp = /football/i) => ([r1, r2]: Rows[], [q1, a]: string[]) => {
  const n = noteFor(r2, "Caspian", "2026-10-21", savedRe);
  return firstFail(total(r1) > 0 && `saved before asking: ${JSON.stringify(r1)}`,
    !(eventRe.test(q1) && /different/i.test(q1) && asks(q1)) && `didn't ask the same-thing question: "${q1}"`,
    /which child/i.test(q1 + a) && "asked which child",
    n.length !== 1 && `expected one Caspian note on 21 Oct matching ${savedRe}: ${JSON.stringify(r2.notes)}`, r2.notes.length !== 1 && `extra notes: ${JSON.stringify(r2.notes)}`,
    asks(a) && `asked again: "${a}"`, !/caspian/i.test(a) && `reply doesn't name Caspian: "${a}"`, r2.pending !== null && "pending not cleared");
};
HANDLER_CASES.push(
  { name: "Clear school-event match (Year 3, Y3/4 football, same day) → saved at once, no question", family: "D", now: SUN_PM, seed: { events: [FOOTBALL_EVENT] },
    steps: [{ message: CASPIAN_MSG }], check: clearMatchCheck },
  { name: "Two Y3/4 football events same day + 'girls football tournament' → saved under the Girls title", family: "D", now: SUN_PM, seed: { events: [FOOTBALL_EVENT, GIRLS_EVENT] },
    steps: [{ message: "Caspian has a girls football tournament after school on Wednesday" }], check: clearMatchCheckFor(/Girls Football Tournament/i, /Mixed/i) },
  { name: "School event for another year (Y5) → still asks, 'yes please' saves one note", family: "D", now: SUN_PM, seed: { events: [SCHOOL_EVENT_Y5] },
    steps: [{ message: CASPIAN_MSG }, { message: "Yes please" }], check: stillAsksCheck(/Y5 Football/i) },
  { name: "School event with no shared topic word → still asks, 'yes please' saves one note", family: "D", now: SUN_PM, seed: { events: [SCHOOL_EVENT_NO_TOPIC] },
    steps: [{ message: CASPIAN_MSG }, { message: "Yes please" }], check: stillAsksCheck(/Mixed Tournament/i) },
  { name: "School event with no year group → still asks (unknown year isn't a clear match), 'yes please' saves one note", family: "D", now: SUN_PM, seed: { events: [SCHOOL_EVENT_NO_YEAR] },
    steps: [{ message: CASPIAN_MSG }, { message: "Yes please" }], check: stillAsksCheck(/Mixed Football Tournament/i) },
  { name: "Duplicate question → 'no, it's the same one' saves one note under the school event's title", family: "D", now: SUN_PM, seed: { events: [SCHOOL_EVENT_NO_TOPIC] },
    steps: [{ message: CASPIAN_MSG }, { message: "no, it's the same one" }], check: stillAsksCheck(/Mixed Tournament/i, /Mixed Tournament/i) },
);

// "You've got the wrong school" (family C: Mila, at the test school). Never "wrong number"; change only after confirm.
const WRONG_SCHOOL_MSG = "I'm not with that school";
const schoolUnchanged = (r: Rows) => r.schools["Mila"] === TEST_SCHOOL_ID && r.schoolChanges === 0;
HANDLER_CASES.push(
  { name: "'I'm not with that school' → asks which school with the dashboard link, never 'wrong number', nothing changed", family: "C", now: MON,
    steps: [{ message: WRONG_SCHOOL_MSG }],
    check: ([r], [a]) => firstFail(/wrong number/i.test(a) && `said wrong number: "${a}"`, !/which school/i.test(a) && `didn't ask which school: "${a}"`,
      !/mila/i.test(a) && "doesn't name Mila", !/heymonty\.co\.uk\/dashboard/.test(a) && "no dashboard link", !schoolUnchanged(r) && "school changed",
      (r.pending as any)?.kind !== "school" && "school question not stored", total(r) > 0 && "something was saved") },
  { name: "Wrong school → 'St Joseph's in Stockport' → matches with town + postcode → '1' → confirm → 'yes' changes it (logged)", family: "C", now: MON,
    steps: [{ message: WRONG_SCHOOL_MSG }, { message: "St Joseph's in Stockport" }, { message: "1" }, { message: "yes" }],
    check: ([, r2, r3, r4], [, offer, confirm, done]) => {
      const opts = (r2.pending as any)?.school?.options ?? [];
      const chosen = (r3.pending as any)?.school?.chosen;
      return firstFail(!opts.length && `no options stored: "${offer}"`, !/SK1 1EF/.test(offer) || !/Stockport/.test(offer) || !/^1\. /m.test(offer) ? `options lack town/postcode/numbers: "${offer}"` : false,
        !schoolUnchanged(r2) && "changed before picking", !schoolUnchanged(r3) && "changed before confirming",
        !/just to check/i.test(confirm) && `no confirm question: "${confirm}"`, chosen?.id !== opts[0]?.id && "'1' didn't choose the first option",
        r4.schools["Mila"] !== opts[0]?.id && `school not changed to option 1: ${r4.schools["Mila"]}`, r4.schoolChanges !== 1 && `school_changed logged ${r4.schoolChanges} times`,
        !/done/i.test(done) || !/mila/i.test(done) ? `no confirmation naming Mila: "${done}"` : false, r4.pending !== null && "pending not cleared");
    } },
  { name: "Wrong-school question + unrelated 'What's on tomorrow?' → question dropped, school unchanged", family: "C", now: MON,
    steps: [{ message: WRONG_SCHOOL_MSG }, { message: "What's on tomorrow?" }],
    check: ([, r2], [, a]) => firstFail(r2.pending !== null && (r2.pending as any)?.kind === "school" && "school question still pending",
      !schoolUnchanged(r2) && "school changed", /I found these|which school|couldn'?t find that school/i.test(a) && `still on the school question: "${a}"`) },
);


// ── Ask Monty (chat_source 'new'): look up, cancel, stop, hide — rules in code, replies built from real results ──
const SWIM = [{ child: "Harry", title: "Swimming", day: "Wednesday" }];
const usedLookup = (o: StepOut) => o.toolCalls.some((t: any) => t.name === "lookup_whats_on");
/** The exact reply the lookup should give: getWhatsOn's items for the family, in reminder wording. */
async function expectedLookup(fam: keyof typeof FAMILIES, from: string, to: string, today: string) {
  const uid = await ensureTestUser(FAMILIES[fam].phone);
  const data = await loadFamilyData(admin as any, uid, from, to);
  return lookupReply({ from, to, today, child: null, item: null, days: whatsOnDays(computeWhatsOn(data, from, to), data.children.map((c) => c.first_name)) });
}
async function senderLine(now: string): Promise<string> {
  const { data } = await callFn("send-reminders", { scenario: "ask monty: next week still sent", period: "evening", now, scope: "test", only_phones: [FAMILY_A_PHONE], whats_on_source: "new" });
  return ((data.messages ?? []) as any[]).map((m) => m.message).join(" | ");
}
const ASK_CASES: HandlerCase[] = [
  { name: "Ask Monty: 'What's on tomorrow?' with mixed items → exactly getWhatsOn's items, in reminder wording", family: "A", now: MON, chatSource: "new",
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }], notes: [{ child: "Jude", summary: "Jude recorder", date: "2026-10-06" }], lunches: [{ child: "Jude", days: ["Tuesday"], week: WK }],
      events: [{ title: "Halloween Disco", start: "2026-10-06T17:00:00Z", year_group: "all" }, { title: "Y3/4 Football", start: "2026-10-06T15:30:00Z", year_group: "Year 3,Year 4" }] },
    steps: [{ message: "What's on tomorrow?" }],
    check: async ([r], [a], [o]) => {
      const want = await expectedLookup("A", "2026-10-06", "2026-10-06", "2026-10-05");
      return firstFail(!usedLookup(o) && "lookup tool not used", a !== want && `reply differs from getWhatsOn: expected ${JSON.stringify(want)}`, total(r) !== 3 && "rows changed");
    } },
  { name: "Ask Monty: fortnightly item on its off-week → not listed", family: "A", now: MON, chatSource: "new",
    seed: { reminders: [{ child: "Harry", title: "Forest School", day: "Thursday", interval: 2, anchor: "2026-10-01" }] },
    steps: [{ message: "Is there Forest School this week?" }],
    check: ([], [a], [o]) => firstFail(!usedLookup(o) && "lookup tool not used", !/nothing saved/i.test(a) && `expected nothing saved: "${a}"`, /8th|🌳/.test(a) && `listed the off-week Forest School: "${a}"`) },
  { name: "Ask Monty: during a holiday → school items not listed", family: "A", now: MON, chatSource: "new",
    seed: { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }], lunches: [{ child: "Jude", days: ["Tuesday"], week: WK }], holidays: [{ start: "2026-10-06", end: "2026-10-06" }] },
    steps: [{ message: "What's on tomorrow?" }],
    check: ([], [a], [o]) => firstFail(!usedLookup(o) && "lookup tool not used", !/nothing saved/i.test(a) && `expected nothing saved: "${a}"`, /pe kit|packed lunch/i.test(a) && `listed a holiday item: "${a}"`) },
  { name: "Ask Monty: 'Cancel Harry's swimming this week' → confirm → 'yes' skips only that date, next week's still sent", family: "A", now: MON, chatSource: "new",
    seed: { reminders: SWIM }, steps: [{ message: "Cancel Harry's swimming this week" }, { message: "yes" }],
    check: async ([r1, r2], [q, a]) => {
      const thisWeek = await senderLine("2026-10-06T17:00:00Z"), nextWeek = await senderLine("2026-10-13T17:00:00Z");
      return firstFail(r1.skips.length > 0 && "changed before confirming", !/^Cancel Harry's swimming just this Wednesday 7th\? Yes \/ No$/.test(q) && `confirm question: "${q}"`,
        (r1.pending as any)?.kind !== "edit" && "question not stored", JSON.stringify(r2.skips) !== JSON.stringify(["Harry:Swimming:2026-10-07"]) && `skips: ${JSON.stringify(r2.skips)}`,
        remFor(r2, "Harry", "Wednesday", /swim/i).length !== 1 && "weekly reminder not kept active", a !== "Done, Harry's swimming is off for Wednesday 7th ✅" && `confirmation: "${a}"`,
        /swim/i.test(thisWeek) && `still sent this week: ${thisWeek}`, !/swim/i.test(nextWeek) && `next week's not sent: ${nextWeek || "(nothing)"}`, r2.pending !== null && "pending not cleared");
    } },
  { name: "Ask Monty: 'Harry's stopped swimming' → confirm → deactivated, partner gets the family update", family: "A", now: MON, chatSource: "new",
    seed: { reminders: SWIM, partner: "C" }, steps: [{ message: "Harry's stopped swimming" }, { message: "yes" }],
    check: ([r1, r2], [q, a], [, o2]) => firstFail(r1.inactive !== 0 && "changed before confirming", !/^Stop Harry's swimming for good/.test(q) && `confirm question: "${q}"`,
      r2.inactive !== 1 || remFor(r2, "Harry", "Wednesday", /swim/i).length !== 0 ? `not deactivated: ${JSON.stringify(r2.reminders)} inactive ${r2.inactive}` : false,
      !/^Done, Harry's swimming is stopped/.test(a) && `confirmation: "${a}"`, (o2.familyUpdates ?? []).length !== 1 && `family updates: ${JSON.stringify(o2.familyUpdates)}`) },
  { name: "Ask Monty: 'Delete the school disco' → it's from school, offers to hide it; 'yes' hides it for the children", family: "A", now: MON, chatSource: "new",
    seed: { events: [{ title: "Halloween Disco", start: "2026-10-09T17:00:00Z", year_group: "all" }] }, steps: [{ message: "Delete the school disco" }, { message: "yes" }],
    check: ([r1, r2], [q, a]) => firstFail(!/from the school/i.test(q) || !/hide/i.test(q) ? `didn't explain + offer to hide: "${q}"` : false, r1.exclusions.length > 0 && "hidden before confirming",
      JSON.stringify(r2.exclusions) !== JSON.stringify(["Harry:Halloween Disco", "Jude:Halloween Disco"]) && `exclusions: ${JSON.stringify(r2.exclusions)}`, !/hidden/i.test(a) && `confirmation: "${a}"`) },
  { name: "Ask Monty: partner asks about an item the other partner saved → found", family: "A", now: MON, chatSource: "new",
    seed: { notes: [{ child: "Harry", summary: "Harry dentist", date: "2026-10-08" }], partner: "C" }, steps: [{ message: "When is Harry's dentist?", from: "C" }],
    check: ([], [a], [o]) => firstFail(!usedLookup(o) && "lookup tool not used", !/dentist/i.test(a) || !/Thursday 8th/.test(a) ? `not found: "${a}"` : false) },
  { name: "Ask Monty: nonsense item → 'I can't find that', nothing changed", family: "A", now: MON, chatSource: "new",
    seed: { reminders: SWIM }, steps: [{ message: "Cancel Harry's unicorn parade on Friday" }],
    check: ([r], [a]) => firstFail(!/can'?t find/i.test(a) && `reply: "${a}"`, r.skips.length + r.inactive + r.notes.length + r.exclusions.length > 0 && `something changed: ${JSON.stringify(r)}`,
      (r.pending as any)?.kind === "edit" && "asked to confirm a change") },
  { name: "Ask Monty: change fails ('yes' with a forced database failure) → honest 'couldn't', never claims it", family: "A", now: MON, chatSource: "new",
    seed: { reminders: SWIM }, steps: [{ message: "Cancel Harry's swimming this week" }, { message: "yes", fail_db: true }],
    check: ([, r2], [, a]) => firstFail(!/couldn'?t/i.test(a) && `reply: "${a}"`, /\bdone\b|is off/i.test(a) && `claimed the change: "${a}"`, r2.skips.length > 0 && "skip written",
      remFor(r2, "Harry", "Wednesday", /swim/i).length !== 1 && "reminder changed") },
];
HANDLER_CASES.push(...ASK_CASES);

// ── Replies to messages Monty sent on its own (school emails, reminders, Sunday check-in) ──
const ROBOTIC = /open question|not sure what you'?re saying yes to|how monty works/i;
const GIRLS_EMAIL = { source: "school_email", at: "2026-10-18T13:42:00Z",
  text: "📢 School update: If Harry's in the Y3/4 girls' football team: ⚽ The Y3/4 girls' football tournament is at Macc FC on Wednesday 21st October after school.",
  email: { subject: "Y3/4 Girls Football Tournament", title: "Y3/4 girls' football tournament", date: "2026-10-21", years: ["Year 3", "Year 4"], optIn: true } };
const MON19 = "2026-10-19T08:00:00Z"; // Mon 19 Oct 09:00 BST
const SENT_CASES: HandlerCase[] = [
  { name: "School email (Y3/4 girls' football, Wed 21 Oct) → 'Yes' → saved for Harry, short confirmation, no robotic wording", family: "A", now: MON19,
    seed: { sent: [GIRLS_EMAIL] }, steps: [{ message: "Yes" }],
    check: ([r], [a]) => firstFail(noteFor(r, "Harry", "2026-10-21", /football/i).length !== 1 && `expected one football note for Harry on 21 Oct: ${JSON.stringify(r.notes)}`,
      r.notes.length !== 1 && `extra rows: ${JSON.stringify(r.notes)}`, !/Harry/.test(a) && `reply doesn't name Harry: "${a}"`, !/✅/.test(a) && `no confirmation: "${a}"`,
      a.includes("?") && `asked a question: "${a}"`, ROBOTIC.test(a) && `robotic: "${a}"`, a.length > 120 && "confirmation too long") },
  { name: "School email → 'Seen' → short warm reply, nothing saved", family: "A", now: MON19,
    seed: { sent: [GIRLS_EMAIL] }, steps: [{ message: "Seen" }],
    check: ([r], [a]) => firstFail(total(r) > 0 && `saved something: ${JSON.stringify(r.notes)}`, a.length > 60 && `not short: "${a}"`, a.includes("?") && `asked: "${a}"`, ROBOTIC.test(a) && `robotic: "${a}"`) },
  { name: "Evening reminder → 'thanks' → short warm reply, nothing saved", family: "A", now: "2026-10-05T18:30:00Z",
    seed: { sent: [{ source: "evening_reminder", at: "2026-10-05T17:00:00Z", text: "Good evening! 🌙 Here's what's on tomorrow:\n👟 Harry: PE kit\nSleep well!" }] }, steps: [{ message: "thanks" }],
    check: ([r], [a]) => firstFail(total(r) > 0 && "saved something", a.length > 60 && `not short: "${a}"`, a.includes("?") && `asked: "${a}"`, ROBOTIC.test(a) && `robotic: "${a}"`) },
  { name: "Sunday check-in → 'yes' → this week's lunch plan confirmed, nothing changed", family: "A", now: MON_AM,
    seed: { lunches: [{ child: "Jude", days: ["Monday", "Wednesday"], week: WK }, { child: "Harry", days: [], week: WK }],
      sent: [{ source: "sunday_checkin", at: "2026-10-04T16:00:00Z", meta: { week_start: WK }, text: "Hi! Here's the week ahead for Jude and Harry (5 Oct-9 Oct). ✅ Already saved: Jude - packed lunch Mon, Wed; Harry - school dinners all week. Only reply if anything's changed." }] },
    steps: [{ message: "yes" }],
    check: ([r], [a]) => firstFail(!/confirmed/i.test(a) && `not confirmed: "${a}"`, !/Jude/.test(a) && `doesn't name Jude: "${a}"`, !eq(lunchDays(r, "Jude", WK), ["Monday", "Wednesday"]) && `Jude's plan changed: ${lunchDays(r, "Jude", WK)}`,
      r.notes.length + r.reminders.length > 0 && "saved something else", ROBOTIC.test(a) && `robotic: "${a}"`) },
  { name: "'Yes' with nothing recent → one specific friendly question, never 'I don't have an open question'", family: "A", now: MON,
    steps: [{ message: "Yes" }],
    check: ([r], [a]) => firstFail(total(r) > 0 && "saved something", (a.match(/\?/g) ?? []).length !== 1 && `expected one question: "${a}"`, ROBOTIC.test(a) && `robotic: "${a}"`, /not sure/i.test(a) && `"not sure": "${a}"`) },
  { name: "'Mrs Smith is off sick' → no 'hope <child> is back soon', nothing saved", family: "A", now: MON,
    steps: [{ message: "Mrs Smith is off sick" }],
    check: ([r], [a]) => firstFail(total(r) > 0 && "saved something", /\b(Jude|Harry)\b[^.!?]*(back soon|better|well soon|recover)|(hope|wish)[^.!?]*\b(Jude|Harry)\b/i.test(a) && `well-wish aimed at a child: "${a}"`, ROBOTIC.test(a) && `robotic: "${a}"`) },
];
HANDLER_CASES.push(...SENT_CASES);

// Quick suite: the core conversation checks (~10 AI scenarios) run after every change.
const QUICK_NAMES = [
  "New weekly reminder",
  "'Harry needs PE kit just this Wednesday' → dated note, no question",
  "No child named, 2 children → asks which child, then 'Jude' saves for Jude",
  "No match: 'Harry needs his swim bag tomorrow' → asks just tomorrow or every Tuesday; 'just tomorrow' → one dated note",
  "Existing weekly swimming (Tue) + 'Jude needs his swim bag tomorrow' on Monday → already on the list",
  "Old 'gymnastics tomorrow' in history + unrelated new message → nothing re-saved",
  "'Harry's PE is now on Wednesdays instead' (no old day named) → the one PE reminder moves",
  "General question → nothing saved, no success claim",
  "Forced database failure → warm, specific 'couldn't save', nothing written",
  "'He needs his recorder Friday' (Jude & Harry) → reply uses no he/she/his/her",
  "Clear school-event match (Year 3, Y3/4 football, same day) → saved at once, no question",
  "Two Y3/4 football events same day + 'girls football tournament' → saved under the Girls title",
  "School event for another year (Y5) → still asks, 'yes please' saves one note",
  "School event with no shared topic word → still asks, 'yes please' saves one note",
  "School event with no year group → still asks (unknown year isn't a clear match), 'yes please' saves one note",
  "Duplicate question → 'no, it's the same one' saves one note under the school event's title",
  "'I'm not with that school' → asks which school with the dashboard link, never 'wrong number', nothing changed",
  "Wrong school → 'St Joseph's in Stockport' → matches with town + postcode → '1' → confirm → 'yes' changes it (logged)",
  "Wrong-school question + unrelated 'What's on tomorrow?' → question dropped, school unchanged",
  ...ASK_CASES.map((c) => c.name),
  ...SENT_CASES.map((c) => c.name),
];
function casesFor(suite: string): HandlerCase[] {
  if (suite !== "quick") return HANDLER_CASES;
  const list = HANDLER_CASES.filter((c) => QUICK_NAMES.includes(c.name));
  if (list.length !== QUICK_NAMES.length) throw new Error(`quick suite: ${QUICK_NAMES.length - list.length} scenario names not found`);
  return list;
}

type CaseOut = { reason: string | null; reply: string | null; details: unknown; usage: { input: number; output: number; cache_write: number; cache_read: number; calls: number; ms: number; truncated: number; turns: number; model?: string } };
async function runHandlerCase(c: HandlerCase): Promise<CaseOut> {
  await resetTestData();
  await seedFamily(c.family, c.seed);
  const after: Rows[] = []; const replies: string[] = []; const calls: unknown[] = []; const outs: StepOut[] = [];
  const usage: CaseOut["usage"] = { input: 0, output: 0, cache_write: 0, cache_read: 0, calls: 0, ms: 0, truncated: 0, turns: 0 };
  const turnMs: number[] = [];
  for (const step of c.steps) {
    const { status, data } = await callFn("whatsapp-webhook", {
      scenario: c.name, phone: FAMILIES[step.from ?? c.family].phone, message: step.message, now: step.now ?? c.now,
      ...((c.chatSource ?? CHAT_SOURCE) ? { chat_source: c.chatSource ?? CHAT_SOURCE } : {}),
      fail_db: step.fail_db === true, fail_followup: step.fail_followup === true, fail_claude: step.fail_claude === true, dry_run: true,
    });
    if (status !== 200) return { reason: `HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`, reply: null, details: null, usage };
    if (data.twilio_called !== false) return { reason: "Twilio not confirmed off", reply: null, details: null, usage };
    usage.input += data.usage?.input ?? 0; usage.output += data.usage?.output ?? 0; usage.calls += data.usage?.calls ?? 0; usage.cache_write += data.usage?.cache_write ?? 0; usage.cache_read += data.usage?.cache_read ?? 0;
    usage.ms += data.usage?.ms ?? 0; usage.truncated += data.usage?.truncated ?? 0; if (data.usage?.calls) { usage.turns++; turnMs.push(data.usage.ms ?? 0); } if (data.usage?.model) usage.model = data.usage.model;
    replies.push(data.reply ?? ""); calls.push(data.tool_calls); outs.push({ familyUpdates: data.family_updates ?? [], toolCalls: data.tool_calls ?? [], chatSource: data.chat_source });
    after.push(await familyRows(c.family));
  }
  const kidNames = FAMILIES[c.family].kids.map((k) => k.name);
  const confirmations = replies.map((r, i) => ({ r, asked: c.steps[i].message.includes("?") }))
    .filter((x) => /saved ✅|has moved to/i.test(x.r) && !/sorry|couldn'?t/i.test(x.r));
  const badConf = confirmations.find((x) => !x.asked && (x.r.includes("\n") || x.r.length > 120 || !kidNames.some((n) => x.r.includes(n)) || /remind you/i.test(x.r)));
  const sys = replies.find((r) => SYSTEM_WORDS.test(r));
  const pron = replies.find((r) => /\b(he|she|his|her|him)\b/i.test(r));
  const empty = replies.findIndex((r) => !r.trim());
  const reason = sys ? `system wording reached the parent: "${sys.slice(0, 120)}"` : pron ? `pronoun used for a child: "${pron.slice(0, 160)}"` : empty >= 0 ? `empty reply at step ${empty + 1}` : badConf ? `confirmation not one short line naming the child: "${badConf.r}"` : await c.check(after, replies, outs);
  const reply = c.steps.length > 1 ? c.steps.map((s, i) => `Parent: ${s.message}\nMonty: ${replies[i]}`).join("\n") : replies[0];
  return { reason, reply, details: { rows: after[after.length - 1], tool_calls: calls, chat_source: outs.map((o) => o.chatSource), family_updates: outs.map((o) => o.familyUpdates), confirmations: confirmations.map((x) => x.r), model: usage.model, ai_ms_per_turn: turnMs, truncated: usage.truncated }, usage };
}

const usageTotals = { input: 0, output: 0, cache_write: 0, cache_read: 0, calls: 0, ms: 0, truncated: 0, turns: 0, model: "" };
async function runHandlerSlice(offset: number, limit: number, cases: HandlerCase[] = HANDLER_CASES): Promise<Result[]> {
  const out: Result[] = [];
  for (const c of cases.slice(offset, offset + limit)) {
    let r = await runHandlerCase(c);
    let status: Result["status"] = r.reason ? "fail" : "pass";
    const add = (u: CaseOut["usage"]) => { usageTotals.input += u.input; usageTotals.output += u.output; usageTotals.cache_write += u.cache_write; usageTotals.cache_read += u.cache_read; usageTotals.calls += u.calls; usageTotals.ms += u.ms; usageTotals.truncated += u.truncated; usageTotals.turns += u.turns; if (u.model) usageTotals.model = u.model; };
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
  // Test-only override of the reminder rules for this whole run (never touches app_settings).
  SENDER_SOURCE = body.whats_on_source === "new" || body.whats_on_source === "legacy" ? body.whats_on_source : null;
  CHAT_SOURCE = body.chat_source === "new" || body.chat_source === "legacy" ? body.chat_source : null;
  // Diagnosis helper: run one scenario N times (no retry), return outcomes + any recorded outage errors.
  if (action === "repeat_case") {
    const c = HANDLER_CASES.find((x) => x.name === body.scenario);
    if (!c) return json({ error: "unknown scenario" }, 400);
    const start = new Date().toISOString(); const runs: unknown[] = [];
    for (let i = 0; i < Math.min(Number(body.times) || 1, 3); i++) {
      const r = await runHandlerCase(c); runs.push({ ok: !r.reason, reason: r.reason, reply: r.reply, ms: r.usage.ms, calls: r.usage.calls, truncated: r.usage.truncated });
    }
    await resetTestData();
    const { data: fails } = await admin.from("failed_inbound").select("created_at, step, status_code, elapsed_ms, error, error_body").eq("phone_number", FAMILIES[c.family].phone).gte("created_at", start);
    return json({ runs, outages: fails });
  }

  // Post-switch check: send messages for test family A using the LIVE chat_source setting (nothing forced), dry run, then reset.
  if (action === "chat_try") {
    const seed: Seed = { reminders: [{ child: "Harry", title: "PE kit", day: "Tuesday" }], notes: [{ child: "Jude", summary: "Jude recorder", date: "2026-10-06" }], lunches: [{ child: "Jude", days: ["Tuesday"], week: WK }],
      events: [{ title: "Halloween Disco", start: "2026-10-06T17:00:00Z", year_group: "all" }] };
    const msgs: string[] = Array.isArray(body.messages) ? body.messages.slice(0, 3).map(String) : [];
    const out: unknown[] = [];
    try {
      for (const m of msgs) {
        await resetTestData(); await seedFamily("A", seed);
        const { status, data } = await callFn("whatsapp-webhook", { scenario: "chat_try", phone: FAMILIES.A.phone, message: m, now: MON, dry_run: true });
        out.push({ message: m, status, reply: data.reply ?? null, chat_source: data.chat_source, twilio_called: data.twilio_called, tools: (data.tool_calls ?? []).map((t: any) => t.name ?? t.tool), rows_after: await familyRows("A") });
      }
    } finally { await resetTestData(); }
    return json({ results: out });
  }

  // Read-only preview of a real reminder run (send-reminders real_readonly: builds only, never sends, phones masked).
  // Read-only preview of a real Sunday check-in (build only, never sends, phones masked).
  if (action === "sunday_preview") {
    const { status, data } = await callFn("sunday-lunch-checkin", { scenario: "sunday preview", scope: "real_readonly", now: body.now, ignore_sent_log: body.ignore_sent_log === true });
    return json(data, status === 200 ? 200 : 500);
  }

  if (action === "reminder_preview") {
    const period = body.period === "morning" ? "morning" : "evening";
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-reminders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "x-monty-test-secret": Deno.env.get("MONTY_TEST_SECRET")! },
      body: JSON.stringify({ scenario: "reminder preview", scope: "real_readonly", period, now: body.now, with_freeform: true, ignore_sent_log: true }),
    });
    return json(await res.json().catch(() => ({ error: `HTTP ${res.status}` })), res.ok ? 200 : 500);
  }

  if (action === "chat_shadow") {
    try { return json(await runChatShadow(admin, { now: body.now })); }
    catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  if (action === "whats_on_shadow") {
    try { return json(await runWhatsOnShadow(admin, { days: Number(body.days) || 14, now: body.now })); }
    catch (e) {
      const msg = (e as Error).message;
      console.error("[shadow] failed:", msg);
      if (body.scheduled === true) {
        const { sendAlertWhatsApp } = await import("../_shared/alerts.ts");
        const text = `Monty alert: the nightly what's-on comparison job failed (${msg.slice(0, 200)}). Nothing parents see is affected.`;
        const res = await sendAlertWhatsApp(text).catch(() => ({ ok: false, channel: "error" }));
        await admin.from("ops_alerts").insert({ alert_type: "whats_on_shadow_failed", affected_parents: 0, failure_count: 1, first_error: msg.slice(0, 300), message: text, likely_fix: "Open /admin/whats-on-diffs and re-run", is_test: false, delivered: res.ok, channel: res.channel });
      }
      return json({ error: msg }, 500);
    }
  }

  // Chunked run: part "sender" (no AI), then "conversation" slices — keeps each call well under the time limit.
  // A run with only one part (e.g. action "sender_suite") finishes in one call.
  const part: "sender" | "outbound" | "conversation" = body.part === "conversation" ? "conversation" : body.part === "outbound" ? "outbound" : "sender";
  const offset = Number.isInteger(body.offset) ? body.offset : 0;
  const limit = Math.min(Number.isInteger(body.limit) ? body.limit : 2, 6);
  let runId: string | null = typeof body.run_id === "string" ? body.run_id : null;
  if (!runId) {
    // Only one run at a time (chained chunks included): overlapping runs wipe each other's fixtures.
    const { data: busy } = await admin.from("test_runs").select("id, suite, started_at").eq("status", "running")
      .gt("started_at", new Date(Date.now() - 30 * 60_000).toISOString()).limit(1);
    if (busy?.length) return json({ error: `Another ${busy[0].suite} run is still in progress (started ${busy[0].started_at}). Wait for it to finish.`, busy_run_id: busy[0].id }, 409);
    const suite = action === "sender_suite" || action === "free_suite" ? "sender" : action === "conversation_suite" ? "conversation" : action === "quick_suite" ? "quick" : "full";
    const { data: run } = await admin.from("test_runs").insert({ suite, triggered_by: adminId === "backend-token" ? null : adminId }).select("id").single();
    runId = run!.id;
  }
  const { data: runRow } = await admin.from("test_runs").select("suite, notes").eq("id", runId).single();
  const suite = runRow?.suite ?? "full";

  let results: Result[] = [];
  let fatal: string | null = null;
  try {
    await resetTestData();
    if (part === "sender") { await seedSenderFixtures(); results = await runSenderSuite(suite === "quick", suite === "sender"); }
    else if (part === "outbound") results = await runOutboundTests();
    else results = await runHandlerSlice(offset, limit, casesFor(suite));
  } catch (e) {
    fatal = (e as Error).message;
  } finally {
    await resetTestData();
  }
  if (fatal) results.push({ scenario: `Suite setup (${part} ${offset})`, category: "setup", status: "fail", reply: null, reason: fatal });
  if (results.length) await admin.from("test_run_results").insert(results.map((r) => ({ run_id: runId, ...r, details: r.details ?? null })));

  let next: { part: string; offset: number } | null = null;
  if (part === "sender") next = { part: "outbound", offset: 0 }; // free tests continue in their own chunk (time limit)
  if (part === "outbound" && suite !== "sender") next = { part: "conversation", offset: 0 };
  if (part === "conversation" && offset + limit < casesFor(suite).length) next = { part: "conversation", offset: offset + limit };

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
    cache_write: (prev.cache_write ?? 0) + usageTotals.cache_write, cache_read: (prev.cache_read ?? 0) + usageTotals.cache_read,
    ms: (prev.ms ?? 0) + usageTotals.ms, truncated: (prev.truncated ?? 0) + usageTotals.truncated, turns: (prev.turns ?? 0) + usageTotals.turns, model: usageTotals.model || prev.model || null };
  const avgTurnMs = usage.turns ? Math.round(usage.ms / usage.turns) : null;
  // Sonnet list price per M tokens: input $3, cache write $3.75 (1.25×), cache read $0.30 (0.1×), output $15.
  const costUsd = Math.round(((usage.input * 3 + usage.cache_write * 3.75 + usage.cache_read * 0.3 + usage.output * 15) / 1e6) * 100) / 100;
  const allInput = usage.input + usage.cache_write + usage.cache_read;
  (usage as any).cache_hit_rate = allInput ? Math.round((usage.cache_read / allInput) * 1000) / 10 : null; // % of input tokens read from cache
  await admin.from("test_runs").update({
    finished_at: next ? null : new Date().toISOString(), total: (all ?? []).length, passed, failed, flaky,
    status: next ? "running" : failed ? "failed" : "passed",
    notes: JSON.stringify({ usage, cost_usd: costUsd, avg_ai_ms_per_reply: avgTurnMs, scenarios: { sender: SENDER_CASES.length + 2, conversation: casesFor(suite).length }, scheduled: body.chain === true || undefined, whats_on_source: SENDER_SOURCE ?? "setting", chat_source: CHAT_SOURCE ?? "setting" }),
  }).eq("id", runId);

  // Chained runs: queue the next chunk from the database with a fresh single-use token. No WhatsApp alerts for test runs.
  if (body.chain === true && next) {
    const { error } = await admin.rpc("queue_suite_chunk", { _body: { action, run_id: runId, chain: true, ...(SENDER_SOURCE ? { whats_on_source: SENDER_SOURCE } : {}), ...(CHAT_SOURCE ? { chat_source: CHAT_SOURCE } : {}), ...next } });
    if (error) { console.error("[runner] chain failed:", error.message); await admin.from("test_runs").update({ status: "failed", finished_at: new Date().toISOString() }).eq("id", runId); }
  }
  return json({ run_id: runId, next, total: (all ?? []).length, passed, failed, flaky, cost_usd: costUsd, usage, results });
});
