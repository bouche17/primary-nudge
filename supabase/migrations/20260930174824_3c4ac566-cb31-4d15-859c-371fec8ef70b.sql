CREATE TABLE public.pending_family_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key text NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_first_name text,
  item_key text,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processing_at timestamptz,
  sent_at timestamptz
);
GRANT ALL ON public.pending_family_updates TO service_role;
ALTER TABLE public.pending_family_updates ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX pending_family_updates_item_unsent
  ON public.pending_family_updates (family_key, item_key)
  WHERE sent_at IS NULL AND item_key IS NOT NULL;
CREATE INDEX pending_family_updates_unsent ON public.pending_family_updates (family_key) WHERE sent_at IS NULL;
CREATE TRIGGER update_pending_family_updates_updated_at
  BEFORE UPDATE ON public.pending_family_updates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Atomically claim unsent rows for families that are ready to flush.
CREATE OR REPLACE FUNCTION public.claim_family_updates(_quiet_minutes int DEFAULT 5, _cap_minutes int DEFAULT 30)
RETURNS SETOF public.pending_family_updates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH ready AS (
    SELECT family_key FROM public.pending_family_updates
    WHERE sent_at IS NULL
    GROUP BY family_key
    HAVING max(updated_at) <= now() - make_interval(mins => _quiet_minutes)
        OR min(created_at) <= now() - make_interval(mins => _cap_minutes)
  ), locked AS (
    SELECT p.id FROM public.pending_family_updates p
    JOIN ready r ON r.family_key = p.family_key
    WHERE p.sent_at IS NULL
      AND (p.processing_at IS NULL OR p.processing_at < now() - interval '10 minutes')
    FOR UPDATE OF p SKIP LOCKED
  )
  UPDATE public.pending_family_updates p
  SET processing_at = now()
  FROM locked WHERE p.id = locked.id
  RETURNING p.*;
END $$;
REVOKE ALL ON FUNCTION public.claim_family_updates(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_family_updates(int, int) TO service_role;