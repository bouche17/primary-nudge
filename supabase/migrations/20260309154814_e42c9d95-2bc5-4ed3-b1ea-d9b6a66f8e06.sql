
-- Child-specific reminders
CREATE TABLE public.child_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id UUID NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
  parent_id UUID NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT DEFAULT '✅',
  day_of_week TEXT NOT NULL,
  reminder_time TEXT DEFAULT 'morning',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.child_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Parents can manage their own child reminders"
  ON public.child_reminders FOR ALL
  TO authenticated
  USING (auth.uid() = parent_id)
  WITH CHECK (auth.uid() = parent_id);

CREATE POLICY "Service role full access on child_reminders"
  ON public.child_reminders FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_child_reminders_child ON public.child_reminders(child_id);
CREATE INDEX idx_child_reminders_parent ON public.child_reminders(parent_id);

CREATE TRIGGER update_child_reminders_updated_at
  BEFORE UPDATE ON public.child_reminders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Onboarding state tracker
CREATE TABLE public.onboarding_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'new',
  current_child_index INTEGER DEFAULT 0,
  collected_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.onboarding_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on onboarding_state"
  ON public.onboarding_state FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_onboarding_state_phone ON public.onboarding_state(phone_number);

CREATE TRIGGER update_onboarding_state_updated_at
  BEFORE UPDATE ON public.onboarding_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
