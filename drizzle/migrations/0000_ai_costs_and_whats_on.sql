CREATE TABLE public.ai_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  function_name text NOT NULL,
  purpose text NOT NULL,
  family_id uuid,
  school_id uuid,
  model text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(10,5) NOT NULL DEFAULT 0,
  is_test boolean NOT NULL DEFAULT false
);
GRANT SELECT ON public.ai_costs TO authenticated;
GRANT ALL ON public.ai_costs TO service_role;
ALTER TABLE public.ai_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read ai costs" ON public.ai_costs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX ai_costs_created_idx ON public.ai_costs(created_at);

CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read settings" ON public.app_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
INSERT INTO public.app_settings(key, value) VALUES ('whats_on_source', 'legacy');

CREATE TABLE public.whats_on_shadow_diffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  run_date date NOT NULL,
  family_id uuid NOT NULL,
  family_label text,
  item_date date NOT NULL,
  item text NOT NULL,
  side text NOT NULL,
  likely_reason text,
  verdict text,
  verdict_at timestamptz
);
GRANT SELECT, UPDATE ON public.whats_on_shadow_diffs TO authenticated;
GRANT ALL ON public.whats_on_shadow_diffs TO service_role;
ALTER TABLE public.whats_on_shadow_diffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read diffs" ON public.whats_on_shadow_diffs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins set verdict" ON public.whats_on_shadow_diffs FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX whats_on_diffs_run_idx ON public.whats_on_shadow_diffs(run_date, family_id);