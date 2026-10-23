-- Better ranking: exact postcode, then exact town, then the words as a phrase in the name, then name prefix.
CREATE OR REPLACE FUNCTION public.search_schools(_q text, _limit integer DEFAULT 20)
RETURNS TABLE(id uuid, name text, postcode text, address text, town text, local_authority text, urn text)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH q AS (
    SELECT array_remove(regexp_split_to_array(trim(regexp_replace(lower(regexp_replace(coalesce(_q, ''), '[''’`]', '', 'g')), '[^a-z0-9]+', ' ', 'g')), ' '), '') AS toks,
           lower(regexp_replace(coalesce(_q, ''), '[^A-Za-z0-9]', '', 'g')) AS compact
  ), hay AS (
    SELECT s.*,
      ' ' || regexp_replace(lower(regexp_replace(s.name || ' ' || coalesce(s.address, '') || ' ' || coalesce(s.town, '') || ' ' || coalesce(s.local_authority, '') || ' ' || s.postcode || ' ' || replace(s.postcode, ' ', ''), '[''’`]', '', 'g')), '[^a-z0-9]+', ' ', 'g') || ' ' AS h,
      ' ' || trim(regexp_replace(lower(regexp_replace(s.name, '[''’`]', '', 'g')), '[^a-z0-9]+', ' ', 'g')) || ' ' AS hn,
      lower(regexp_replace(coalesce(s.town, ''), '[^A-Za-z0-9]', '', 'g')) AS ht
    FROM public.schools s
  )
  SELECT hay.id, hay.name, hay.postcode, hay.address, hay.town, hay.local_authority, hay.urn
  FROM hay, q
  WHERE cardinality(q.toks) > 0 AND length(q.compact) >= 2
    AND NOT EXISTS (SELECT 1 FROM unnest(q.toks) tok WHERE position(' ' || tok IN hay.h) = 0)
  ORDER BY (lower(replace(hay.postcode, ' ', '')) = q.compact) DESC,
           (lower(replace(hay.postcode, ' ', '')) LIKE q.compact || '%') DESC,
           (hay.ht = q.compact) DESC,
           (position(' ' || array_to_string(q.toks, ' ') IN hay.hn) > 0) DESC,
           (position(' ' || q.toks[1] IN hay.hn) = 1) DESC,
           hay.name, hay.postcode
  LIMIT least(greatest(coalesce(_limit, 20), 1), 50);
$$;
GRANT EXECUTE ON FUNCTION public.search_schools(text, integer) TO anon, authenticated, service_role;
