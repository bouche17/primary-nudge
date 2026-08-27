GRANT EXECUTE ON FUNCTION public.get_upcoming_parent_notes(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_parent_note(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_upcoming_parent_notes(uuid, integer) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.delete_parent_note(uuid) FROM anon, public;