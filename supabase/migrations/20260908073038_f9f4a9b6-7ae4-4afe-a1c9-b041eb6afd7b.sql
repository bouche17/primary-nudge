REVOKE ALL ON FUNCTION public.get_partner_phones(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_partner_phones(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_partner_phones(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_phones(uuid) TO service_role;