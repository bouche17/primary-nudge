import { describe, it, expect } from "vitest";
import { decodeClassName } from "../../supabase/functions/_shared/calendarYearGroups";
import { yearGroupMatches } from "../../supabase/functions/_shared/schoolEventRules";

describe("SchoolSpider className decoder", () => {
  const cases: Record<string, string | null> = {
    multi_0_1_2: "Reception,Year 1,Year 2",
    multi__2: "Year 1,Year 2",
    multi_0__3: "Reception,Year 1,Year 3",
    multi_5_6_4: "Year 4,Year 5,Year 6",
    custom0: "Reception", custom: "Year 1", custom4: "Year 4", customstaff: "all",
    "": "unknown", weird: "unknown", multi_0_x: "unknown",
    multi_staff: null,
    multi_0__2_3_4_5_6: "all",
    // the 12 classes that were unmapped
    custom1: "Year 1",
    multi_0_1: "Reception,Year 1",
    multi_0_2_3_4: "Reception,Year 2,Year 3,Year 4",
    multi_2_3_4_5_6: "Year 2,Year 3,Year 4,Year 5,Year 6",
    multi_3_4_2: "Year 2,Year 3,Year 4",
    multi_3_4_6_5: "Year 3,Year 4,Year 5,Year 6",
    multi_3_5_4: "Year 3,Year 4,Year 5",
    multi_4_3: "Year 3,Year 4",
    multi_5_4: "Year 4,Year 5",
  };
  for (const [cls, want] of Object.entries(cases)) it(`${cls || "(blank)"} → ${want}`, () => expect(decodeClassName(cls)).toBe(want));

  it("agrees with every old hand-mapped entry (except blank, now unknown)", () => {
    const old: Record<string, string | null> = {
      custom2: "Year 2", custom3: "Year 3", custom5: "Year 5", custom6: "Year 6",
      multi_3_4: "Year 3,Year 4", multi_5_6: "Year 5,Year 6", multi_3_4_5: "Year 3,Year 4,Year 5",
      multi_4_5_6: "Year 4,Year 5,Year 6", multi_3_4_5_6: "Year 3,Year 4,Year 5,Year 6",
      multi_0__2: "Reception,Year 1,Year 2", multi__2_3_4_5_6: "Year 1,Year 2,Year 3,Year 4,Year 5,Year 6",
      multi_4_5_3: "Year 3,Year 4,Year 5", multi_4_5: "Year 4,Year 5", multi_6_5: "Year 5,Year 6",
      multi_2_3: "Year 2,Year 3", multi_2_3_4: "Year 2,Year 3,Year 4",
      multi_3_4_5_6_2: "Year 2,Year 3,Year 4,Year 5,Year 6", multi_5_6_2: "Year 2,Year 5,Year 6",
      multi_0_6: "Reception,Year 6", multi_0_2_: "Reception,Year 1,Year 2",
      multi_0__2_4_5_6: "Reception,Year 1,Year 2,Year 4,Year 5,Year 6",
      multi_0__2_3: "Reception,Year 1,Year 2,Year 3", multi_0_3_2: "Reception,Year 2,Year 3",
      multi_0_staff: null,
    };
    for (const [cls, want] of Object.entries(old)) expect(decodeClassName(cls), cls).toBe(want);
  });

  it("unknown year group is never auto-sent to any child", () => {
    for (const y of ["Reception", "Year 1", "Year 4", "Year 6"]) expect(yearGroupMatches("unknown", y, "Balancebike / scooter day")).toBe(false);
  });
  it("Reception–Y2 event reaches Year 1 but not Year 4", () => {
    expect(yearGroupMatches("Reception,Year 1,Year 2", "Year 1", "Balancebike / scooter day")).toBe(true);
    expect(yearGroupMatches("Reception,Year 1,Year 2", "Year 4", "Balancebike / scooter day")).toBe(false);
  });
});
