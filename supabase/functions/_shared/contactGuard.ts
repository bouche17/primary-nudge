// Blocks invented contact details in outgoing replies. Allowed: Monty's own details, details stored for the
// parent's school(s), and anything the parent sent in their latest message.
export const MONTY_EMAIL = "hello@heymonty.co.uk";
export const MONTY_SITE = "heymonty.co.uk";

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const URL = /\b(?:https?:\/\/[^\s<>()]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:co\.uk|org\.uk|sch\.uk|gov\.uk|ac\.uk|com|uk|org|net|school|io|app|info|edu|me|ly|co|online|site|education)\b(?:\/[^\s<>()]*)?)/gi;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(?0\d{2,4}\)?[\s-]?)\d{3,4}[\s-]?\d{3,4}\b|\+\d[\d\s-]{8,}\d/g;

export interface Found { kind: "email" | "web" | "phone"; raw: string; norm: string }

const host = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/?#]/)[0].replace(/[.,;:!?)]+$/, "");
const digits = (p: string) => { const d = p.replace(/\D/g, ""); return d.startsWith("44") ? "0" + d.slice(2) : d; };

export function findContacts(text: string): Found[] {
  const out: Found[] = [];
  let rest = text || "";
  for (const m of rest.match(EMAIL) ?? []) out.push({ kind: "email", raw: m, norm: m.toLowerCase() });
  rest = rest.replace(EMAIL, " ");
  for (const m of rest.match(URL) ?? []) out.push({ kind: "web", raw: m, norm: host(m) });
  rest = rest.replace(URL, " ");
  for (const m of rest.match(PHONE) ?? []) { const d = digits(m); if (d.length >= 10 && d.length <= 13) out.push({ kind: "phone", raw: m.trim(), norm: d }); }
  return out;
}

export function buildAllowlist(extra: string[], parentMessage: string) {
  const emails = new Set<string>([MONTY_EMAIL]), hosts = new Set<string>([MONTY_SITE]), phones = new Set<string>();
  for (const f of [...extra.flatMap((e) => findContacts(e)), ...findContacts(parentMessage)]) {
    if (f.kind === "email") { emails.add(f.norm); hosts.add(f.norm.split("@")[1]); }
    else if (f.kind === "web") hosts.add(f.norm);
    else phones.add(f.norm);
  }
  return { emails, hosts, phones };
}

function allowed(f: Found, a: ReturnType<typeof buildAllowlist>): boolean {
  if (f.kind === "email") return a.emails.has(f.norm);
  if (f.kind === "phone") return a.phones.has(f.norm);
  return [...a.hosts].some((h) => f.norm === h || f.norm.endsWith("." + h));
}

/** Returns the reply unchanged, or a cleaned honest version plus what was blocked. */
export function guardContacts(reply: string, allow: ReturnType<typeof buildAllowlist>): { reply: string; blocked: Found[] } {
  const blocked = findContacts(reply).filter((f) => !allowed(f, allow));
  if (!blocked.length) return { reply, blocked };
  const parts = reply.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim());
  const kept = parts.filter((p) => !blocked.some((b) => p.includes(b.raw))).join(" ").trim();
  const honest = `Sorry, I don't have that contact detail, so I won't guess. For anything about Monty, email ${MONTY_EMAIL}; for the school, their own website or office is best.`;
  return { reply: kept ? `${kept}\n\n${honest}` : honest, blocked };
}
