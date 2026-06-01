CREATE TABLE public.event_exclusions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  child_id UUID NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (child_id, keyword)
);

CREATE INDEX idx_event_exclusions_child_id ON public.event_exclusions(child_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_exclusions TO authenticated;
GRANT ALL ON public.event_exclusions TO service_role;

ALTER TABLE public.event_exclusions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Family can manage event exclusions"
ON public.event_exclusions
FOR ALL
TO authenticated
USING (
  child_id IN (
    SELECT c.id FROM public.children c
    WHERE c.parent_id IN (SELECT public.get_family_user_ids(auth.uid()))
  )
)
WITH CHECK (
  child_id IN (
    SELECT c.id FROM public.children c
    WHERE c.parent_id IN (SELECT public.get_family_user_ids(auth.uid()))
  )
);

CREATE POLICY "Service role full access on event_exclusions"
ON public.event_exclusions
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);