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
- [x] Twilio status callback: public + signature-checked, statuses recorded
- [x] Alerts to Matt (Claude failures, failed deliveries) + /admin/tests banner
- [x] Honest outage replies + failed_inbound record
- [x] Opt-out (STOP/START/delete request) in code, all senders skip opted-out numbers
- [x] Admin delete-parent (preview, full delete, family reassignment, Twilio logs, audit)
- [x] Leftover clean-up for deleted accounts; Twilio logs for +447904702768 deleted
- [x] Invented-contact guard, Monty's real contact details, extra deletion phrases, plain-update fallback fix
- [x] Quick suite + button, weekly unattended full suite (cron 21), max_tokens outage fix, contact-address clean-up

## Cost + rebuild (16 Oct)
- [x] Quick suite after credit top-up
- [x] Remove weekly full-suite cron (21); tiered test rule (free / quick / full)
- [x] ai_costs table + /admin/costs
- [x] No test-run alerts; system alerts not via school template; runner refuses overlapping runs
- [x] Step 2: whatsOn.ts, whats-on function, free tests, shadow diffs + nightly cron + /admin/whats-on-diffs, whats_on_source setting
- [ ] Email delivery of outage alerts to hello@heymonty.co.uk — blocked: needs heymonty.co.uk set up as an email domain
- [ ] New utility WhatsApp template "Monty system alert" — blocked: Matt to submit in Twilio

## Rebuild Stage 2 — reminders on getWhatsOn (20 Oct)
- [x] Opt-in school-event flag + free tests; parent-saved event shown once
- [x] Shadow re-run with filter (0 old-only)
- [x] send-reminders reads app_settings.whats_on_source (legacy/new), full suite both ways
- [x] Switched whats_on_source='new'; tonight's 18:00 previewed
- [x] Reminder line tidies (short headline, no links/phones, title tidy everywhere, 🏊)
- [ ] Data check for Matt: "PTA KS1 Disco" is tagged whole-school; two "school closes" events on 22 Oct
