/** Return `next` from URL if it's a safe same-origin relative path, else null. */
export function readSafeNext(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get("next");
    if (!raw) return null;
    // Must start with a single '/' and not '//' (which would be protocol-relative).
    if (!raw.startsWith("/") || raw.startsWith("//")) return null;
    return raw;
  } catch {
    return null;
  }
}
