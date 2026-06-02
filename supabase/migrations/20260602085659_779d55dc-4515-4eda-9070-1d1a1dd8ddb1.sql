CREATE OR REPLACE FUNCTION public.get_upcoming_parent_notes(_user_id uuid, _days integer DEFAULT 7)
RETURNS TABLE (
  id uuid,
  child_name text,
  summary text,
  event_date date,
  raw_content text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH caller AS (
    SELECT phone_number FROM public.profiles
    WHERE user_id = _user_id
      AND user_id = auth.uid()
      AND phone_number IS NOT NULL
    LIMIT 1
  )
  SELECT
    pn.id,
    pn.child_name,
    pn.summary,
    (d->>'date')::date AS event_date,
    pn.raw_content,
    pn.created_at
  FROM public.parent_notes pn
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pn.extracted_dates, '[]'::jsonb)) AS d
  WHERE pn.phone_number = (SELECT phone_number FROM caller)
    AND (d->>'date') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (d->>'date')::date >= CURRENT_DATE
    AND (d->>'date')::date <= CURRENT_DATE + (_days || ' days')::interval
  ORDER BY (d->>'date')::date ASC;
$$;
