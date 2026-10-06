CREATE TABLE public.opted_out_numbers (
  phone_number text PRIMARY KEY,
  reason text NOT NULL DEFAULT 'stop',
  source text,
  opted_out_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.opted_out_numbers TO service_role;
ALTER TABLE public.opted_out_numbers ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.deletion_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  phone_hash text,
  row_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  twilio_deleted integer NOT NULL DEFAULT 0,
  auth_user_deleted boolean NOT NULL DEFAULT false,
  kind text NOT NULL DEFAULT 'full'
);
GRANT ALL ON public.deletion_audit TO service_role;
GRANT SELECT ON public.deletion_audit TO authenticated;
ALTER TABLE public.deletion_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view deletion audit" ON public.deletion_audit FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));