CREATE TABLE public.school_email_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  from_address text,
  subject text,
  raw_email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  error text,
  attempts integer NOT NULL DEFAULT 0,
  log_id uuid,
  processed_at timestamptz,
  secret_ok boolean
);
GRANT SELECT ON public.school_email_inbox TO authenticated;
GRANT ALL ON public.school_email_inbox TO service_role;
ALTER TABLE public.school_email_inbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read school email inbox" ON public.school_email_inbox FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
INSERT INTO public.app_settings (key, value) VALUES ('school_email_secret_enforced', 'false') ON CONFLICT (key) DO NOTHING;