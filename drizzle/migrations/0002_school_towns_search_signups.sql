-- Post towns for school addresses (postcode district -> post town), schools.town, school search,
-- sign-up events for Matt's alerts, and the shared school-change function.
CREATE TABLE public.postcode_district_towns (
  district text PRIMARY KEY,
  town text NOT NULL
);
GRANT SELECT ON public.postcode_district_towns TO anon, authenticated;
GRANT ALL ON public.postcode_district_towns TO service_role;
ALTER TABLE public.postcode_district_towns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Post towns are publicly readable" ON public.postcode_district_towns FOR SELECT USING (true);

ALTER TABLE public.schools ADD COLUMN IF NOT EXISTS town text;

CREATE OR REPLACE FUNCTION public.set_school_town()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.town IS NULL OR (TG_OP = 'UPDATE' AND NEW.postcode IS DISTINCT FROM OLD.postcode) THEN
    SELECT t.town INTO NEW.town FROM public.postcode_district_towns t
    WHERE t.district = upper(split_part(trim(NEW.postcode), ' ', 1));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER set_school_town BEFORE INSERT OR UPDATE OF postcode, town ON public.schools
FOR EACH ROW EXECUTE FUNCTION public.set_school_town();

-- Fills schools.town from the post-town list (loaded by the school-towns function). Service role only.
CREATE OR REPLACE FUNCTION public.backfill_school_towns()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.schools s SET town = t.town
  FROM public.postcode_district_towns t
  WHERE t.district = upper(split_part(trim(s.postcode), ' ', 1)) AND s.town IS DISTINCT FROM t.town;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.backfill_school_towns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_school_towns() TO service_role;

-- School search: every word must start a word in the name, street, town, council area or postcode.
CREATE OR REPLACE FUNCTION public.search_schools(_q text, _limit integer DEFAULT 20)
RETURNS TABLE(id uuid, name text, postcode text, address text, town text, local_authority text, urn text)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH q AS (
    SELECT array_remove(regexp_split_to_array(trim(regexp_replace(lower(regexp_replace(coalesce(_q, ''), '[''’`]', '', 'g')), '[^a-z0-9]+', ' ', 'g')), ' '), '') AS toks,
           lower(regexp_replace(coalesce(_q, ''), '[^A-Za-z0-9]', '', 'g')) AS compact
  ), hay AS (
    SELECT s.*, ' ' || regexp_replace(lower(regexp_replace(s.name || ' ' || coalesce(s.address, '') || ' ' || coalesce(s.town, '') || ' ' || coalesce(s.local_authority, '') || ' ' || s.postcode || ' ' || replace(s.postcode, ' ', ''), '[''’`]', '', 'g')), '[^a-z0-9]+', ' ', 'g') || ' ' AS h
    FROM public.schools s
  )
  SELECT hay.id, hay.name, hay.postcode, hay.address, hay.town, hay.local_authority, hay.urn
  FROM hay, q
  WHERE cardinality(q.toks) > 0 AND length(q.compact) >= 2
    AND NOT EXISTS (SELECT 1 FROM unnest(q.toks) tok WHERE position(' ' || tok IN hay.h) = 0)
  ORDER BY (lower(replace(hay.postcode, ' ', '')) = q.compact) DESC,
           (lower(replace(hay.postcode, ' ', '')) LIKE q.compact || '%') DESC,
           (position(' ' || q.toks[1] IN ' ' || lower(hay.name)) = 1) DESC,
           hay.name, hay.postcode
  LIMIT least(greatest(coalesce(_limit, 20), 1), 50);
$$;
GRANT EXECUTE ON FUNCTION public.search_schools(text, integer) TO anon, authenticated, service_role;

