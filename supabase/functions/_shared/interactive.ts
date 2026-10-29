import { addressParts } from "./schoolLabel.ts";
// Quick-reply buttons and list pickers. Pure: content definitions, which buttons a pending question gets,
// and what a tapped button means. The webhook does the sending; tests import this directly.

/** Twilio Content definitions. In-session ones need no approval; templates are submitted as Utility. */
export const SESSION_DEFS: Record<string, { friendly_name: string; types: Record<string, unknown>; variables: Record<string, string> }> = {
  confirm: { friendly_name: "monty_session_confirm", variables: { "1": "Shall I save it?" },
    types: { "twilio/quick-reply": { body: "{{1}}", actions: [{ title: "Yes", id: "confirm_yes" }, { title: "No", id: "confirm_no" }] } } },
  dup: { friendly_name: "monty_session_duplicate", variables: { "1": "Is it a different one I should save too?" },
    types: { "twilio/quick-reply": { body: "{{1}}", actions: [{ title: "Different, save it", id: "dup_different" }, { title: "Same one", id: "dup_same" }] } } },
  child2: { friendly_name: "monty_session_child2", variables: { "1": "Which child is that for?", "2": "Jude", "3": "Harry" },
    types: { "twilio/quick-reply": { body: "{{1}}", actions: [{ title: "{{2}}", id: "child_1" }, { title: "{{3}}", id: "child_2" }, { title: "Both", id: "child_all" }] } } },
  child_list4: { friendly_name: "monty_session_child_list4", variables: { "1": "Which child is that for?", "2": "Jude", "3": "Harry", "4": "Ivy" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose", items: [{ item: "{{2}}", id: "child_1" }, { item: "{{3}}", id: "child_2" }, { item: "{{4}}", id: "child_3" }, { item: "All", id: "child_all" }] } } },
  child_list5: { friendly_name: "monty_session_child_list5", variables: { "1": "Which child is that for?", "2": "Jude", "3": "Harry", "4": "Ivy", "5": "Mila" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose", items: [{ item: "{{2}}", id: "child_1" }, { item: "{{3}}", id: "child_2" }, { item: "{{4}}", id: "child_3" }, { item: "{{5}}", id: "child_4" }, { item: "All", id: "child_all" }] } } },
  school_list2: { friendly_name: "monty_session_school_list2", variables: { "1": "Which one is it?", "2": "St Joseph's Catholic", "3": "Stockport, SK1 1EF", "4": "St Joseph's RC Primary", "5": "Reddish, SK5 6BG" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose school", items: [{ item: "{{2}}", id: "school_1", description: "{{3}}" }, { item: "{{4}}", id: "school_2", description: "{{5}}" }] } } },
  school_list3: { friendly_name: "monty_session_school_list3", variables: { "1": "Which one is it?", "2": "St Joseph's Catholic", "3": "Stockport, SK1 1EF", "4": "St Joseph's RC Primary", "5": "Reddish, SK5 6BG", "6": "St Joseph's Sale", "7": "Sale, M33 3AF" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose school", items: [{ item: "{{2}}", id: "school_1", description: "{{3}}" }, { item: "{{4}}", id: "school_2", description: "{{5}}" }, { item: "{{6}}", id: "school_3", description: "{{7}}" }] } } },
};

/** Content SIDs for the in-session records (created once via account-check `create_contents`). Empty = plain text only. */
export const SESSION_SIDS: Record<string, string> = {
  confirm: "HX87102b01e664826cfa63d88bf778b7d4", dup: "HX984eb50bfdbf7aa28154b4cb220cfa04", child2: "HXdceada4234e8e858a12c0bd0b152cad8",
  child_list4: "HX22055812e3723eed5ad49508ac940ff7", child_list5: "HX9d1637b58991c714a3effdf91fcfc55c",
  school_list2: "HX53d1c05aacc381a7831ac119adaef49f", school_list3: "HXb03f72668607a10529d52b0146a496d1",
};

export const TEMPLATE_BODIES = {
  school_event_v4: "Hi! 👋 News from {{1}}:\n\n{{2}}\n\nTap Save it to add it to your reminders, or ask me anything about it.",
  account_v2: "Hi, it's Monty 👋 We need to check something on your account: {{1}}. Just reply to this message and we'll sort it for you.",
};
export const TEMPLATE_BUTTONS = {
  school_event_v4: [{ title: "Save it", id: "save_it" }, { title: "Not for us", id: "not_for_us" }],
  sunday_v2: [{ title: "All looks right", id: "sunday_ok" }, { title: "Change lunches", id: "sunday_change" }],
  account_v2: [{ title: "That's right", id: "account_ok" }, { title: "Not quite", id: "account_not_quite" }],
};

/** Pure: event emails use the button template once it's approved; everything else keeps the current one. */
export function chooseTemplate(preferred: string, current: string, preferredApproved: boolean, applies = true): string {
  return applies && preferredApproved && preferred ? preferred : current;
}

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const oneLine = (s: string) => String(s ?? "").replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();

export interface Interactive { key: string; vars: Record<string, string>; labels: string[] }
interface SchoolPickOpt { name: string; address?: string | null; town: string | null; postcode: string }
interface PendingLike { kind: string; proposed?: string[] | null; email?: { eligible?: string[] }; school?: { stage: string; options?: SchoolPickOpt[] } }

const STREET_WORDS: [RegExp, string][] = [[/\bStreet\b/gi, "St"], [/\bRoad\b/gi, "Rd"], [/\bLane\b/gi, "Ln"], [/\bAvenue\b/gi, "Ave"]];
const shortStreet = (s: string) => STREET_WORDS.reduce((a, [re, to]) => a.replace(re, to), oneLine(s));

/** Pure: short picker labels that tell schools apart — "Etchells St · SK1 1EF", "Reddish · SK5 6BG".
 *  Street/area first, then town; never cut the postcode; all labels fit `max` and differ. */
export function schoolPickLabels(opts: SchoolPickOpt[], max: number): string[] {
  const cands = opts.map((o) => {
    const pc = oneLine(o.postcode).toUpperCase();
    const places = [...addressParts(o), oneLine(o.town ?? "")].map(shortStreet).filter(Boolean);
    const fit = places.map((p) => `${p} · ${pc}`).filter((l) => l.length <= max);
    const room = max - pc.length - 3;
    const squeezed = places.length && room >= 3 ? `${cut(places[places.length - 1], room)} · ${pc}` : "";
    return [...new Set([...fit, squeezed, pc].filter(Boolean))];
  });
  const out = cands.map((c) => c[0]);
  for (let i = 0; i < out.length; i++) {
    if (out.indexOf(out[i]) === i) continue;
    const next = cands[i].find((c) => !out.includes(c));
    out[i] = next ?? cut(`${i + 1}. ${out[i]}`, max);
  }
  return out;
}

/** Pure: the buttons for the question Monty just asked (body {{1}} is added at send time). null = plain text. */
export function interactiveFor(p: PendingLike | null, childNames: string[]): Interactive | null {
  if (!p) return null;
  const childButtons = (names: string[]): Interactive | null => {
    const ns = [...new Set(names)].map((n) => cut(oneLine(n), 20));
    if (ns.length === 2) return { key: "child2", vars: { "2": ns[0], "3": ns[1] }, labels: [ns[0], ns[1], "Both"] };
    if (ns.length === 3 || ns.length === 4) {
      const vars: Record<string, string> = {};
      ns.forEach((n, i) => (vars[String(i + 2)] = cut(n, 24)));
      return { key: `child_list${ns.length + 1}`, vars, labels: [...ns, "All"] };
    }
    return null;
  };
  const yesNo: Interactive = { key: "confirm", vars: {}, labels: ["Yes", "No"] };
  switch (p.kind) {
    case "duplicate": return { key: "dup", vars: {}, labels: ["Different, save it", "Same one"] };
    case "confirm": case "edit": return yesNo;
    case "which_child": return childButtons(childNames);
    case "school_email": return p.proposed?.length ? yesNo : childButtons(p.email?.eligible?.length ? p.email.eligible : childNames);
    case "school": {
      const s = p.school;
      if (s?.stage === "confirm") return yesNo;
      if (s?.stage === "pick" && s.options && (s.options.length === 2 || s.options.length === 3)) {
        const vars: Record<string, string> = {};
        const titles = schoolPickLabels(s.options, 24);
        s.options.forEach((o, i) => {
          vars[String(i * 2 + 2)] = titles[i];
          vars[String(i * 2 + 3)] = cut(oneLine(o.name), 72);
        });
        return { key: `school_list${s.options.length}`, vars, labels: titles };
      }
      return null;
    }
    default: return null;
  }
}

/** Pure: the stored text shows what the parent saw: "question\n[Yes] [No]". */
export const withLabels = (text: string, labels: string[]) => (labels.length ? `${text}\n[${labels.join("] [")}]` : text);

export type ButtonKind = "save_it" | "not_for_us" | "sunday_ok" | "sunday_change" | "account_ok" | "account_not_quite" | "pending" | "text";
/** Pure: what a tapped button means. "pending" = feed `text` to the stored question; "text" = treat like a typed message. */
export function buttonAction(payload: string, buttonText: string): { kind: ButtonKind; text: string } {
  const id = (payload || "").trim().toLowerCase();
  const t = (buttonText || "").trim();
  switch (id) {
    case "save_it": case "not_for_us": case "sunday_ok": case "sunday_change": case "account_ok": case "account_not_quite":
      return { kind: id, text: t };
    case "confirm_yes": return { kind: "pending", text: "yes" };
    case "confirm_no": return { kind: "pending", text: "no" };
    case "dup_different": return { kind: "pending", text: "different one, save it" };
    case "dup_same": return { kind: "pending", text: "no, it's the same one" };
    case "child_all": return { kind: "pending", text: "both" };
  }
  if (/^child_\d$/.test(id)) return { kind: "pending", text: t };
  const school = id.match(/^school_(\d)$/);
  if (school) return { kind: "pending", text: school[1] };
  return { kind: "text", text: t };
}
