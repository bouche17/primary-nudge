
-- Allow invitees to look up tokens by token value
CREATE POLICY "Anyone authenticated can read tokens by token value"
ON public.invite_tokens
FOR SELECT
TO authenticated
USING (true);

-- Drop the old restrictive select policy
DROP POLICY IF EXISTS "Users can view their own invite tokens" ON public.invite_tokens;

-- Allow invitees to mark tokens as used
CREATE POLICY "Authenticated users can mark tokens as used"
ON public.invite_tokens
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);
