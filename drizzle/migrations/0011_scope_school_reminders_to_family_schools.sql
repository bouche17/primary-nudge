DROP POLICY IF EXISTS "Signed-in users can read reminders" ON public.school_reminders;
CREATE POLICY "Parents read their family's school reminders" ON public.school_reminders
  FOR SELECT TO authenticated USING (public.can_read_school(auth.uid(), school_id));