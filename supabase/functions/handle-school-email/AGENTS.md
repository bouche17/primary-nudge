# handle-school-email rules
- The parent text is built by `buildSchoolMessage` in `_shared/schoolEmailMessage.ts` from the AI's `message` field (field fallback if empty), one per family with "For <children>:" only for year-targeted emails, links appended once, one line — why: one testable builder, and template variables can't hold newlines.
- `dry_run: true` needs `x-monty-test-secret`, reads no families (uses `sample_children`) and never sends — why: preview wording safely.
