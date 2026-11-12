import { describe, expect, it } from "vitest";
import { classifyEmailFollowUp, followUpInWindow, eligibleFor, eventLine, groupedConfirmation, groupLabels, matchEventsByTopic, multiSaveQuestion, normaliseEvents } from "../../supabase/functions/_shared/schoolEmailEvents";

// The extraction shape for "Fwd: UPDATED DATES - PTA Christmas Fair Info" (10 Nov).
const PTA = {
  yearGroups: ["all"], eventTitle: "PTA Christmas Fair", eventDate: "2026-12-04",
  events: [
    { title: "PTA Christmas Fair", date: "2026-12-04", time: "5–7pm", bring: null, yearGroups: ["all"] },
    { title: "Own clothes day", date: "2026-11-27", bring: "a chocolate item", yearGroups: ["all"] },
    { title: "Own clothes day", date: "2026-12-04", bring: "a bottle", yearGroups: ["all"] },
  ],
};
const FAMILY = [{ first_name: "Jude", year_group: "Year 6" }, { first_name: "Harry", year_group: "Year 3" }];

describe("school emails with several dates", () => {
  it("keeps all 3 dated items, in date order", () => {
    const ev = normaliseEvents(PTA);
    expect(ev).toHaveLength(3);
    expect(ev.map((e) => e.date)).toEqual(["2026-11-27", "2026-12-04", "2026-12-04"]);
  });
  it("falls back to the single event for old extractions", () => {
    expect(normaliseEvents({ eventTitle: "Odd Socks Day", eventDate: "2026-11-16", yearGroups: ["all"] })).toHaveLength(1);
  });
  it("drops private events", () => {
    expect(normaliseEvents({ events: [{ title: "SEND Review - Invite Only", date: "2026-11-16" }] })).toEqual([]);
  });
  it("asks once with every item listed", () => {
    const q = multiSaveQuestion(normaliseEvents(PTA));
    expect(q).toBe("Shall I save all 3?\n• Fri 27 Nov: own clothes day, bring a chocolate item\n• Fri 4 Dec: own clothes day, bring a bottle\n• Fri 4 Dec, 5–7pm: PTA Christmas Fair");
  });
  it("an 'all' item is for every child, no question", () => {
    expect(eligibleFor(normaliseEvents(PTA)[0], FAMILY)).toEqual(["Jude", "Harry"]);
  });
  it("a year-specific item is only for the children in that year", () => {
    expect(eligibleFor({ title: "Y3 trip", date: "2026-12-01", yearGroups: ["Year 3"] }, FAMILY)).toEqual(["Harry"]);
    expect(eligibleFor({ title: "Y1 trip", date: "2026-12-01", yearGroups: ["Year 1"] }, FAMILY)).toBeNull();
  });
  it("matches follow-ups by topic", () => {
    const ev = normaliseEvents(PTA);
    expect(matchEventsByTopic("And also the own clothes days", ev).map((e) => e.date)).toEqual(["2026-11-27", "2026-12-04"]);
    expect(matchEventsByTopic("save the fair too", ev).map((e) => e.title)).toEqual(["PTA Christmas Fair"]);
  });
  it("grouped confirmation names the children once and each item once", () => {
    const saved = ["Jude", "Harry"].flatMap((child) => [
      { child, title: "Own clothes day", date: "2026-11-27", bring: "a chocolate item" },
      { child, title: "Own clothes day", date: "2026-12-04", bring: "a bottle" },
    ]);
    expect(groupedConfirmation(saved, ["Jude", "Harry"])).toBe("Saved for both Jude and Harry ✅ Own clothes day: Fri 27 Nov (chocolate item) and Fri 4 Dec (bottle).");
    expect(groupedConfirmation(saved.filter((s) => s.child === "Harry"), ["Jude", "Harry"])).toBe("Saved for Harry ✅ Own clothes day: Fri 27 Nov (chocolate item) and Fri 4 Dec (bottle).");
  });
  it("chat save labels are grouped too, never repeated per child", () => {
    const g = groupLabels(["Jude's own clothes day for Friday 27th", "Harry's own clothes day for Friday 27th", "Jude's own clothes day for Friday 4th", "Harry's own clothes day for Friday 4th"], ["Jude", "Harry"]);
    expect(g).toBe("Saved for both Jude and Harry ✅ Own clothes day: Friday 27th and Friday 4th.");
  });
  it("line wording", () => {
    expect(eventLine(normaliseEvents(PTA)[2])).toBe("Fri 4 Dec, 5–7pm: PTA Christmas Fair");
  });
});

describe("follow-ups only on a genuine reference to the email", () => {
  const ev = normaliseEvents(PTA);
  const kind = (m: string) => classifyEmailFollowUp(m, ev, ["Jude", "Harry"]).kind;
  it("Harry's Christmas play is on 12 Dec → not a reference", () => expect(kind("Harry's Christmas play is on 12 Dec")).toBe("none"));
  it("save the fair → reference", () => {
    expect(kind("save the fair")).toBe("save");
    expect(classifyEmailFollowUp("save the fair", ev).matched.map((e) => e.title)).toEqual(["PTA Christmas Fair"]);
  });
  it("and also the own clothes days → reference", () => expect(classifyEmailFollowUp("and also the own clothes days", ev).matched.map((e) => e.date)).toEqual(["2026-11-27", "2026-12-04"]));
  it("Christmas jumper day Friday → not a reference", () => expect(kind("Christmas jumper day Friday")).toBe("none"));
  it("what do they need to bring? → reference", () => expect(kind("what do they need to bring?")).toBe("question"));
  it("a tap on day 5 resolves; free text on day 5 doesn't", () => {
    const now = new Date("2026-11-15T15:23:00Z");
    expect(followUpInWindow({ sentAt: "2026-11-10T15:23:00Z", now, inLastTwo: false, tapOrPending: true })).toBe(true);
    expect(followUpInWindow({ sentAt: "2026-11-10T15:23:00Z", now, inLastTwo: false, tapOrPending: false })).toBe(false);
    expect(followUpInWindow({ sentAt: "2026-11-10T15:23:00Z", now, inLastTwo: true, tapOrPending: false })).toBe(true);
  });
});
