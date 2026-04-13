
-- Fix profiles: remove overly broad SELECT policy, keep owner-scoped one
DROP POLICY IF EXISTS "Service role can read all profiles" ON public.profiles;

-- Fix parent_notes: restrict to service_role only
DROP POLICY IF EXISTS "Service role full access on parent_notes" ON public.parent_notes;
CREATE POLICY "Service role full access on parent_notes"
  ON public.parent_notes FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fix conversations: restrict to service_role only
DROP POLICY IF EXISTS "Service role full access on conversations" ON public.conversations;
CREATE POLICY "Service role full access on conversations"
  ON public.conversations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fix messages: restrict to service_role only
DROP POLICY IF EXISTS "Service role full access on messages" ON public.messages;
CREATE POLICY "Service role full access on messages"
  ON public.messages FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fix reminder_log: restrict to service_role only
DROP POLICY IF EXISTS "Service role full access on reminder_log" ON public.reminder_log;
CREATE POLICY "Service role full access on reminder_log"
  ON public.reminder_log FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fix school_calendar_feeds: restrict service role policy to service_role only
DROP POLICY IF EXISTS "Service role full access on school_calendar_feeds" ON public.school_calendar_feeds;
CREATE POLICY "Service role full access on school_calendar_feeds"
  ON public.school_calendar_feeds FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fix school_events: restrict service role policy to service_role only
DROP POLICY IF EXISTS "Service role full access on school_events" ON public.school_events;
CREATE POLICY "Service role full access on school_events"
  ON public.school_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
