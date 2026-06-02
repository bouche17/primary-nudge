CREATE OR REPLACE FUNCTION public.delete_parent_note(_note_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_phone text;
  rows_deleted integer;
BEGIN
  SELECT phone_number INTO caller_phone
  FROM public.profiles
  WHERE user_id = auth.uid()
    AND phone_number IS NOT NULL
  LIMIT 1;

  IF caller_phone IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.parent_notes
  WHERE id = _note_id
    AND phone_number = caller_phone;

  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  RETURN rows_deleted > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_parent_note(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_parent_note(uuid) FROM anon, public;
