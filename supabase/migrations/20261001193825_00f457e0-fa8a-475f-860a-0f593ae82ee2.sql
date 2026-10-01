CREATE TABLE public.test_phone_numbers (
  phone_number text PRIMARY KEY,
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.test_phone_numbers TO authenticated;
GRANT ALL ON public.test_phone_numbers TO service_role;
ALTER TABLE public.test_phone_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view test numbers" ON public.test_phone_numbers FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
INSERT INTO public.test_phone_numbers (phone_number, label)
SELECT '+4470000000' || lpad(n::text, 2, '0'), 'Monty test family ' || n FROM generate_series(1, 10) n
ON CONFLICT DO NOTHING;

CREATE TABLE public.test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  suite text NOT NULL DEFAULT 'full',
  triggered_by uuid,
  total integer NOT NULL DEFAULT 0,
  passed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  flaky integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  notes text
);
GRANT SELECT ON public.test_runs TO authenticated;
GRANT ALL ON public.test_runs TO service_role;
ALTER TABLE public.test_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view test runs" ON public.test_runs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.test_run_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.test_runs(id) ON DELETE CASCADE,
  scenario text NOT NULL,
  category text NOT NULL,
  status text NOT NULL,
  reply text,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.test_run_results TO authenticated;
GRANT ALL ON public.test_run_results TO service_role;
ALTER TABLE public.test_run_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view test results" ON public.test_run_results FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.test_entry_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  entry_point text NOT NULL,
  phone_number text,
  scenario text,
  allowed boolean NOT NULL,
  reason text
);
GRANT SELECT ON public.test_entry_audit TO authenticated;
GRANT ALL ON public.test_entry_audit TO service_role;
ALTER TABLE public.test_entry_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view test audit" ON public.test_entry_audit FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));