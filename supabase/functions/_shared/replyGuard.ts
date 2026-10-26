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
