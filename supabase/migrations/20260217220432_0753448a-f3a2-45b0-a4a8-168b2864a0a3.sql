
-- Create conversations table
CREATE TABLE public.conversations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL,
  current_step TEXT NOT NULL DEFAULT 'welcome',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create messages table
CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create bot_flows table
CREATE TABLE public.bot_flows (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  step_name TEXT NOT NULL UNIQUE,
  message_template TEXT NOT NULL,
  options JSONB DEFAULT '[]'::jsonb,
  next_step TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_flows ENABLE ROW LEVEL SECURITY;

-- Service role policies (edge functions use service role key)
CREATE POLICY "Service role full access on conversations"
  ON public.conversations FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on messages"
  ON public.messages FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on bot_flows"
  ON public.bot_flows FOR ALL
  USING (true) WITH CHECK (true);

-- Index for fast phone number lookups
CREATE INDEX idx_conversations_phone ON public.conversations(phone_number);

-- Index for conversation message history
CREATE INDEX idx_messages_conversation ON public.messages(conversation_id, created_at);

-- Index for bot flow step lookups
CREATE INDEX idx_bot_flows_step ON public.bot_flows(step_name);

-- Trigger to update updated_at on conversations
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
