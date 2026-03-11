
CREATE TABLE IF NOT EXISTS weekly_lunch_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  packed_lunch_days TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(child_id, week_start)
);

ALTER TABLE weekly_lunch_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Parents can manage their own lunch plans"
  ON weekly_lunch_plans
  FOR ALL
  USING (auth.uid() = parent_id)
  WITH CHECK (auth.uid() = parent_id);

CREATE POLICY "Service role full access to weekly_lunch_plans"
  ON weekly_lunch_plans
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS lunch_checkin_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(parent_id, week_start)
);

ALTER TABLE lunch_checkin_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to lunch_checkin_log"
  ON lunch_checkin_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
