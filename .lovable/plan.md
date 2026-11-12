# Security scan: the 2 flagged issues (read-only report)

Latest scan: 12 Nov 10:12 UTC. Dependency scan: no issues (last run 30 Oct). Build log and runtime error log: empty, so no recent errors.

## The 2 flagged issues
1. **Anyone can read every record in school_reminders**. Severity: Error. Table: `school_reminders`, policy "Anyone can read reminders" (USING true).
   - Real risk: low. These are school-wide reminders, not parent data. Anyone with the public key can still list every school's reminders.
   - Minimal fix: change the policy to signed-in users only, or to the caller's own school. Or mark it as intended if it is meant to be public.
2. **Whoever signs up can read every record in school_events**. Severity: Warning. Table: `school_events`, policy "Authenticated users can read events" (auth.uid() IS NOT NULL).
   - Real risk: low to medium. These are public calendar events, but the list includes private items such as "SEND Review – Invite Only". Our code hides them from parents, but any account can read the raw rows.
   - Minimal fix: limit reads to events for schools the caller's children attend, or hide private-word events from that read.

## Also listed (Info, probably not in the count of 2)
- `schools` and `postcode_district_towns`: both are public on purpose because sign-up search needs them. No risk; can be marked as intended.

## If Matt wants them fixed
One small database change, plus FREE tests only:
- school_reminders: allow signed-in users only.
- school_events: allow a family's own schools only.
I haven't changed anything.
