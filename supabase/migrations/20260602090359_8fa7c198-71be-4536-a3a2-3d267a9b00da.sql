CREATE POLICY "Users can read their school feeds"
ON public.school_calendar_feeds
FOR SELECT
TO authenticated
USING (
  school_id IN (
    SELECT c.school_id FROM public.children c
    WHERE c.parent_id IN (SELECT public.get_family_user_ids(auth.uid()))
  )
);

GRANT SELECT ON public.school_calendar_feeds TO authenticated;
