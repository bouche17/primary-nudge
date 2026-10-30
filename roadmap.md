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
- [x] Data check for Matt: "PTA KS1 Disco" is tagged whole-school; two "school closes" events on 22 Oct (handled in code, 20 Oct)

## Thursday 22 Oct reminder fixes (due Wed 21 Oct 15:00 UK; else whats_on_source → legacy)
- [x] After-school sport/activity words + 15:15 time rule → opt-in (Y4/5/6 Swimming stays)
- [x] KS1/KS2/EYFS title narrows an "all"/blank year group (shared logic: reminders, dashboard, chat)
- [x] Same-day school-event markers: shorter title contained in longer → one line
- [x] Chat duplicate check picks the event sharing most words with the parent's message (+ girls test)
- [x] Free tests, quick suite, shadow re-run, Thursday 22nd evening dry-run examples

## Reminder polish (live before Sun 1 Nov 18:00)
- [x] Shared school event once per family ("Everyone" / "A & B"), right school only, Everyone first, template too
- [x] Deadline words kept; relative days → real day from the item's date
- [x] Parent item + school event on the same topic → one school line with the parent's extra detail
- [x] Always-include words beat club/activity words
- [x] Free tests; dry-run Sun 1 Nov 18:00 and Mon 2 Nov 07:00

## Sunday check-in holiday skip (live before Sun 25 Oct 18:00)
- [x] Skip a family when the whole Mon–Fri is a holiday for all its schools (no send, no log row); partial weeks unchanged
- [x] Free tests (whole-week holiday, week after, one INSET day, two schools) + read-only previews for 25 Oct and 1 Nov
- [ ] Remove send-reminders' hard-coded summer pause (TODO left in code; separate job)

## School accuracy + sign-up alerts (23 Oct)
- [x] Sign-up school search: name + street/town + postcode, town-first when names repeat, postcode/town search, confirm step; same for add child + "Change school" on dashboard
- [x] Chat: "wrong school" → ask which school (never "wrong number"), offer up to 3 matches, change only after confirm, clear school-linked data, log `school_changed`; quick-suite tests
- [x] New sign-up alerts to Matt (no phone/email in text): /admin/signups, WhatsApp in 24h window, free tests
- [ ] Email alerts to hello@heymonty.co.uk (sign-ups + email_pending outage alerts) — blocked: heymonty.co.uk email domain not set up yet
- [x] Load Mossley CofE (URN 141152) 2026–27 holidays; dry-run Oscar's family week of 26 Oct + Sunday 25 Oct skip
- [x] Free tests (83/83), then quick suite once (104/104)
- [x] Reply guard turns conditional offers ("tell me and I'll set up a reminder") into "haven't saved anything yet" — waits on Matt's OK (chat change, needs a quick run)

## Rebuild Stage 3 — dashboard + chat on getWhatsOn, "Ask Monty" (23 Oct)
- [x] A: dashboard_source setting; dashboard upcoming from whats-on (14 days, UK dates, reminder wording, opt-in tagged "optional"); free tests (partner, fortnightly, holiday, 23:30 UK date); switch to 'new'
- [x] B: chat_source setting; chat context + duplicate check from getWhatsOn (family, partner notes, due-dated school reminders, opt-in flagged); chat shadow diffs (source 'chat'); quick suite
- [x] C: lookup_whats_on / update_item / delete_item tools (per-date skip, deactivate, school items → offer hide, confirm pending action, family ownership check, partner update, honesty); quick suite
- [x] Switch chat_source to 'new' (done 26 Oct) — was blocked: full suite on 'new' had 1 failure (reply guard turns "Once I have the date, I'll set it up" into "haven't saved anything yet"); legacy 169/169. Waits on Matt's OK to fix the guard, then full suite again

## Prompt caching (26 Oct)
- [x] Chat + photo prompts split into cached static / cached family / uncached now blocks; fixed tool lists; follow-up rounds cached
- [x] School-email instructions in a cached block
- [x] ai_costs cache columns, correct pricing, hit rate on /admin/costs
- [x] Block sizes logged; free tests + quick suite

## Chat switch-over (26 Oct)
- [x] Reply check ignores conditional offers/questions + free tests
- [x] Full suite with chat_source='new' (184/185) — not switched
- [x] 'General information with no date' rule in the static prompt + 'Mrs Smith is off sick' test
- [x] Free 108/108, full suite on 'new' 186/186 → chat_source='new' live (26 Oct); post-switch dry runs checked
- [x] St Joseph's (URN 149875) 2026–27 holidays loaded

## Monty sees its own messages (26 Oct)
- [x] Every outbound message (school email, reminders, Sunday check-in, family/partner updates, alerts, welcome, newsletter) saved to the recipient's conversation with rendered template wording + source
- [x] Chat history labels "[Monty sent — …]"; short replies (yes / seen / thanks / 👍 / no) handled in code; robotic-wording guard; "Mrs Smith" well-wish guard
- [x] school_email_log + /admin/school-emails; opt-in emails worded "If <child>'s in …" (no gender filtering); school emails only to that school's families
- [x] Free 122/122, full suite 205 pass + 1 flaky

- [ ] Send the two approved account-check messages (Hallie school check with pending reply; Oscar Mossley term dates) — blocked: monty_general_account_v1 still pending WhatsApp approval. Run via account-check `send` (child_id, detail, school_check for Hallie), then `delivery`.

## Button fixes from Matt's phone test (29 Oct)
- [x] 1 Stale taps: question IDs in payloads + 7-day question archive, re-ask / "already done" instead of "lost track"
- [x] 2 Child first, then "just/every" (one question per button set)
- [x] 3 Buttons on reminder picks (+ Neither, then Just this week / For good) and on plain-text child questions (+ Both)
- [x] 4 Common words never a duplicate match on their own
- [x] 5 One shared "this/next <day>" resolver (15:30 cut-off)
- [x] 6 Keep the parent's capitalisation (PE, not pE)
- [x] Tests: free + Matt's replay, then one quick suite

## Reliability before 2 Nov (30 Oct)
- [x] Nightly what's-on shadow cron (job 22) off, no failure alerts; table, /admin/whats-on-diffs and queue_whats_on_shadow() kept for manual runs
- [x] Morning/evening/Sunday runs via one UK-time scheduler with retries at +5 / +15 and one alert if all fail
- [x] Free tests: failure+retry, partial runs (reminders + Sunday), one alert, GMT/BST times
