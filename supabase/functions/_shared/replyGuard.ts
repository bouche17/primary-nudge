// Pure reply-honesty helpers for whatsapp-webhook (no imports, so the free tests can use them directly).

/** A sentence announcing a save/set-up Monty hasn't done ("I'll save that now", "let me add it"). */
export const FUTURE_ACTION = /\b(let me|i'?ll|i will|i'?m going to|going to|now)\s+(just\s+)?(save|add|set|note|pop|put|log|update|sort|get (that|it|this))\b|\b(now|currently)\s+saving\b|\bsaving (that|it|this|now)\b/i;

/** Conditional offers and questions aren't promises: "Once I have the date, I'll set up the reminders",
 *  "Tell me the date and I'll add it", "When's the next one?". */
const CONDITIONAL = /\bonce\b|\bif\b|\bwhen you\b|\bas soon as\b|\b(tell|let) me\b.*\band (i'?ll|i will)\b/i;

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function isConditionalOrQuestion(sentence: string): boolean {
  const s = sentence.replace(/[\u2018\u2019]/g, "'").trim();
  // Trailing emoji/spaces don't stop a question being a question ("…next one? 😊").
  const core = s.replace(/[\s\p{Extended_Pictographic}\u200d\ufe0f]+$/u, "");
  return core.endsWith("?") || CONDITIONAL.test(s);
}

/** Sentences that are plain promises of an action (not conditional offers or questions). */
export function plainPromises(reply: string): string[] {
  return splitSentences(reply).filter((s) => FUTURE_ACTION.test(s) && !isConditionalOrQuestion(s));
}

export function hasPlainPromise(reply: string): boolean {
  return plainPromises(reply).length > 0;
}

/** The reply with plain-promise sentences dropped (conditional offers and questions kept). */
export function dropPlainPromises(reply: string): string {
  return splitSentences(reply).filter((s) => !(FUTURE_ACTION.test(s) && !isConditionalOrQuestion(s))).join(" ").trim();
}

// ── Robotic replies: never "I don't have an open question", "not sure what you're saying yes to", or how Monty works ──
export const ROBOTIC_REPLY = /\bopen question\b|\bnot sure what (you'?re|you are) (saying yes|saying no|replying|responding|referring|agreeing) to\b|\b(don'?t|do not) know what (you'?re|you are) (saying yes|replying|responding|referring) to\b|\bhow (monty|i) works?\b|\bthe way (monty|i) works?\b|\bmy (instructions|programming|system prompt)\b/i;
export function isRoboticReply(reply: string): boolean {
  return ROBOTIC_REPLY.test((reply || "").replace(/[\u2018\u2019]/g, "'"));
}

// ── Short replies ("yes", "seen", "thanks", "👍", "no") — classified in code, never guessed ──
export type ShortReplyKind = "yes" | "ack" | "thanks" | "no";
const YES_RE = /^(?:(?:ok|okay) )?(?:yes|yep|yeah|yea|yup|y|sure|definitely|absolutely|please do|go on|go for it|please)(?: (?:please|pls|thanks|thank you|ok|okay))?(?: (?:save|add) (?:it|that|this))?(?: please)?$|^(?:(?:yes|please|ok|okay) )?(?:save|add) (?:it|that|this)(?: please)?$/;
const THANKS_RE = /^(?:(?:ok|okay|great|lovely|perfect|brilliant|seen) )?(?:thanks|thank you|thankyou|ta|cheers|thx|many thanks)(?: (?:so much|very much|a lot|loads))?$/;
const ACK_RE = /^(?:seen|ok|okay|k|kk|noted|got it|great|lovely|perfect|brilliant|fab|fabulous|cool|will do|amazing|super|ok great|ok lovely|ok noted|ok will do|ok cool|ok got it|okey dokey|seen it|seen that|all good)$/;
const NO_RE = /^(?:no|nope|nah|no thanks|no thank you|not needed|no need|no it'?s fine|it'?s fine|no ta)$/;

/** The kind of a short whole-message reply, or null for anything with real content. Child names / "for" / "both" are ignored. */
export function shortReplyKind(message: string, childNames: string[] = []): ShortReplyKind | null {
  const s = (message || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
  if (!s) return null;
  if (/^[\s\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]+$/u.test(s)) {
    if (/🙏/u.test(s)) return "thanks";
    if (/[👍👌✅😊🙂👏😀😃]/u.test(s)) return "ack";
    return null;
  }
  let t = s.replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, " ").replace(/[^a-z' ]/g, " ");
  for (const n of childNames) t = t.replace(new RegExp(`\\b${n.toLowerCase()}\\b`, "g"), " ");
  t = t.replace(/\b(for|both|monty|xx*)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 5) return null;
  if (YES_RE.test(t)) return "yes";
  if (THANKS_RE.test(t)) return "thanks";
  if (ACK_RE.test(t)) return "ack";
  if (NO_RE.test(t)) return "no";
  return null;
}

// ── Another adult ("Mrs Smith is off sick") is about that adult, never the child ──
const OTHER_ADULT = /\b(mrs|mr|miss|ms|mx|dr|sir)\.?\s+[a-z][a-z'-]+|\b(teacher|teaching assistant|head ?teacher|the head|coach|lollipop|caretaker|receptionist|dinner lady|tutor)\b/i;
const ILL_OR_AWAY = /\b(off sick|sick|ill|poorly|unwell|off work|off today|absent|away|in hospital|injured|off)\b/i;
const WELL_WISH = /\b(back soon|back on (their|his|her) feet|feel(s|ing)? better|get(s|ting)? well|recover(s|ing|y)?|on the mend|speedy|hope (he|she|they|\w+) (is|'s|are) (ok|okay|alright|well))\b/i;
/** Drops well-wishes aimed at a child (or a pronoun) when the parent's news was about another adult and named no child. */
export function dropMisplacedWellWishes(reply: string, message: string, childNames: string[]): string {
  if (!OTHER_ADULT.test(message) || !ILL_OR_AWAY.test(message)) return reply;
  const named = (txt: string) => childNames.some((n) => new RegExp(`\\b${n}\\b`, "i").test(txt));
  if (named(message)) return reply;
  const adult = message.match(/\b(?:mrs|mr|miss|ms|mx|dr)\.?\s+[A-Za-z][A-Za-z'-]+/i)?.[0]?.replace(/\b\w/g, (c) => c.toUpperCase());
  const sentences = splitSentences(reply);
  const out: string[] = [];
  let changed = false;
  for (const x of sentences) {
    if (!WELL_WISH.test(x)) { out.push(x); continue; }
    if (named(x)) { changed = true; continue; } // "I hope Harry's back soon" — the news was about an adult
    if (adult && /\b(he|she)\b/i.test(x)) { // "hope she's back soon" → about the adult, by name
      out.push(x.replace(/\b(she|he)('s| is)\b/gi, `${adult} is`).replace(/\b(she|he)\b/gi, adult)); changed = true; continue;
    }
    out.push(x);
  }
  if (!changed) return reply;
  return out.join(" ").trim() || (adult ? `Thanks for letting me know about ${adult} 👍` : "Thanks for letting me know 👍");
}
