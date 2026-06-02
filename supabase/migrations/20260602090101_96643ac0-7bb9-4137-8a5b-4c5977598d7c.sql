UPDATE public.child_reminders
SET title = 'Swimming kit', updated_at = now()
WHERE lower(trim(title)) = 'swimming kit needed';
