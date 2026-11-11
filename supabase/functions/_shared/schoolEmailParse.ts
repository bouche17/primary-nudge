// Pure helpers for robust school-email extraction and the Worker secret (no imports; free-tested).

/** All text blocks of an Anthropic response joined (thinking/other blocks skipped). Never throws. */
export function responseText(data: any): string {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks.filter((b: any) => b && typeof b.text === "string").map((b: any) => b.text).join("\n").trim();
}

/** The first complete, parseable JSON object in text (stray prose and code fences allowed), else null. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const s = String(text ?? "");
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { const v = JSON.parse(s.slice(start, i + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* try next */ }
        break;
      }
    }
  }
  return null;
}

export const JSON_ONLY_NUDGE = "Your last reply could not be read. Return ONLY the JSON object, starting with { and ending with }, nothing else.";

/** Calls the AI once; if no JSON object comes back, retries once with a "JSON only" nudge. Throws only if both fail. */
export async function extractJsonWithRetry(call: (nudge: string | null) => Promise<{ text: string; stop?: string | null }>): Promise<{ parsed: Record<string, unknown>; attempts: number }> {
  const first = await call(null);
  const p1 = firstJsonObject(first.text);
  if (p1) return { parsed: p1, attempts: 1 };
  const second = await call(JSON_ONLY_NUDGE);
  const p2 = firstJsonObject(second.text);
  if (p2) return { parsed: p2, attempts: 2 };
  throw new Error(`extraction returned no JSON after retry (stop: ${second.stop ?? first.stop ?? "?"}; starts: ${JSON.stringify((second.text || first.text).slice(0, 80))})`);
}

/** Constant-time string comparison (length difference also compared without early exit). */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Worker secret check. "ok" = valid header; "warn" = missing/invalid but not enforced (process, log, alert daily);
 *  "reject" = enforced and missing/invalid (401, nothing sent). No secret configured → warn (can't enforce). */
export function secretDecision(o: { enforced: boolean; provided: string | null | undefined; expected: string | null | undefined }): "ok" | "warn" | "reject" {
  const valid = !!o.expected && !!o.provided && safeEqual(o.provided, o.expected);
  if (valid) return "ok";
  return o.enforced && !!o.expected ? "reject" : "warn";
}

export const failedEmailAlert = (subject: string | null | undefined) =>
  `Monty system alert (not from a school): a school email failed to process (${String(subject || "no subject").slice(0, 120)}). It's saved and can be re-run.`;

/** Save first, then process; on failure keep the row with its error and alert once. Never loses the email. */
export async function processWithInbox<T>(d: {
  save: () => Promise<string | null>;
  process: () => Promise<T>;
  done: (id: string | null, out: T) => Promise<void>;
  failed: (id: string | null, error: string) => Promise<void>;
  alert: (text: string) => Promise<unknown>;
  subject: string | null | undefined;
}): Promise<{ ok: true; out: T; id: string | null } | { ok: false; error: string; id: string | null }> {
  const id = await d.save();
  try {
    const out = await d.process();
    await d.done(id, out);
    return { ok: true, out, id };
  } catch (e) {
    const error = String((e as any)?.stack || e).slice(0, 2000);
    await d.failed(id, error).catch(() => {});
    await Promise.resolve(d.alert(failedEmailAlert(d.subject))).catch(() => {});
    return { ok: false, error, id };
  }
}
