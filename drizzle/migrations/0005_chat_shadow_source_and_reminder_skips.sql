ALTER TABLE public.whats_on_shadow_diffs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'reminders';
CREATE INDEX IF NOT EXISTS whats_on_shadow_diffs_run_source_idx ON public.whats_on_shadow_diffs (run_date, source);

-- One date skipped for a weekly/fortnightly reminder ("cancel Harry's swimming this week"); the reminder stays active.
CREATE TABLE public.child_reminder_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES public.child_reminders(id) ON DELETE CASCADE,
  skip_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, skip_date)
);
GRANT ALL ON public.child_reminder_skips TO service_role;
ALTER TABLE public.child_reminder_skips ENABLE ROW LEVEL SECURITY;