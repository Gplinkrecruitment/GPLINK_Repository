-- Per-interview override of the 48-hour booking notice rule.
--
-- Normally slots must start at least INTERVIEW_LEAD_HOURS (48) from now. That
-- is the right default, but it strands a real case: a practice offers times
-- that are genuinely still workable, the doctor is keen, and the only thing
-- standing in the way is our own notice rule. Before this column the ONLY
-- lever was to change the rule for everybody.
--
-- NULL (the default) means "use the standard 48 hours". A number overrides it
-- for this interview alone; 0 waives the notice period entirely. Slots in the
-- past are still excluded by computeInterviewSlots, so 0 means "any time from
-- now on", never "any time at all".
--
-- Read by interviewMeetings.interviewLeadHours(row) in _interviewComputeSlots.
alter table public.scheduled_calls
  add column if not exists min_notice_hours integer;

comment on column public.scheduled_calls.min_notice_hours is
  'Per-interview override of the 48h booking notice rule. NULL = use INTERVIEW_LEAD_HOURS (48); 0 = waive entirely. Slots in the past are still excluded.';
