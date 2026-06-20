-- Link a scheduled Zoom call back to the originating task it was booked from
-- (an email_triage or whatsapp_help task where the GP asked for help), so the
-- call and the GP's original request stay connected in the UI and for reporting.
-- Distinct from registration_task_id, which points to the persistent zoom_call task.
ALTER TABLE public.scheduled_calls
  ADD COLUMN IF NOT EXISTS origin_task_id uuid REFERENCES public.registration_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_calls_origin_task_id
  ON public.scheduled_calls(origin_task_id);
