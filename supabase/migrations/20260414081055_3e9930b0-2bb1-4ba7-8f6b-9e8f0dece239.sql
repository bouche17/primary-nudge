
-- Allow invited users to also insert linked_accounts (as linked_user_id)
CREATE POLICY "Linked users can insert accepted links"
ON public.linked_accounts
FOR INSERT
TO public
WITH CHECK (auth.uid() = linked_user_id);
