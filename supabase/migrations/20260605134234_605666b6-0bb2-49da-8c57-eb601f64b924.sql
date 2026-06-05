
-- 1. Tighten invite_tokens SELECT: only the inviter can read their own tokens
DROP POLICY IF EXISTS "Anyone authenticated can read tokens by token value" ON public.invite_tokens;
DROP POLICY IF EXISTS "Authenticated users can mark unused tokens as used" ON public.invite_tokens;

CREATE POLICY "Inviters can read their own tokens"
ON public.invite_tokens
FOR SELECT
TO authenticated
USING (auth.uid() = inviter_user_id);

-- 2. Fix linked_accounts privilege escalation: remove the policy letting users
--    claim themselves as linked_user_id (acceptance now goes through redeem-invite edge function)
DROP POLICY IF EXISTS "Linked users can insert accepted links" ON public.linked_accounts;
DROP POLICY IF EXISTS "Linked users can update status" ON public.linked_accounts;

-- 3. school_calendar_feeds.feed_url may contain secret tokens - hide it from authenticated users
REVOKE SELECT (feed_url) ON public.school_calendar_feeds FROM authenticated;
REVOKE SELECT (feed_url) ON public.school_calendar_feeds FROM anon;

-- 4. Make intent explicit on internal tables: explicitly deny non-service_role access
CREATE POLICY "Deny non-service role access on conversations"
ON public.conversations AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY "Deny non-service role access on parent_notes"
ON public.parent_notes AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY "Deny non-service role access on reminder_log"
ON public.reminder_log AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY "Deny non-service role access on messages"
ON public.messages AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY "Deny non-service role access on newsletter_log"
ON public.newsletter_log AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY "Deny non-service role access on lunch_checkin_log"
ON public.lunch_checkin_log AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

CREATE POLICY "Deny non-service role access on onboarding_state"
ON public.onboarding_state AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (false) WITH CHECK (false);

-- 5. SECURITY DEFINER functions: revoke EXECUTE from anon (keep authenticated for RLS)
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_family_user_ids(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.delete_parent_note(uuid) FROM anon, public, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_upcoming_parent_notes(uuid, integer) FROM anon, public, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_family_user_ids(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_parent_note(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_upcoming_parent_notes(uuid, integer) TO service_role;

-- 6. Fix mutable search_path on test_send_reminders
ALTER FUNCTION public.test_send_reminders(text) SET search_path = public;
REVOKE EXECUTE ON FUNCTION public.test_send_reminders(text) FROM anon, public, authenticated;
