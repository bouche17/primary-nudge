
-- Table to store school calendar feed URLs
CREATE TABLE public.school_calendar_feeds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  feed_url TEXT NOT NULL,
  label TEXT DEFAULT 'School Calendar',
  last_synced_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.school_calendar_feeds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage calendar feeds"
  ON public.school_calendar_feeds
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

-- Table to store parsed events from feeds
CREATE TABLE public.school_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  feed_id UUID REFERENCES public.school_calendar_feeds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_at TIMESTAMP WITH TIME ZONE NOT NULL,
  end_at TIMESTAMP WITH TIME ZONE,
  all_day BOOLEAN DEFAULT false,
  uid TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.school_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read events"
  ON public.school_events
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admins can manage events"
  ON public.school_events
  FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role full access on school_events"
  ON public.school_events
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on school_calendar_feeds"
  ON public.school_calendar_feeds
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Indexes
CREATE INDEX idx_school_events_school_start ON public.school_events(school_id, start_at);
CREATE UNIQUE INDEX idx_school_events_uid_feed ON public.school_events(feed_id, uid) WHERE uid IS NOT NULL;
