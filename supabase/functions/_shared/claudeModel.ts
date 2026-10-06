// Single source of truth for which Claude model Monty uses.
// Roll back / switch by changing the MONTY_CLAUDE_MODEL secret only.
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

export function montyClaudeModel(): string {
  const v = (Deno.env.get("MONTY_CLAUDE_MODEL") || "").trim();
  return v || DEFAULT_CLAUDE_MODEL;
}
