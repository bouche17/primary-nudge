
CREATE TABLE public.school_reminders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  day_of_week TEXT,
  due_date DATE,
  emoji TEXT DEFAULT '✅',
  active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.school_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage school reminders"
  ON public.school_reminders FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Anyone can read reminders"
  ON public.school_reminders FOR SELECT
  USING (true);

CREATE TRIGGER update_school_reminders_updated_at
  BEFORE UPDATE ON public.school_reminders
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.school_reminders (title, day_of_week, emoji, sort_order) VALUES
  ('PE kit needed', 'Wednesday', '🏃', 1),
  ('Dinner money due', 'Friday', '💰', 2),
  ('Reading books returned', 'Monday', '📚', 3);
