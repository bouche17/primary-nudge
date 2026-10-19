# send-reminders rules
- Morning/evening reminder layout lives in `_shared/reminderFormat.ts`: free-form "emoji Child: item" lines only inside the parent's 24h window, else the approved template with a one-line `{{1}}` (no newlines); free-form failure falls back to the template — why: WhatsApp template variables can't hold line breaks and delivery must never break.
