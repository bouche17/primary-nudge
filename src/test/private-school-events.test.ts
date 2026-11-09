import { describe, expect, it } from "vitest";
import { isPrivateEvent, isOptInEvent, sharesTopic, yearGroupMatches } from "../../supabase/functions/_shared/schoolEventRules";

function events(title: string, year_group = "Year 1") {
  return yearGroupMatches(year_group, "Year 1", title) ? [title] : [];
}

describe("private school events", () => {
  it("excludes SEND Review - Invite Only for Year 1", () => {
    expect(events("SEND Review - Invite Only")).toEqual([]);
    expect(yearGroupMatches("Year 1", "Year 1", "SEND Review - Invite Only")).toBe(false);
  });
  it("keeps Parents' Evening", () => {
    expect(events("Parents' Evening")).toHaveLength(1);
    expect(isOptInEvent("Parents' Evening", "Year 1", "2026-11-16T18:00:00Z")).toBe(false);
  });
  it("keeps Parent Consultations", () => expect(events("Parent Consultations")).toHaveLength(1));
  it("keeps all-years manual Odd Socks Day", () => expect(events("Odd Socks Day", "all")).toHaveLength(1));
  it("never lets always-include words override privacy", () => {
    expect(events("Invite Only swimming workshop meeting")).toEqual([]);
    expect(isOptInEvent("Invite Only swimming workshop meeting", "Year 1")).toBe(true);
    expect(sharesTopic("Invite Only swimming workshop", "swimming workshop")).toBe(false);
  });
  it.each(["invitation only", "by invitation", "invited", "by appointment", "SEND", "SENCO", "EHCP", "annual review", "SEND review", "staff only", "staff meeting", "governors", "safeguarding", "1:1 meeting", "one-to-one meeting", "parent meeting - Jane Smith"])("excludes %s", (title) => expect(events(title)).toEqual([]));
  it("only matches capital SEND as a whole word", () => {
    expect(isPrivateEvent("Please send money for the trip")).toBe(false);
    expect(isPrivateEvent("RESEND forms")).toBe(false);
  });
});