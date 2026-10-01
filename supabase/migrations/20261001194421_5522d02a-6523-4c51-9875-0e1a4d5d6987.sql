CREATE TABLE public.test_runner_tokens (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.test_runner_tokens TO service_role;
ALTER TABLE public.test_runner_tokens ENABLE ROW LEVEL SECURITY;