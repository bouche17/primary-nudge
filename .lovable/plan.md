# Monty regression test suite

## Goal
One on-demand test run that checks the WhatsApp handler and the reminder sender against about 30 real-world scenarios. It checks database state and reply honesty, never sends a WhatsApp message, and saves every run for review.

## How it stays safe
- **Test numbers:** +447000000001 to +447000000010, stored in a new `test_phone_numbers` allowlist table.
- **Test families:** test parents are real login accounts (needed for children and reminders) with `@monty-test.invalid` emails. Their numbers are on the allowlist.
- **No sends, at two levels:**
  - Every sender (whatsapp-webhook, send-reminders, sunday-lunch-checkin, send-family-update, flush-family-updates, handle-school-email, send-welcome) skips the Twilio call for any allowlisted number. It records the would-be message instead.
  - The test runner also calls the handler with a `dry_run` flag that stubs Twilio completely.
- **Kept out of real runs:** the cron reminder runs, Sunday check-ins, the family-update queue and the family audit page all filter out allowlisted numbers and their families.
- **Reset and clean-up:** before each scenario, all rows for test families are wiped and fixtures re-seeded: children, reminders, notes, lunch plans, conversations and onboarding state. They're wiped again at the end. Real parents' rows are never touched, because every delete is limited to allowlisted numbers and test user ids.

## What gets tested
**Handler scenarios (about 30, using real AI, run once each)**
Each scenario sends one or more messages through the real handler logic with a fixed "now" time, in dry-run mode, then checks:
- the expected rows were created, updated or deleted in child_reminders, parent_notes, weekly_lunch_plans and onboarding_state;
- whether the reply may claim success (only when a save truly happened);
- for some scenarios, required words in the reply, e.g. "which child", "7am", "didn't save".

The 17 scenarios you listed, plus about 13 from recent real conversations (anonymised):
- Jude's packed lunch on the wrong day
- Harry's gymnastics wrongly "already saved"
- Rosa's gymnastics treated as PE kit
- Vinny's "reading for pleasure" book
- Mila's Young Voices reminder moved to the night before
- the "fortnightly" text in a title with no date
- moving a reminder to another day
- removing a packed lunch day (switch back to school dinners)
- a full-week lunch replace
- a weekend packed lunch being refused
- a "school dinners tomorrow" one-off
- a note for 2 children at once
- an "every other Friday" request with no date, where Monty must ask

**Forced failures (no AI cost)**
- **Database write failure:** a test-only switch makes the save fail. The test expects the "didn't save" reply and no rows written.
- **AI follow-up failure:** a test-only switch makes Monty's second AI call fail. The test expects the code-built "Saved: …" reply.

**Reminder sender scenarios (no AI, no sends)**
send-reminders gets an exported `buildMessagesFor(nowOverride, onlyPhones)` that returns the messages it would send. Checks:
- a weekday morning and evening message;
- Friday evening covering a Saturday item;
- a fortnightly item on its on-week and off-week;
- 25 Oct and 26 Oct 2026, around the clock change, at the right UK times;
- a 6pm-after note showing up in the next morning's message;
- the double-send guard: a second run for the same slot sends nothing.

## Flakiness
Any scenario that depends on the AI and fails is run once more, but only that scenario. If the retry passes, it's marked **flaky**, not passed. Pass, fail and flaky are all stored.

## Results
- **New `test_runs` table:** one row per run (start time, totals, cost estimate).
- **New `test_run_results` table:** one row per scenario (name, status pass/fail/flaky, the reply Monty would have sent, the reason for any failure, and the database checks). Admin-only access.
- **New admin page `/admin/tests`:** a "Run suite" button, the latest run's results table, and a run history list.

## Process rule
The rule you gave is added to project memory as a core rule.

## Technical details
- **New function `monty-test-runner`** (admin JWT required):
  - seeds fixtures and runs the scenarios;
  - calls the whatsapp-webhook internals through a new internal entry point: a POST with `x-monty-test-secret` and JSON `{phone, message, now, dry_run, fail_db, fail_followup}`;
  - checks the database and writes the results.
  - The secret is generated as `MONTY_TEST_SECRET`.
- **whatsapp-webhook:**
  - accepts the internal test entry point, skipping the Twilio signature check only when the secret matches;
  - uses a `nowOverride` for all date anchors;
  - routes sends through `sendOrRecord()`;
  - adds a test-only fault switch on the save path.
- **send-reminders:** the send logic is split into "build messages" and "send". A `dry_run` + `now` + `only_phones` query mode (secret-gated) returns the messages, and the allowlist is filtered out of real runs.
- **Other senders:** a shared `_shared/testPhones.ts` loads the allowlist and filters recipients.
- **Database migration:** adds `test_phone_numbers`, `test_runs` and `test_run_results` (with permissions and admin-only access rules), plus seeding of the 10 test numbers.
- **Cost estimate:** about 30 scenarios × about 2 AI calls each (some have 3–4 turns) ≈ 80 AI calls of around 3k input tokens. That's roughly 0.25M input and 20k output tokens, about $1 per full run on Sonnet 4.6, plus a few cents of backend time. The sender tests are free.

## After building
Run the suite once and report:
- the number of scenarios and the result for each;
- what's failing and the likely real bug behind it (not fixed yet);
- the files and tables added;
- the measured cost of the run.
