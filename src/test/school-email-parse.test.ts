import { describe, expect, it } from "vitest";
import { extractJsonWithRetry, failedEmailAlert, firstJsonObject, processWithInbox, responseText, secretDecision } from "../../supabase/functions/_shared/schoolEmailParse";
import { normaliseEvents } from "../../supabase/functions/_shared/schoolEmailEvents";

describe("messy JSON parsing", () => {
  it("reads JSON inside code fences with stray text", () => {
    expect(firstJsonObject('Here you go:\n```json\n{"a": "x}", "b": {"c": 1}}\n```\nThanks')).toEqual({ a: "x}", b: { c: 1 } });
  });
  it("skips a broken object and takes the next complete one", () => {
    expect(firstJsonObject('{broken {"ok": true}')).toEqual({ ok: true });
  });
  it("returns null for truncated JSON", () => {
    expect(firstJsonObject('{"a": "cut off')).toBeNull();
  });
  it("joins text blocks and ignores non-text blocks (the 11 Nov crash)", () => {
    expect(responseText({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: '{"a":1}' }] })).toBe('{"a":1}');
    expect(responseText({})).toBe("");
  });
});

describe("retry path", () => {
  it("retries once with the nudge when the first reply has no JSON", async () => {
    const nudges: (string | null)[] = [];
    const r = await extractJsonWithRetry(async (n) => { nudges.push(n); return { text: n ? '{"ok":1}' : "Sorry, here is a summary" }; });
    expect(r).toEqual({ parsed: { ok: 1 }, attempts: 2 });
    expect(nudges.length).toBe(2);
    expect(nudges[1]).toMatch(/ONLY the JSON/);
  });
  it("throws after two failures", async () => {
    let calls = 0;
    await expect(extractJsonWithRetry(async () => { calls++; return { text: "nope" }; })).rejects.toThrow(/no JSON/);
    expect(calls).toBe(2);
  });
});

describe("normaliseEvents never throws", () => {
  it("drops bad events and keeps good ones", () => {
    const ev = normaliseEvents({ yearGroups: ["all"], events: [null, 5, { title: { x: 1 }, date: "2026-12-04" }, { title: "Fair", date: "4 Dec" }, { title: "Own clothes day", date: "2026-11-27", yearGroups: [null, 3] }] });
    expect(ev).toEqual([{ title: "Own clothes day", date: "2026-11-27", time: null, bring: null, yearGroups: ["all"], optIn: false }]);
  });
  it("handles a missing extraction", () => {
    expect(normaliseEvents(undefined)).toEqual([]);
  });
});

describe("never lose an email", () => {
  it("keeps the saved row with the error and alerts once", async () => {
    const calls: string[] = []; const alerts: string[] = [];
    const r = await processWithInbox({
      subject: "Parents' Evening", save: async () => { calls.push("save"); return "id1"; },
      process: async () => { calls.push("process"); throw new Error("boom"); },
      done: async () => { calls.push("done"); }, failed: async (id, e) => { calls.push(`failed:${id}:${e.includes("boom")}`); },
      alert: async (t) => { alerts.push(t); },
    });
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["save", "process", "failed:id1:true"]);
    expect(alerts).toEqual(["Monty system alert (not from a school): a school email failed to process (Parents' Evening). It's saved and can be re-run."]);
    expect(failedEmailAlert("X")).toContain("(X)");
  });
  it("marks processed on success and sends no alert", async () => {
    const calls: string[] = [];
    const r = await processWithInbox({ subject: "s", save: async () => "id2", process: async () => 7, done: async (id, o) => { calls.push(`done:${id}:${o}`); }, failed: async () => { calls.push("failed"); }, alert: async () => { calls.push("alert"); } });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["done:id2:7"]);
  });
});

describe("Worker secret", () => {
  it("warn mode processes without or with a wrong header", () => {
    expect(secretDecision({ enforced: false, provided: null, expected: "s3cret" })).toBe("warn");
    expect(secretDecision({ enforced: false, provided: "wrong", expected: "s3cret" })).toBe("warn");
  });
  it("enforce mode rejects missing or wrong header", () => {
    expect(secretDecision({ enforced: true, provided: null, expected: "s3cret" })).toBe("reject");
    expect(secretDecision({ enforced: true, provided: "s3cre", expected: "s3cret" })).toBe("reject");
  });
  it("a correct header passes in both modes", () => {
    expect(secretDecision({ enforced: true, provided: "s3cret", expected: "s3cret" })).toBe("ok");
    expect(secretDecision({ enforced: false, provided: "s3cret", expected: "s3cret" })).toBe("ok");
  });
});
