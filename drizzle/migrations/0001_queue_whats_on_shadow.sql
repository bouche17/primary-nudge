CREATE OR REPLACE FUNCTION public.queue_whats_on_shadow()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  tok text;
  req bigint;
BEGIN
  -- Clock-safe: scheduled at 20:00 and 21:00 UTC, only runs when it is 21:00 in the UK.
  IF extract(hour from (now() AT TIME ZONE 'Europe/London')) <> 21 THEN
    RETURN NULL;
  END IF;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.test_runner_tokens(token_hash, expires_at)
  VALUES (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), now() + interval '15 minutes');
  SELECT net.http_post(
    url := 'https://cfjcuhblioswylmtclzy.supabase.co/functions/v1/monty-test-runner',
    body := '{"action":"whats_on_shadow","scheduled":true}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-runner-token', tok,
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmamN1aGJsaW9zd3lsbXRjbHp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMzUxODQsImV4cCI6MjA4NjkxMTE4NH0.LZQiOvaHo9NBrr2tyDn9cTArdduACsmmrTKf4AOxDno'),
    timeout_milliseconds := 300000
  ) INTO req;
  RETURN req;
END $function$;
REVOKE ALL ON FUNCTION public.queue_whats_on_shadow() FROM PUBLIC, anon, authenticated;