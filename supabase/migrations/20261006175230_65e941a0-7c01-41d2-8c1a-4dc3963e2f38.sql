ALTER TABLE public.failed_inbound
  ADD COLUMN IF NOT EXISTS status_code integer,
  ADD COLUMN IF NOT EXISTS error_body text,
  ADD COLUMN IF NOT EXISTS step text,
  ADD COLUMN IF NOT EXISTS elapsed_ms integer,
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE OR REPLACE FUNCTION public.queue_suite_chunk(_body jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  tok text := encode(extensions.gen_random_bytes(32), 'hex');
  req bigint;
BEGIN
  INSERT INTO public.test_runner_tokens(token_hash, expires_at)
  VALUES (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), now() + interval '15 minutes');
  SELECT net.http_post(
    url := 'https://cfjcuhblioswylmtclzy.supabase.co/functions/v1/monty-test-runner',
    body := _body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-runner-token', tok,
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmamN1aGJsaW9zd3lsbXRjbHp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMzUxODQsImV4cCI6MjA4NjkxMTE4NH0.LZQiOvaHo9NBrr2tyDn9cTArdduACsmmrTKf4AOxDno'),
    timeout_milliseconds := 180000
  ) INTO req;
  RETURN req;
END $$;
REVOKE ALL ON FUNCTION public.queue_suite_chunk(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_suite_chunk(jsonb) TO service_role;