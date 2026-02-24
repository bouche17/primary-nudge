
-- Table to store notes extracted from forwarded messages/emails
CREATE TABLE public.parent_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  summary TEXT,
  extracted_dates JSONB DEFAULT '[]'::jsonb,
  extracted_actions JSONB DEFAULT '[]'::jsonb,
  source_type TEXT NOT NULL DEFAULT 'forwarded',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.parent_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on parent_notes"
  ON public.parent_notes FOR ALL
  USING (true) WITH CHECK (true);

-- Table to track sent reminders and prevent duplicates
CREATE TABLE public.reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  reminder_type TEXT NOT NULL,
  reference_id TEXT,
  reference_title TEXT,
  period TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.reminder_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on reminder_log"
  ON public.reminder_log FOR ALL
  USING (true) WITH CHECK (true);

-- Index for deduplication lookups
CREATE INDEX idx_reminder_log_dedup
  ON public.reminder_log (phone_number, reference_id, period, sent_at);

-- Index for phone number lookups on parent_notes
CREATE INDEX idx_parent_notes_phone
  ON public.parent_notes (phone_number);
