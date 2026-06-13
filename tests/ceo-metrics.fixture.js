// Shared CEO-metrics fixture for endpoint-parity reconciliation tests (Task 3.2).
// Standalone (no cross-import) representative dataset matching the rows the lib expects:
//   - >=1 case per funnel stage incl. one `visa` (folds into pbs) and `commencement`
//   - one withdrawn case, one >6mo stale case
//   - >=1 blocked case carrying blocker_set_at (and one blocked via status only)
//   - apps spanning every placement status incl. `placed`, plus a 2nd secured app for one
//     GP (dedupe) and one app from a withdrawn-case GP (active-scope drop)
//   - >=1 ticket from a withdrawn-case GP
//   - completed cases older + within this month
// Mirrors makeFixture() in tests/ceo-metrics.test.js so both reconcile to the same numbers.

const NOW = Date.UTC(2026, 5, 14, 12, 0, 0); // 2026-06-14T12:00:00Z
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const ahead = (days) => new Date(NOW + days * DAY).toISOString();
const TODAY = '2026-06-14';

const cases = [
  { id: 'c1', user_id: 'u1', stage: 'myintealth', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(2), updated_at: ago(2), created_at: ago(40) },
  { id: 'c2', user_id: 'u2', stage: 'amc', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(10), updated_at: ago(10), created_at: ago(60) },
  { id: 'c3', user_id: 'u3', stage: 'career', status: 'blocked', blocker_status: 'waiting_on_gp', blocker_reason: 'docs', blocker_set_at: ago(12), assigned_va: 'rsoB', assigned_rso: 'rsoB', last_gp_activity_at: ago(20), updated_at: ago(20), created_at: ago(90) },
  { id: 'c4', user_id: 'u4', stage: 'ahpra', status: 'blocked', blocker_status: 'waiting_on_external', blocker_set_at: null, assigned_va: null, assigned_rso: null, last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(120) },
  { id: 'c5', user_id: 'u5', stage: 'pbs', status: 'active', assigned_va: 'rsoB', assigned_rso: 'rsoB', last_gp_activity_at: ago(5), updated_at: ago(5), created_at: ago(150) },
  { id: 'c6', user_id: 'u6', stage: 'visa', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(100) },
  { id: 'c7', user_id: 'u7', stage: 'complete', status: 'active', completed_at: ago(3), assigned_rso: 'rsoA', last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(200) },
  { id: 'c8', user_id: 'u8', stage: 'complete', status: 'active', completed_at: ago(200), assigned_rso: 'rsoB', last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(400) },
  { id: 'c9', user_id: 'u9', stage: 'amc', status: 'withdrawn', assigned_rso: 'rsoA', last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(30) },
  { id: 'c10', user_id: 'u10', stage: 'myintealth', status: 'active', assigned_rso: null, last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(300) },
  { id: 'c11', user_id: 'u11', stage: 'commencement', status: 'active', assigned_rso: 'rsoB', last_gp_activity_at: ago(0), updated_at: ago(0), created_at: ago(80) }
];
const tasks = [
  { id: 't1', case_id: 'c1', status: 'open', assignee: 'rsoA', due_date: ahead(5), created_at: ago(2), completed_at: null },
  { id: 't2', case_id: 'c1', status: 'in_progress', assignee: 'rsoA', due_date: ago(1), created_at: ago(10), completed_at: null },
  { id: 't3', case_id: 'c2', status: 'escalated', assignee: 'rsoA', due_date: ago(2), created_at: ago(8), completed_at: null },
  { id: 't4', case_id: 'c3', status: 'waiting_on_gp', assignee: 'rsoB', due_date: TODAY, created_at: ago(6), completed_at: null },
  { id: 't5', case_id: 'c5', status: 'open', assignee: 'rsoB', due_date: null, created_at: ago(1), completed_at: null },
  { id: 't6', case_id: 'c9', status: 'open', assignee: 'rsoA', due_date: ago(3), created_at: ago(4), completed_at: null },
  { id: 't7', case_id: 'c10', status: 'open', assignee: null, due_date: ago(3), created_at: ago(3), completed_at: null },
  { id: 't8', case_id: 'c4', status: 'cancelled', assignee: null, due_date: ago(2), created_at: ago(9), completed_at: null }
];
const completedTasks = [
  { id: 'ct1', case_id: 'c1', status: 'completed', created_at: ago(9), completed_at: ago(2) },
  { id: 'ct2', case_id: 'c2', status: 'completed', created_at: ago(20), completed_at: ago(11) }
];
const apps = [
  { id: 'a1', user_id: 'u1', status: 'applied', applied_at: ago(3), updated_at: ago(3), practice_submission_status: 'pending_va_submission' },
  { id: 'a2', user_id: 'u2', status: 'submitted', applied_at: ago(40), updated_at: ago(5), practice_submission_status: 'submitted' },
  { id: 'a3', user_id: 'u3', status: 'interview_scheduled', applied_at: ago(50), updated_at: ago(6), practice_submission_status: 'submitted' },
  { id: 'a4', user_id: 'u5', status: 'offer', applied_at: ago(60), updated_at: ago(2), practice_submission_status: 'submitted' },
  { id: 'a5', user_id: 'u6', status: 'placed', applied_at: ago(90), updated_at: ago(1), practice_submission_status: 'submitted' },
  { id: 'a6', user_id: 'u11', status: 'contract_signed', applied_at: ago(100), updated_at: ago(0), practice_submission_status: 'submitted' },
  { id: 'a7', user_id: 'u9', status: 'applied', applied_at: ago(1), updated_at: ago(1), practice_submission_status: 'pending_va_submission' },
  { id: 'a8', user_id: 'u6', status: 'placement_secured', applied_at: ago(200), updated_at: ago(200), practice_submission_status: 'submitted' }
];
const careerInterviews = [
  { id: 'iv1', application_id: 'a3', status: 'scheduled', scheduled_at: ahead(2) }
];
const careerRoles = [
  { id: 'r1', practice_name: 'Practice One', is_active: true },
  { id: 'r2', practice_name: 'Practice Two', is_active: false }
];
const tickets = [
  { id: 'tk1', user_id: 'u1', status: 'open', created_at: ago(3), first_reply_at: ago(2.5), resolved_at: null },
  { id: 'tk2', user_id: 'u2', status: 'closed', created_at: ago(10), first_reply_at: ago(9), resolved_at: ago(2) },
  { id: 'tk3', user_id: 'u3', status: 'closed', created_at: ago(40), first_reply_at: null, resolved_at: ago(30) },
  { id: 'tk4', user_id: 'u9', status: 'open', created_at: ago(1), first_reply_at: null, resolved_at: null }
];
const stageEvents = [
  { case_id: 'c1', created_at: ago(2), title: 'Stage advanced to amc', metadata: { from_stage: 'myintealth', to_stage: 'amc' } },
  { case_id: 'c3', created_at: ago(1), title: 'Stage advanced to career', metadata: { from_stage: 'amc', to_stage: 'career' } },
  { case_id: 'c7', created_at: ago(3), title: 'Stage advanced to complete', metadata: { from_stage: 'commencement', to_stage: 'complete' } },
  { case_id: 'c2', created_at: ago(8), title: 'Stage advanced to ahpra', metadata: { from_stage: 'career', to_stage: 'ahpra' } }
];

// Two-RSO roster keyed to the cases' assigned_rso values so computeRsoWorkload
// seeds both named buckets; c4 (assigned_rso null) drives the __unassigned__ bucket.
const rsoRoster = [
  { rso_id: 'rsoA', rso_name: 'RSO Alpha' },
  { rso_id: 'rsoB', rso_name: 'RSO Beta' }
];

export const FIXTURE = {
  nowMs: NOW,
  todayStr: TODAY,
  cases,
  tasks,
  completedTasks,
  apps,
  careerInterviews,
  careerRoles,
  tickets,
  stageEvents,
  rsoRoster
};
