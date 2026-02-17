
-- Schools table (pre-populated with DfE GIAS data)
CREATE TABLE public.schools (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  postcode TEXT NOT NULL,
  urn TEXT UNIQUE NOT NULL,
  address TEXT,
  local_authority TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS (public read, no public write)
ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Schools are publicly readable"
  ON public.schools FOR SELECT
  USING (true);

-- Index for search
CREATE INDEX idx_schools_name ON public.schools USING gin(to_tsvector('english', name));
CREATE INDEX idx_schools_postcode ON public.schools (postcode);
CREATE INDEX idx_schools_urn ON public.schools (urn);

-- Children table
CREATE TABLE public.children (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id UUID NOT NULL,
  school_id UUID NOT NULL REFERENCES public.schools(id),
  first_name TEXT NOT NULL,
  year_group TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.children ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Parents can view their own children"
  ON public.children FOR SELECT
  TO authenticated
  USING (auth.uid() = parent_id);

CREATE POLICY "Parents can add their own children"
  ON public.children FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = parent_id);

CREATE POLICY "Parents can update their own children"
  ON public.children FOR UPDATE
  TO authenticated
  USING (auth.uid() = parent_id);

CREATE POLICY "Parents can delete their own children"
  ON public.children FOR DELETE
  TO authenticated
  USING (auth.uid() = parent_id);

CREATE INDEX idx_children_parent ON public.children (parent_id);

CREATE TRIGGER update_children_updated_at
  BEFORE UPDATE ON public.children
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Consent records table
CREATE TABLE public.consent_records (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  consent_type TEXT NOT NULL DEFAULT 'signup',
  consented_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ip_address TEXT
);

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own consent records"
  ON public.consent_records FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own consent records"
  ON public.consent_records FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_consent_user ON public.consent_records (user_id);
