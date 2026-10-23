-- Each new sign-up event wakes the signup-alerts function (no polling). The function waits for the sign-up to settle.
CREATE OR REPLACE FUNCTION public.wake_signup_alerts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  BEGIN
    PERFORM net.http_post(
      url := 'https://cfjcuhblioswylmtclzy.supabase.co/functions/v1/signup-alerts',
      body := jsonb_build_object('event_id', NEW.id),
      headers := jsonb_build_object('Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmamN1aGJsaW9zd3lsbXRjbHp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMzUxODQsImV4cCI6MjA4NjkxMTE4NH0.LZQiOvaHo9NBrr2tyDn9cTArdduACsmmrTKf4AOxDno')
    );
  EXCEPTION WHEN others THEN
    RAISE WARNING 'wake_signup_alerts failed: %', SQLERRM;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER wake_signup_alerts AFTER INSERT ON public.signup_events
FOR EACH ROW WHEN (NEW.processed_at IS NULL) EXECUTE FUNCTION public.wake_signup_alerts();
