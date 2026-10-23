// Nightly shadow comparison: old reminder sender (dry run, never sends) vs the shared getWhatsOn().
// Stores only differences in whats_on_shadow_diffs. No AI, no messages.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getWhatsOn, ukDate, type WhatsOnItem } from "../_shared/whatsOn.ts";
import { isTestPhone } from "../_shared/testGuard.ts";
import { legacyUpcoming, loadChatWhatsOn, loadLegacyChatContext } from "../_shared/chatContext.ts";
import { loadFamilyData } from "../_shared/whatsOn.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEST_SECRET = Deno.env.get("MONTY_TEST_SECRET")!;
const DAY = 86_400_000;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);

type OldItem = { child_id: string | null; child_name: string; title: string; type: string; ref: string };

async function oldDryRun(period: "morning" | "evening", now: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, "x-monty-test-secret": TEST_SECRET },
    body: JSON.stringify({ scenario: "whats-on shadow", scope: "real_readonly", period, now, ignore_sent_log: true, with_items: true, whats_on_source: "legacy" }), // always the old rules
  });
  if (!res.ok) throw new Error(`send-reminders dry run ${period} ${now}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { target: j.target_date as string, families: (j.families ?? []) as { family: string; items: OldItem[] }[] };
}

const oldKind = (i: OldItem) => i.ref.startsWith("childreminder_") ? "reminder" : i.ref.startsWith("lunch_") ? "lunch" : i.ref.startsWith("reminder_") ? "school reminder" : "note";

function likelyReason(side: string, kinds: string[], title: string): string {
  const k = kinds[0];
  if (side === "different") {
    if (kinds.includes("school reminder")) return "School reminder: old repeats it for every child, new shows it once for the family (agreed rule).";
    if (kinds.includes("one-off") || kinds.includes("note")) return "Note: old shows it for 'the children', new links it to the named child.";
    return "Same item on the same day, attached to different children.";
  }
  if (side === "new only") {
    if (k === "school event") return "School events were never in the old reminders; new includes them for the matching year group (opt-in activities left out).";
    if (k === "school reminder") return "Check: a school reminder the old sender didn't pick up (e.g. weekday rule or school match).";
    if (k === "fortnightly" || k === "weekly") return "Check: recurring reminder the old sender skipped (time slot, fortnight parity or holiday).";
    return `Check: only the new function has this (${k}).`;
  }
  if (k === "reminder") return "Check: old sends this recurring reminder but new doesn't (holiday, fortnight parity or inactive child).";
  if (k === "school reminder") return "Check: old sends a school reminder new skips (holiday or school not matched).";
  if (k === "note") return /\d/.test(title) ? "Check: note date read differently." : "Check: note not matched to this family by new.";
  return `Check: only the old sender has this (${k}).`;
}

export async function runWhatsOnShadow(db: SupabaseClient, opts: { days?: number; now?: string } = {}) {
  const t0 = Date.now();
  const days = Math.min(Math.max(opts.days ?? 14, 1), 21);
  const now = opts.now ? new Date(opts.now) : new Date();
  const runDate = ukDate(now);
  const from = runDate, to = addDays(runDate, days - 1);

  // ── New side: one call per real family ──
  const { data: kids } = await db.from("children").select("parent_id, first_name");
  const userToFamily = new Map<string, string>();
  const newByFamily = new Map<string, { label: string; items: WhatsOnItem[] }>();
  let skippedTest = 0;
  for (const parent of [...new Set((kids ?? []).map((k) => k.parent_id))]) {
    if (userToFamily.has(parent)) continue;
    const { data: ids } = await db.rpc("get_family_user_ids", { _user_id: parent });
    const famUsers = [...new Set([parent, ...((ids ?? []) as any[]).map((r) => (typeof r === "string" ? r : r.get_family_user_ids))])].filter(Boolean) as string[];
    const { data: profs } = await db.from("profiles").select("phone_number").in("user_id", famUsers);
    const phones = (profs ?? []).map((p) => p.phone_number).filter(Boolean) as string[];
    const isTest = (await Promise.all(phones.map((p) => isTestPhone(p)))).some(Boolean);
    const w = isTest ? null : await getWhatsOn(db as any, parent, from, to);
    for (const u of famUsers) userToFamily.set(u, w?.familyId ?? "test");
    if (isTest || !w) { skippedTest++; continue; }
    const label = (kids ?? []).filter((k) => famUsers.includes(k.parent_id)).map((k) => k.first_name).sort().join(" & ");
    // Reminders never send opt-in events; a parent's item shown as a school event's line still counts as present.
    const visible = w.items.filter((x) => !x.optIn).flatMap((x) => [x, ...(x.absorbed ?? []).map((a) => ({ ...x, title: a.title, kind: (a.table === "parent_notes" ? "one-off" : "weekly") as WhatsOnItem["kind"] }))]);
    newByFamily.set(w.familyId, { label, items: visible });
  }

  // ── Old side: morning of each date + evening before it (both target that date) ──
  const oldByFamily = new Map<string, Map<string, OldItem[]>>(); // family → date → items
  const calls: Promise<void>[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    for (const [period, at] of [["morning", `${d}T06:00:00Z`], ["evening", `${addDays(d, -1)}T17:00:00Z`]] as const) {
      calls.push(oldDryRun(period, at).then(({ target, families }) => {
        if (target !== d) throw new Error(`dry run targeted ${target}, expected ${d}`);
        for (const f of families) {
          const fam = userToFamily.get(f.family) ?? f.family;
          if (fam === "test") continue;
          if (!oldByFamily.has(fam)) oldByFamily.set(fam, new Map());
          const m = oldByFamily.get(fam)!;
          m.set(d, [...(m.get(d) ?? []), ...f.items]);
        }
      }));
      if (calls.length >= 6) { await Promise.all(calls.splice(0)); }
    }
  }
  await Promise.all(calls);

  // ── Compare per family/date/title; child attachment compared as a set ──
  const diffs: Record<string, unknown>[] = [];
  const families = new Set([...newByFamily.keys(), ...oldByFamily.keys()]);
  for (const fam of families) {
    const label = newByFamily.get(fam)?.label ?? null;
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const oldItems = oldByFamily.get(fam)?.get(d) ?? [];
      const newItems = (newByFamily.get(fam)?.items ?? []).filter((x) => x.date === d);
      const titles = new Set([...oldItems.map((x) => norm(x.title)), ...newItems.map((x) => norm(x.title))]);
      for (const t of titles) {
        const o = oldItems.filter((x) => norm(x.title) === t), n = newItems.filter((x) => norm(x.title) === t);
        const oKids = [...new Set(o.map((x) => x.child_id ?? "family"))].sort().join(","), nKids = [...new Set(n.map((x) => x.childId ?? "family"))].sort().join(",");
        const side = !o.length ? "new only" : !n.length ? "old only" : oKids !== nKids ? "different" : null;
        if (!side) continue;
        const title = (n[0]?.title ?? o[0]?.title)!;
        const who = side === "different"
          ? `old: ${[...new Set(o.map((x) => x.child_name))].join(", ")} / new: ${[...new Set(n.map((x) => x.childName ?? "family"))].join(", ")}`
          : [...new Set([...o.map((x) => x.child_name), ...n.map((x) => x.childName ?? "family")])].join(", ");
        const kinds = side === "old only" ? o.map(oldKind) : n.map((x) => x.kind as string);
        diffs.push({ run_date: runDate, family_id: fam, family_label: label, item_date: d, item: `${title} (${who})`.slice(0, 300), side, likely_reason: likelyReason(side, kinds, title) });
      }
    }
  }
  await db.from("whats_on_shadow_diffs").delete().eq("run_date", runDate).eq("source", "reminders");
  for (let i = 0; i < diffs.length; i += 500) {
    const { error } = await db.from("whats_on_shadow_diffs").insert(diffs.slice(i, i + 500));
    if (error) throw new Error(`storing diffs: ${error.message}`);
  }
  const bySide = diffs.reduce((a: Record<string, number>, d: any) => ((a[d.side] = (a[d.side] ?? 0) + 1), a), {});
  return { run_date: runDate, window: { from, to }, families: newByFamily.size, test_families_skipped: skippedTest, differences: diffs.length, by_side: bySide, ms: Date.now() - t0 };
}

// ── Chat shadow: what Monty "saw" as upcoming before replying — old context vs the shared list (per parent number) ──
export async function runChatShadow(db: SupabaseClient, opts: { now?: string } = {}) {
  const t0 = Date.now();
  const now = opts.now ? new Date(opts.now) : new Date();
  const runDate = ukDate(now), days = 14, from = runDate, to = addDays(runDate, days - 1);
  const { data: profs } = await db.from("profiles").select("user_id, phone_number").not("phone_number", "is", null);
  const diffs: Record<string, unknown>[] = [];
  let parents = 0, skippedTest = 0;
  for (const p of profs ?? []) {
    if (await isTestPhone(p.phone_number)) { skippedTest++; continue; }
    const old = await loadLegacyChatContext(db as any, p.phone_number!, now);
    if (!old || !old.children.length) continue;
    parents++;
    const fam = await loadFamilyData(db as any, p.user_id, from, to);
    const neu = await loadChatWhatsOn(db as any, p.user_id, now);
    const { data: own } = await db.from("parent_notes").select("id").eq("phone_number", p.phone_number!);
    const ownNotes = new Set((own ?? []).map((n: any) => n.id));
    const kidName = new Map(fam.children.map((c) => [c.id, c.first_name]));
    const label = `${fam.children.map((c) => c.first_name).sort().join(" & ")} — parent ${String(p.phone_number).slice(-2)}`;
    const single = fam.children.length === 1 ? fam.children[0].first_name : null;
    const oldItems = legacyUpcoming(old, from, days);
    const newItems = neu.items.flatMap((x) => [x, ...(x.absorbed ?? []).map((a) => ({ ...x, title: a.title, source: { table: a.table, id: a.id }, kind: (a.table === "parent_notes" ? "one-off" : "weekly") as WhatsOnItem["kind"] }))]);
    const isHol = (date: string) => fam.holidays.some((h) => h.start_date <= date && h.end_date >= date);
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const o = oldItems.filter((x) => x.date === d), n = newItems.filter((x) => x.date === d);
      const titles = new Set([...o.map((x) => norm(x.title)), ...n.map((x) => norm(x.title))]);
      for (const t of titles) {
        const os = o.filter((x) => norm(x.title) === t), ns = n.filter((x) => norm(x.title) === t);
        const kind = (ns[0]?.kind ?? os[0]?.kind) as string;
        const eventish = kind === "school event" || kind === "school reminder";
        const oKids = [...new Set(os.map((x) => x.child ?? single ?? "family"))].sort().join(", ");
        const nKids = [...new Set(ns.map((x) => x.childName ?? single ?? "family"))].sort().join(", ");
        const side = !os.length ? "new only" : !ns.length ? "old only" : !eventish && oKids !== nKids ? "different" : null;
        if (!side) continue;
        const title = (ns[0]?.title ?? os[0]?.title)!;
        let why: string;
        if (side === "new only") {
          const x = ns[0];
          why = x.source.table === "parent_notes" && !ownNotes.has(x.source.id) ? "Partner's note: old chat only saw the sender's own notes."
            : x.kind === "school reminder" ? "Due-dated school reminder: old chat ignored school reminders with a date."
            : x.kind === "school event" ? (x.optIn ? "Opt-in school event (flagged optional): old chat missed it (UTC window or 20-event limit)." : "School event: old chat missed it (UTC window/date or 20-event limit).")
            : x.kind === "lunch" ? "Packed lunch: old chat only showed lunch plans as a separate summary for this/next week."
            : x.source.table === "parent_notes" ? "Note limit: old chat only loaded the parent's 20 most recent notes." : `Check: only the new list has this (${x.kind}).`;
        } else if (side === "old only") {
          const x = os[0];
          const wkend = ["Saturday", "Sunday"].includes(new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }));
          why = isHol(d) && x.kind !== "school event" ? (wkend ? "Holiday (weekend inside a holiday range): new list skips it — same rule the reminders already use." : "Holiday/INSET: new list skips school-day items on holidays.")
            : x.kind === "weekly" ? (fam.childReminders.some((r) => norm(r.title) === t && (r.recurrence_interval ?? 1) > 1) ? "Fortnightly off-week: old chat treated it as weekly." : "Check: weekly reminder missing from the new list (skip date or child).")
            : x.kind === "school event" ? "Year group / class: the event isn't for this family's children (or hidden/merged marker)."
            : x.kind === "one-off" ? "Note date read differently (old used UTC)." : `Check: only the old context has this (${x.kind}).`;
        } else why = ns.some((x) => x.kind === "school event") ? "Parent's note shown as the school event's line (one line per topic)." : "Same item, attached to different children (old used the note's child name as written).";
        diffs.push({ run_date: runDate, family_id: fam.familyId, family_label: label, item_date: d, item: `${title} (${side === "different" ? `old: ${oKids} / new: ${nKids}` : (nKids || oKids)})`.slice(0, 300), side, likely_reason: why, source: "chat" });
      }
    }
    void kidName;
  }
  await db.from("whats_on_shadow_diffs").delete().eq("run_date", runDate).eq("source", "chat");
  for (let i = 0; i < diffs.length; i += 500) {
    const { error } = await db.from("whats_on_shadow_diffs").insert(diffs.slice(i, i + 500));
    if (error) throw new Error(`storing chat diffs: ${error.message}`);
  }
  const bySide = diffs.reduce((a: Record<string, number>, d: any) => ((a[d.side] = (a[d.side] ?? 0) + 1), a), {});
  const byReason = diffs.reduce((a: Record<string, number>, d: any) => { const k = String(d.likely_reason).split(":")[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return { run_date: runDate, window: { from, to }, parents, test_parents_skipped: skippedTest, differences: diffs.length, by_side: bySide, by_reason: byReason, ms: Date.now() - t0 };
}
