import { addressParts } from "./schoolLabel.ts";
import { shortDayDate } from "./chatRules.ts";
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
  // Generic question buttons (the ones sent now): titles/items and their ids are variables, so every button
  // carries its question's ID ("q:<question id>:<option>"). Layout: {{1}} body, then titles, (descriptions), ids.
  q2: { friendly_name: "monty_session_q2", variables: { "1": "Shall I save it?", "2": "Yes", "3": "No", "4": "q:x:0", "5": "q:x:1" },
    types: { "twilio/quick-reply": { body: "{{1}}", actions: [{ title: "{{2}}", id: "{{4}}" }, { title: "{{3}}", id: "{{5}}" }] } } },
  q3: { friendly_name: "monty_session_q3", variables: { "1": "Which child is that for?", "2": "Jude", "3": "Harry", "4": "Both", "5": "q:x:0", "6": "q:x:1", "7": "q:x:2" },
    types: { "twilio/quick-reply": { body: "{{1}}", actions: [{ title: "{{2}}", id: "{{5}}" }, { title: "{{3}}", id: "{{6}}" }, { title: "{{4}}", id: "{{7}}" }] } } },
  l4: { friendly_name: "monty_session_l4", variables: { "1": "Which child is that for?", "2": "Jude", "3": "Harry", "4": "Ivy", "5": "All", "6": "q:x:0", "7": "q:x:1", "8": "q:x:2", "9": "q:x:3" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose", items: [{ item: "{{2}}", id: "{{6}}" }, { item: "{{3}}", id: "{{7}}" }, { item: "{{4}}", id: "{{8}}" }, { item: "{{5}}", id: "{{9}}" }] } } },
  l5: { friendly_name: "monty_session_l5", variables: { "1": "Which child is that for?", "2": "Jude", "3": "Harry", "4": "Ivy", "5": "Mila", "6": "All", "7": "q:x:0", "8": "q:x:1", "9": "q:x:2", "10": "q:x:3", "11": "q:x:4" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose", items: [{ item: "{{2}}", id: "{{7}}" }, { item: "{{3}}", id: "{{8}}" }, { item: "{{4}}", id: "{{9}}" }, { item: "{{5}}", id: "{{10}}" }, { item: "{{6}}", id: "{{11}}" }] } } },
  ls2: { friendly_name: "monty_session_ls2", variables: { "1": "Which one is it?", "2": "Etchells St · SK1 1EF", "3": "Reddish · SK5 6BG", "4": "St Joseph's Catholic", "5": "St Joseph's RC Primary", "6": "q:x:0", "7": "q:x:1" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose school", items: [{ item: "{{2}}", description: "{{4}}", id: "{{6}}" }, { item: "{{3}}", description: "{{5}}", id: "{{7}}" }] } } },
  ls3: { friendly_name: "monty_session_ls3", variables: { "1": "Which one is it?", "2": "Etchells St · SK1 1EF", "3": "Reddish · SK5 6BG", "4": "Sale · M33 3AF", "5": "St Joseph's Catholic", "6": "St Joseph's RC Primary", "7": "St Joseph's Sale", "8": "q:x:0", "9": "q:x:1", "10": "q:x:2" },
    types: { "twilio/list-picker": { body: "{{1}}", button: "Choose school", items: [{ item: "{{2}}", description: "{{5}}", id: "{{8}}" }, { item: "{{3}}", description: "{{6}}", id: "{{9}}" }, { item: "{{4}}", description: "{{7}}", id: "{{10}}" }] } } },
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

/** Buttons for one question: what the parent sees (labels), what each tap means (answers, fed to the stored
 *  question's resolver), optional list descriptions. `key` picks the generic content record. */
export interface Interactive { key: string; labels: string[]; answers: string[]; descs?: string[] }
interface SchoolPickOpt { name: string; address?: string | null; town: string | null; postcode: string }
interface PendingLike {
  kind: string; proposed?: string[] | null; email?: { eligible?: string[] }; school?: { stage: string; options?: SchoolPickOpt[] };
  items?: Array<{ tool: string; args: any }>; move?: { options: Array<{ child: string; title: string; day: string }> };
  pick?: { options: Array<{ label: string }> };
}

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

const uniq = (labels: string[], max: number) => {
  const out: string[] = [];
  labels.forEach((l, i) => { let x = cut(oneLine(l), max); if (out.includes(x)) x = cut(`${i + 1}. ${x}`, max); out.push(x); });
  return out;
};
/** Pure: n options → content key (≤3 quick-reply buttons, 4–5 list rows, school lists carry descriptions). */
function build(labels: string[], answers: string[], descs?: string[]): Interactive | null {
  const n = labels.length;
  if (descs) return n === 2 || n === 3 ? { key: `ls${n}`, labels: uniq(labels, 24), answers, descs: descs.map((d) => cut(oneLine(d), 72)) } : null;
  if (n === 2 || n === 3) return { key: `q${n}`, labels: uniq(labels, 20), answers };
  if (n === 4 || n === 5) return { key: `l${n}`, labels: uniq(labels, 24), answers };
  return null;
}

/** Pure: the buttons for the question Monty just asked (one question per set of buttons). null = plain text. */
export function interactiveFor(p: PendingLike | null, childNames: string[]): Interactive | null {
  if (!p) return null;
  const childButtons = (names: string[]): Interactive | null => {
    const ns = [...new Set(names)];
    if (ns.length < 2 || ns.length > 4) return null;
    return build([...ns, ns.length === 2 ? "Both" : "All"], [...ns, "both"]);
  };
  const yesNo = build(["Yes", "No"], ["yes", "no"]);
  switch (p.kind) {
    case "duplicate": return build(["Different, save it", "Same one"], ["different one, save it", "no, it's the same one"]);
    case "confirm": case "edit": return yesNo;
    case "which_child": return childButtons(childNames);
    case "frequency": {
      const note = p.items?.find((i) => i.tool === "save_parent_note" && /^\d{4}-\d{2}-\d{2}$/.test(i.args?.date || ""));
      const weekly = p.items?.find((i) => i.tool === "save_child_reminder" && i.args?.day_of_week);
      return note && weekly ? build([`Just ${shortDayDate(note.args.date)}`, `Every ${weekly.args.day_of_week}`], ["just this one", "every week"]) : null;
    }
    case "move": {
      const o = p.move?.options ?? [];
      if (o.length < 1 || o.length > 4) return null;
      return build([...o.map((x) => `${x.child}'s · ${x.day.slice(0, 3)}`), "Neither"], [...o.map((x) => `${x.child}'s ${x.title} on ${x.day}`), "neither"]);
    }
    case "pick": {
      const o = p.pick?.options ?? [];
      if (o.length < 1 || o.length > 4) return null;
      return build([...o.map((x) => x.label), "Neither"], [...o.map((_x, i) => String(i + 1)), "neither"]);
    }
    case "scope": return build(["Just this week", "For good"], ["just this week", "for good"]);
    case "school_email": return p.proposed?.length ? yesNo : childButtons(p.email?.eligible?.length ? p.email.eligible : childNames);
    case "school": {
      const s = p.school;
      if (s?.stage === "confirm") return yesNo;
      if (s?.stage === "pick" && s.options && (s.options.length === 2 || s.options.length === 3)) {
        return build(schoolPickLabels(s.options, 24), s.options.map((_o, i) => String(i + 1)), s.options.map((o) => o.name));
      }
      return null;
    }
    default: return null;
  }
}

/** Every button carries its question's ID. */
export const tapPayload = (qid: string, i: number) => `q:${qid}:${i}`;
export function parseTapPayload(payload: string): { qid: string; idx: number } | null {
  const m = String(payload || "").trim().match(/^q:([a-z0-9]{6,16}):(\d)$/i);
  return m ? { qid: m[1].toLowerCase(), idx: Number(m[2]) } : null;
}
/** Pure: ContentVariables for the generic records: {{1}} body, then labels, (descriptions), ids. */
export function contentVars(inter: Interactive, qid: string, body: string): Record<string, string> {
  const vals = [body, ...inter.labels, ...(inter.descs ?? []), ...inter.labels.map((_l, i) => tapPayload(qid, i))];
  return Object.fromEntries(vals.map((v, i) => [String(i + 1), v]));
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
