# Agent rules
- Test safety: every Twilio sender calls `blockIfTestPhone` from `supabase/functions/_shared/testGuard.ts`; test families (allowlisted in `test_phone_numbers`, +4470000000xx) are excluded from real runs — why: tests must never reach a real parent or Twilio.
- send-reminders is split into `buildReminderMessages` (read-only) and `deliverReminderMessages` (real/stub); test entry needs MONTY_TEST_SECRET (constant-time) and is audited in `test_entry_audit` — why: the build can be verified without sending.
- `monty-test-runner` runs the suite (admin JWT or single-use `test_runner_tokens` row) and writes `test_runs`/`test_run_results` — why: one auditable place for regression results.
