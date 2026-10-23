// Text of the "new sign-up" alert to Matt. Pure: no phone numbers or email addresses ever reach the text.
import { schoolOneLine, type SchoolLike } from "./schoolLabel.ts";

export interface SignupChild {
  firstName: string;
  yearGroup: string;
  school: (SchoolLike & { known: boolean }) | null;
}
export interface SignupInfo {
  parentFirstName?: string | null;
  newParent: boolean;          // a new parent profile (not just a child added later)
  children: SignupChild[];
  signedUpAt: Date;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+|\b00)?\d[\d\s().-]{7,}\d/g;
/** Removes anything that looks like an email address or phone number. */
export function scrubContacts(text: string): string {
  return text.replace(EMAIL_RE, "[removed]").replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[removed]" : m));
}

export function ukTime(d: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

function childLine(c: SignupChild): string {
  const who = `${c.firstName.trim() || "A child"} (${c.yearGroup || "year not given"})`;
  if (!c.school) return `${who}, school not found`;
  const tag = c.school.known ? "known school (Monty has its calendar)" : "NEW school (no calendar loaded yet)";
  return `${who} at ${schoolOneLine(c.school)}: ${tag}`;
}

export function buildSignupAlert(i: SignupInfo): string {
  const first = (i.parentFirstName || "").trim().split(/\s+/)[0] || "";
  const parent = first ? first : "A parent (no name given)";
  const head = i.newParent ? "New sign-up" : "Child added";
  const body = i.children.length
    ? `${parent} added ${i.children.map(childLine).join("; ")}`
    : `${parent} has created an account but hasn't added any children yet`;
  return scrubContacts(`Monty alert: ${head}. ${body}. Signed up ${ukTime(i.signedUpAt)} (UK time).`);
}
