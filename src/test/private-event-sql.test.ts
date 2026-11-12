import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { PRIVATE_EVENT_WORDS, norm } from "../../supabase/functions/_shared/schoolEventRules";

// The database read rule (is_private_event) must hide exactly what the app hides.
describe("private-event rule in the database matches the app", () => {
  const dir = "drizzle/migrations";
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(`${dir}/${f}`, "utf8")).filter((s) => s.includes("is_private_event(_title")).pop()!;
  const words = [...sql.match(/ARRAY\[([^\]]+)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  it("same word list", () => expect(words).toEqual([...new Set(PRIVATE_EVENT_WORDS.map(norm))].sort()));
  it("checks whole-word uppercase SEND", () => expect(sql).toContain("SEND([^[:alnum:]]|$)"));
});
