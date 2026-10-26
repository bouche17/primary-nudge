CREATE TABLE public.school_email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  school_id uuid REFERENCES public.schools(id) ON DELETE SET NULL,
  subject text,
  extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  message text,
  year_groups text[] NOT NULL DEFAULT '{}',
  opt_in boolean NOT NULL DEFAULT false,
  event_title text,
  event_date date,
  families_count integer NOT NULL DEFAULT 0,
  phones_count integer NOT NULL DEFAULT 0,
  is_test boolean NOT NULL DEFAULT false
);
GRANT SELECT ON public.school_email_log TO authenticated;
GRANT ALL ON public.school_email_log TO service_role;
ALTER TABLE public.school_email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read school email log" ON public.school_email_log
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX IF NOT EXISTS school_email_log_received_idx ON public.school_email_log (received_at DESC);

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS school_email_id uuid REFERENCES public.school_email_log(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb;
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON public.messages (conversation_id, created_at DESC);