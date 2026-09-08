CREATE OR REPLACE FUNCTION public.get_partner_phones(_user_id uuid)
RETURNS TABLE(user_id uuid, phone_number text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.user_id,
    p.phone_number
  FROM public.linked_accounts la
  JOIN public.profiles p
    ON p.user_id = CASE
      WHEN la.primary_user_id = _user_id THEN la.linked_user_id
      ELSE la.primary_user_id
    END
  WHERE la.status = 'accepted'
    AND (la.primary_user_id = _user_id OR la.linked_user_id = _user_id);
$$;

GRANT EXECUTE ON FUNCTION public.get_partner_phones(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_phones(uuid) TO service_role;