# Roadmap — Monty test suite

## Stage 1 (done — awaiting Matt's confirmation)
- [x] test_phone_numbers allowlist + test_runs / test_run_results / test_entry_audit tables
- [x] Never-send-to-test-numbers safeguard in every sender; test data excluded from real runs
- [x] send-reminders split into build/send + secret-gated dry-run (constant-time, audited, dry_run default true, no Twilio)
- [x] Reminder sender tests (weekday, Fri→Sat, fortnightly on/off, 25/26 Oct, after-6pm note, double-send guard)
- [x] /admin/tests page
- [x] Dry run of tonight's real 6pm reminders vs old code — report to Matt, then STOP

## Stage 2 (waits on Matt's go-ahead after Stage 1)
- [x] ~30 handler scenarios via locked-down whatsapp-webhook test entry point (allowlist-only, audited)
- [x] Forced-failure tests, flaky handling
- [x] Process rule in project memory
- [x] Full run + report
- [x] Delete temporary legacy-reminders-dryrun function
- [x] Fix: Monty acting on old history (grounding, multi-round tools, future-action guard) + 3 handler regression tests
- [x] One-off vs weekly rules + names-not-pronouns (approved by Matt)
- [x] Shared MONTY_CLAUDE_MODEL setting + baseline run
- [x] Full suite on new model (claude-sonnet-5-5 kept)
- [x] Fix flaky "PE kit moved Tue→Wed" (moves decided in code)
- [x] Combined which-child + one-off/weekly question
- [x] Short code-built confirmations
