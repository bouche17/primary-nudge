CREATE TABLE public.dedup_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  phone_number text,
  child_name text,
  tool text NOT NULL,
  item_date text,
  new_item text,
  decision text NOT NULL,
  matched_table text,
  matched_id text,
  matched_text text
);
GRANT ALL ON public.dedup_decisions TO service_role;
ALTER TABLE public.dedup_decisions ENABLE ROW LEVEL SECURITY;