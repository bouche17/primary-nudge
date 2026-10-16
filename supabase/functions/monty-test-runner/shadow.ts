// Nightly shadow comparison: old reminder sender (dry run, never sends) vs the shared getWhatsOn().
// Stores only differences in whats_on_shadow_diffs. No AI, no messages.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getWhatsOn, ukDate, type WhatsOnItem } from "../_shared/whatsOn.ts";
import { isTestPhone } from "../_shared/testGuard.ts";

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
    body: JSON.stringify({ scenario: "whats-on shadow", scope: "real_readonly", period, now, ignore_sent_log: true, with_items: true }),
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
    if (k === "school event") return "School events were never in the old reminders; new includes them for the matching year group.";
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
    newByFamily.set(w.familyId, { label, items: w.items });
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
  await db.from("whats_on_shadow_diffs").delete().eq("run_date", runDate);
  for (let i = 0; i < diffs.length; i += 500) {
    const { error } = await db.from("whats_on_shadow_diffs").insert(diffs.slice(i, i + 500));
    if (error) throw new Error(`storing diffs: ${error.message}`);
  }
  const bySide = diffs.reduce((a: Record<string, number>, d: any) => ((a[d.side] = (a[d.side] ?? 0) + 1), a), {});
  return { run_date: runDate, window: { from, to }, families: newByFamily.size, test_families_skipped: skippedTest, differences: diffs.length, by_side: bySide, ms: Date.now() - t0 };
}
