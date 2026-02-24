
ALTER TABLE public.school_calendar_feeds
ADD COLUMN feed_type text NOT NULL DEFAULT 'ical';

COMMENT ON COLUMN public.school_calendar_feeds.feed_type IS 'ical or scrape';
