
DROP POLICY IF EXISTS "Authenticated users can mark tokens as used" ON public.invite_tokens;

CREATE POLICY "Authenticated users can mark unused tokens as used"
ON public.invite_tokens
FOR UPDATE
TO authenticated
USING (used_at IS NULL)
WITH CHECK (used_at IS NOT NULL);