-- Sign-up events: one row per new parent profile / child added. Test families are never recorded.
CREATE TABLE public.signup_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  user_id uuid NOT NULL,
  child_id uuid,
  processed_at timestamptz,
  channel text,
  delivered boolean NOT NULL DEFAULT false,
  alert_text text
);
CREATE INDEX signup_events_pending_idx ON public.signup_events (created_at) WHERE processed_at IS NULL;
CREATE INDEX signup_events_user_idx ON public.signup_events (user_id);
GRANT SELECT ON public.signup_events TO authenticated;
GRANT ALL ON public.signup_events TO service_role;
ALTER TABLE public.signup_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view sign-up events" ON public.signup_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.is_test_phone(_phone text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _phone IS NOT NULL AND (_phone ~ '^\+4470000000[0-9][0-9]$' OR EXISTS (SELECT 1 FROM public.test_phone_numbers WHERE phone_number = _phone))
$$;
REVOKE ALL ON FUNCTION public.is_test_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_test_phone(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_signup_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NOT public.is_test_phone(NEW.phone_number) THEN
      INSERT INTO public.signup_events(kind, user_id) VALUES ('profile_created', NEW.user_id);
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'record_signup_profile failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER record_signup_profile AFTER INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.record_signup_profile();

CREATE OR REPLACE FUNCTION public.record_signup_child()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ph text;
BEGIN
  BEGIN
    SELECT phone_number INTO ph FROM public.profiles WHERE user_id = NEW.parent_id LIMIT 1;
    IF NOT public.is_test_phone(ph) THEN
      INSERT INTO public.signup_events(kind, user_id, child_id) VALUES ('child_added', NEW.parent_id, NEW.id);
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'record_signup_child failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER record_signup_child AFTER INSERT ON public.children
FOR EACH ROW EXECUTE FUNCTION public.record_signup_child();

-- Change a child's school (dashboard or WhatsApp). Clears school-linked data that no longer applies
-- (event exclusions for the old school's events); the parent's own notes and reminders are kept.
-- Every change is logged as a "school_changed" dedup decision.
CREATE OR REPLACE FUNCTION public.change_child_school(_child_id uuid, _school_id uuid, _source text DEFAULT 'dashboard')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c record; old_s record; new_s record; ph text;
BEGIN
  SELECT * INTO c FROM public.children WHERE id = _child_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF auth.uid() IS NOT NULL THEN
    IF c.parent_id NOT IN (SELECT public.get_family_user_ids(auth.uid())) THEN RETURN false; END IF;
  ELSIF coalesce(auth.role(), '') <> 'service_role' THEN
    RETURN false;
  END IF;
  SELECT * INTO new_s FROM public.schools WHERE id = _school_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.school_id = _school_id THEN RETURN true; END IF;
  SELECT * INTO old_s FROM public.schools WHERE id = c.school_id;
  UPDATE public.children SET school_id = _school_id WHERE id = _child_id;
  DELETE FROM public.event_exclusions WHERE child_id = _child_id;
  SELECT phone_number INTO ph FROM public.profiles WHERE user_id = coalesce(auth.uid(), c.parent_id) LIMIT 1;
  INSERT INTO public.dedup_decisions(phone_number, child_name, tool, new_item, decision, matched_table, matched_id, matched_text)
  VALUES (ph, c.first_name, 'school_change_' || left(coalesce(_source, 'dashboard'), 20),
    coalesce(old_s.name || ' ' || old_s.postcode || ' (URN ' || old_s.urn || ')', 'none') || ' -> ' || new_s.name || ' ' || new_s.postcode || ' (URN ' || new_s.urn || ')',
    'school_changed', 'schools', _school_id::text, new_s.name || ', ' || coalesce(new_s.address || ', ', '') || coalesce(new_s.town || ' ', '') || new_s.postcode);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.change_child_school(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_child_school(uuid, uuid, text) TO authenticated, service_role;

-- Admin views for /admin/signups.
CREATE OR REPLACE FUNCTION public.admin_signups(_days integer DEFAULT 30)
RETURNS TABLE(event_id uuid, created_at timestamptz, kind text, user_id uuid, parent_first_name text, child_id uuid, child_first_name text,
  year_group text, school_name text, school_address text, school_town text, school_postcode text, school_urn text, known_school boolean,
  processed_at timestamptz, channel text, delivered boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.created_at, e.kind, e.user_id,
    nullif(split_part(trim(coalesce(u.raw_user_meta_data->>'given_name', u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')), ' ', 1), ''),
    e.child_id, ch.first_name, ch.year_group, s.name, s.address, s.town, s.postcode, s.urn,
    CASE WHEN s.id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM public.school_calendar_feeds f WHERE f.school_id = s.id) END,
    e.processed_at, e.channel, e.delivered
  FROM public.signup_events e
  LEFT JOIN auth.users u ON u.id = e.user_id
  LEFT JOIN public.children ch ON ch.id = e.child_id
  LEFT JOIN public.schools s ON s.id = ch.school_id
  WHERE public.has_role(auth.uid(), 'admin'::app_role)
    AND e.created_at > now() - make_interval(days => least(greatest(coalesce(_days, 30), 1), 365))
  ORDER BY e.created_at DESC
$$;
REVOKE ALL ON FUNCTION public.admin_signups(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_signups(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_school_changes(_days integer DEFAULT 30)
RETURNS TABLE(created_at timestamptz, child_name text, tool text, change text, new_school text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.created_at, d.child_name, d.tool, d.new_item, d.matched_text
  FROM public.dedup_decisions d
  WHERE public.has_role(auth.uid(), 'admin'::app_role) AND d.decision = 'school_changed'
    AND d.created_at > now() - make_interval(days => least(greatest(coalesce(_days, 30), 1), 365))
    AND NOT public.is_test_phone(d.phone_number)
  ORDER BY d.created_at DESC
$$;
REVOKE ALL ON FUNCTION public.admin_school_changes(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_school_changes(integer) TO authenticated;

-- Show the last 30 days' existing sign-ups on /admin/signups (already handled: no alerts are sent for these).
INSERT INTO public.signup_events(created_at, kind, user_id, child_id, processed_at, channel)
SELECT c.created_at, 'child_added', c.parent_id, c.id, now(), 'backfilled'
FROM public.children c
LEFT JOIN public.profiles p ON p.user_id = c.parent_id
WHERE c.created_at > now() - interval '30 days' AND NOT public.is_test_phone(p.phone_number);
