# Roadmap — Monty test suite

## Stage 1 (in progress)
- [ ] test_phone_numbers allowlist + test_runs / test_run_results / test_entry_audit tables
- [ ] Never-send-to-test-numbers safeguard in every sender; test data excluded from real runs
- [ ] send-reminders split into build/send + secret-gated dry-run (constant-time, audited, dry_run default true, no Twilio)
- [ ] Reminder sender tests (weekday, Fri→Sat, fortnightly on/off, 25/26 Oct, after-6pm note, double-send guard)
- [ ] /admin/tests page
- [ ] Dry run of tonight's real 6pm reminders vs old code — report to Matt, then STOP

## Stage 2 (waits on Matt's go-ahead after Stage 1)
- [ ] ~30 handler scenarios via locked-down whatsapp-webhook test entry point (allowlist-only, audited)
- [ ] Forced-failure tests, flaky handling
- [ ] Process rule in project memory
- [ ] Full run + report
