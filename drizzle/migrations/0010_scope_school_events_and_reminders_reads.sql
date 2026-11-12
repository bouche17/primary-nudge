CREATE OR REPLACE FUNCTION public.is_private_event(_title text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  -- Mirrors isPrivateEvent / PRIVATE_EVENT_WORDS in supabase/functions/_shared/schoolEventRules.ts
  SELECT coalesce(_title, '') ~ '(^|[^[:alnum:]])SEND([^[:alnum:]]|$)'
    OR EXISTS (
      SELECT 1 FROM unnest(ARRAY['invite only','invitation only','by invitation','invited','by appointment',
        'senco','ehcp','annual review','send review','staff only','staff meeting',
        'governors','safeguarding','1 1','one to one','parent meeting']) w
      WHERE ' ' || btrim(regexp_replace(lower(coalesce(_title, '')), '[^[:alnum:]]+', ' ', 'g')) || ' ' LIKE '% ' || w || ' %'
    );
$$;

CREATE OR REPLACE FUNCTION public.can_read_school(_user_id uuid, _school_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.children c
    WHERE c.school_id = _school_id
      AND (c.parent_id = _user_id OR c.parent_id IN (SELECT public.get_family_user_ids(_user_id)))
  );
$$;
REVOKE ALL ON FUNCTION public.can_read_school(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_school(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated users can read events" ON public.school_events;
CREATE POLICY "Parents read their family's school events" ON public.school_events
  FOR SELECT TO authenticated
  USING (public.can_read_school(auth.uid(), school_id) AND NOT public.is_private_event(title));

DROP POLICY IF EXISTS "Anyone can read reminders" ON public.school_reminders;
CREATE POLICY "Signed-in users can read reminders" ON public.school_reminders
  FOR SELECT TO authenticated USING (true);