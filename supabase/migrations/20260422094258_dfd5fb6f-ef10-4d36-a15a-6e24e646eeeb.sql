
-- Helper: returns the user_id plus any linked partner user_ids (accepted links, both directions)
CREATE OR REPLACE FUNCTION public.get_family_user_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id
  UNION
  SELECT linked_user_id FROM public.linked_accounts
    WHERE primary_user_id = _user_id AND status = 'accepted'
  UNION
  SELECT primary_user_id FROM public.linked_accounts
    WHERE linked_user_id = _user_id AND status = 'accepted'
$$;

-- ── children: family-wide access ─────────────────────────────────────────────
DROP POLICY IF EXISTS "Parents can view their own children" ON public.children;
DROP POLICY IF EXISTS "Parents can add their own children" ON public.children;
DROP POLICY IF EXISTS "Parents can update their own children" ON public.children;
DROP POLICY IF EXISTS "Parents can delete their own children" ON public.children;

CREATE POLICY "Family can view children"
  ON public.children FOR SELECT TO authenticated
  USING (parent_id IN (SELECT public.get_family_user_ids(auth.uid())));

CREATE POLICY "Family can add children"
  ON public.children FOR INSERT TO authenticated
  WITH CHECK (parent_id IN (SELECT public.get_family_user_ids(auth.uid())));

CREATE POLICY "Family can update children"
  ON public.children FOR UPDATE TO authenticated
  USING (parent_id IN (SELECT public.get_family_user_ids(auth.uid())));

CREATE POLICY "Family can delete children"
  ON public.children FOR DELETE TO authenticated
  USING (parent_id IN (SELECT public.get_family_user_ids(auth.uid())));

-- ── child_reminders: family-wide access ─────────────────────────────────────
DROP POLICY IF EXISTS "Parents can manage their own child reminders" ON public.child_reminders;

CREATE POLICY "Family can manage child reminders"
  ON public.child_reminders FOR ALL TO authenticated
  USING (parent_id IN (SELECT public.get_family_user_ids(auth.uid())))
  WITH CHECK (parent_id IN (SELECT public.get_family_user_ids(auth.uid())));

-- ── weekly_lunch_plans: family-wide access ──────────────────────────────────
DROP POLICY IF EXISTS "Parents can manage their own lunch plans" ON public.weekly_lunch_plans;

CREATE POLICY "Family can manage lunch plans"
  ON public.weekly_lunch_plans FOR ALL TO authenticated
  USING (parent_id IN (SELECT public.get_family_user_ids(auth.uid())))
  WITH CHECK (parent_id IN (SELECT public.get_family_user_ids(auth.uid())));
