CREATE TABLE public.scheduled_send_runs (
  job text NOT NULL CHECK (job IN ('morning','evening','sunday_checkin')),
  slot_date date NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  request_ids bigint[] NOT NULL DEFAULT '{}',
  last_called_at timestamptz,
  completed_at timestamptz,
  last_status integer,
  last_reason text,
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, slot_date, is_test)
);
GRANT SELECT ON public.scheduled_send_runs TO authenticated;
GRANT ALL ON public.scheduled_send_runs TO service_role;
ALTER TABLE public.scheduled_send_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read scheduled send runs" ON public.scheduled_send_runs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Short reason from a pg_net response ("HTTP 503 BOOT_ERROR", "timed out", ...).
CREATE OR REPLACE FUNCTION public.scheduled_send_reason(_status integer, _content text, _timed_out boolean, _error text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE code text;
BEGIN
  IF coalesce(_timed_out, false) THEN RETURN 'timed out'; END IF;
  IF _status IS NULL THEN RETURN left(coalesce(_error, 'no reply'), 80); END IF;
  BEGIN
    code := coalesce(_content::jsonb ->> 'code', _content::jsonb ->> 'error');
  EXCEPTION WHEN others THEN code := NULL;
  END;
  RETURN 'HTTP ' || _status || coalesce(' ' || left(code, 40), '');
END $$;

-- Calls one scheduled sender. _probe adds dry_run=probe, which the senders refuse (401, audited) — used to check the path without sending.
CREATE OR REPLACE FUNCTION public.scheduled_send_fire(_job text, _probe boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE _url text; _req bigint;
  _anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmamN1aGJsaW9zd3lsbXRjbHp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMzUxODQsImV4cCI6MjA4NjkxMTE4NH0.LZQiOvaHo9NBrr2tyDn9cTArdduACsmmrTKf4AOxDno';
BEGIN
  _url := 'https://cfjcuhblioswylmtclzy.supabase.co/functions/v1/' || CASE _job
    WHEN 'morning' THEN 'send-reminders?period=morning'
    WHEN 'evening' THEN 'send-reminders?period=evening'
    WHEN 'sunday_checkin' THEN 'sunday-lunch-checkin' END;
  IF _url IS NULL THEN RAISE EXCEPTION 'unknown job %', _job; END IF;
  IF _probe THEN _url := _url || CASE WHEN position('?' IN _url) > 0 THEN '&' ELSE '?' END || 'dry_run=probe'; END IF;
  SELECT net.http_post(
    url := _url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || _anon, 'apikey', _anon),
    timeout_milliseconds := 300000
  ) INTO _req;
  RETURN _req;
END $$;

-- The one scheduler for morning (07:00 UK), evening (18:00 UK) and Sunday check-in (Sun 18:00 UK) runs.
-- Ticked at :00, :05, :15, :25 of both possible UTC hours; works from UK local time, so it's right in GMT and BST.
-- Attempt 1 at +0; retry at +5 and +15 unless a call has returned 2xx; one alert at +25 if all 3 failed.
-- _test: only is_test rows, never calls anything, outcomes come from scheduled_send_record_test(); returns the actions.
CREATE OR REPLACE FUNCTION public.scheduled_send_tick(_now timestamptz DEFAULT now(), _test boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  uk_date date := (_now AT TIME ZONE 'Europe/London')::date;
  j record; r public.scheduled_send_runs%ROWTYPE; resp record;
  slot_start timestamptz; mins numeric; reason text; msg text; req bigint; alert_id uuid; tok text;
  actions jsonb := '[]'::jsonb;
BEGIN
  FOR j IN SELECT * FROM (VALUES
      ('morning', time '07:00', -1, 'morning reminders'),
      ('evening', time '18:00', -1, 'evening reminders'),
      ('sunday_checkin', time '18:00', 0, 'Sunday check-in')) AS v(job, at, dow, label) LOOP
    IF j.dow >= 0 AND extract(dow FROM uk_date) <> j.dow THEN CONTINUE; END IF;
    slot_start := (uk_date + j.at) AT TIME ZONE 'Europe/London';
    mins := extract(epoch FROM (_now - slot_start)) / 60.0;
    IF mins < -1 OR mins > 45 THEN CONTINUE; END IF;

    INSERT INTO public.scheduled_send_runs(job, slot_date, is_test) VALUES (j.job, uk_date, _test) ON CONFLICT DO NOTHING;
    SELECT * INTO r FROM public.scheduled_send_runs WHERE job = j.job AND slot_date = uk_date AND is_test = _test FOR UPDATE;

    -- Real runs: read what the earlier calls returned.
    IF NOT _test AND r.completed_at IS NULL AND cardinality(r.request_ids) > 0 THEN
      SELECT * INTO resp FROM net._http_response WHERE id = ANY(r.request_ids) AND status_code BETWEEN 200 AND 299 ORDER BY created LIMIT 1;
      IF FOUND THEN
        UPDATE public.scheduled_send_runs SET completed_at = resp.created, last_status = resp.status_code, last_reason = NULL
          WHERE job = j.job AND slot_date = uk_date AND is_test = _test RETURNING * INTO r;
      ELSE
        SELECT * INTO resp FROM net._http_response WHERE id = r.request_ids[cardinality(r.request_ids)];
        IF FOUND THEN
          reason := public.scheduled_send_reason(resp.status_code, resp.content, resp.timed_out, resp.error_msg);
          UPDATE public.scheduled_send_runs SET last_status = resp.status_code, last_reason = reason
            WHERE job = j.job AND slot_date = uk_date AND is_test = _test RETURNING * INTO r;
        ELSE
          UPDATE public.scheduled_send_runs SET last_reason = 'no reply after ' || greatest(1, floor(extract(epoch FROM (_now - r.last_called_at)) / 60))::int || ' min'
            WHERE job = j.job AND slot_date = uk_date AND is_test = _test RETURNING * INTO r;
        END IF;
      END IF;
    END IF;

    IF r.completed_at IS NOT NULL THEN CONTINUE; END IF;

    IF (r.attempts = 0 OR (r.attempts = 1 AND mins >= 4) OR (r.attempts = 2 AND mins >= 14))
       AND (r.last_called_at IS NULL OR _now - r.last_called_at >= interval '3 minutes') THEN
      req := NULL;
      IF NOT _test THEN req := public.scheduled_send_fire(j.job); END IF;
      UPDATE public.scheduled_send_runs
        SET attempts = attempts + 1, last_called_at = _now,
            request_ids = CASE WHEN req IS NULL THEN request_ids ELSE request_ids || req END
        WHERE job = j.job AND slot_date = uk_date AND is_test = _test;
      actions := actions || jsonb_build_object('job', j.job, 'slot_date', uk_date, 'action', 'call', 'attempt', r.attempts + 1);
    ELSIF r.attempts >= 3 AND mins >= 24 AND r.alerted_at IS NULL THEN
      reason := coalesce(r.last_reason, 'no reply');
      msg := format('Monty: %s failed to send (%s). Retried twice.', j.label, reason);
      INSERT INTO public.ops_alerts(alert_type, affected_parents, failure_count, first_error, likely_fix, message, is_test, delivered, channel, created_at)
      VALUES ('scheduled_send_failed', 0, r.attempts, reason,
        'Nobody was sent anything for this slot. Check the function logs, then re-run it by hand (already-sent families are skipped)',
        msg, _test, false, 'email_pending', _now)
      RETURNING id INTO alert_id;
      UPDATE public.scheduled_send_runs SET alerted_at = _now WHERE job = j.job AND slot_date = uk_date AND is_test = _test;
      IF NOT _test THEN
        tok := encode(extensions.gen_random_bytes(32), 'hex');
        INSERT INTO public.test_runner_tokens(token_hash, expires_at)
        VALUES (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), now() + interval '15 minutes');
        PERFORM net.http_post(
          url := 'https://cfjcuhblioswylmtclzy.supabase.co/functions/v1/monty-test-runner',
          body := jsonb_build_object('action', 'deliver_alert', 'alert_id', alert_id),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-runner-token', tok,
            'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmamN1aGJsaW9zd3lsbXRjbHp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzMzUxODQsImV4cCI6MjA4NjkxMTE4NH0.LZQiOvaHo9NBrr2tyDn9cTArdduACsmmrTKf4AOxDno'),
          timeout_milliseconds := 60000);
      END IF;
      actions := actions || jsonb_build_object('job', j.job, 'slot_date', uk_date, 'action', 'alert', 'message', msg);
    END IF;
  END LOOP;
  RETURN actions;
END $$;

-- Tests only: record the outcome of a simulated attempt (is_test rows only).
CREATE OR REPLACE FUNCTION public.scheduled_send_record_test(_job text, _slot_date date, _ok boolean, _reason text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.scheduled_send_runs
     SET completed_at = CASE WHEN _ok THEN now() ELSE completed_at END,
         last_reason = CASE WHEN _ok THEN NULL ELSE _reason END
   WHERE job = _job AND slot_date = _slot_date AND is_test;
$$;

REVOKE EXECUTE ON FUNCTION public.scheduled_send_fire(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.scheduled_send_tick(timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.scheduled_send_record_test(text, date, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_send_fire(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduled_send_tick(timestamptz, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.scheduled_send_record_test(text, date, boolean, text) TO service_role;