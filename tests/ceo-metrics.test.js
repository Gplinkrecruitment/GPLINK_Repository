import { describe, it, expect } from 'vitest';
import * as M from '../lib/ceo-metrics.js';

// ── Shared fixture ──────────────────────────────────────────────
// nowMs fixed; todayStr derived from it. All ISO dates are relative.
const NOW = Date.UTC(2026, 5, 14, 12, 0, 0); // 2026-06-14T12:00:00Z
const TODAY = '2026-06-14';
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const ahead = (days) => new Date(NOW + days * DAY).toISOString();

function makeFixture() {
  // cases: mix of stages, blocked, withdrawn, stale(>6mo), fresh
  const cases = [
    // c1 active, myintealth, fresh
    { id: 'c1', user_id: 'u1', stage: 'myintealth', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(2), updated_at: ago(2), created_at: ago(40) },
    // c2 active, amc, 10 days stale (inactive 7-14)
    { id: 'c2', user_id: 'u2', stage: 'amc', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(10), updated_at: ago(10), created_at: ago(60) },
    // c3 active, career, 20 days stale (cold 14d+), blocked
    { id: 'c3', user_id: 'u3', stage: 'career', status: 'blocked', blocker_status: 'waiting_on_gp', blocker_reason: 'docs', blocker_set_at: ago(12), assigned_va: 'rsoB', assigned_rso: 'rsoB', last_gp_activity_at: ago(20), updated_at: ago(20), created_at: ago(90) },
    // c4 active, ahpra, fresh, blocker via status only (no blocker_set_at)
    { id: 'c4', user_id: 'u4', stage: 'ahpra', status: 'blocked', blocker_status: 'waiting_on_external', blocker_set_at: null, assigned_va: null, assigned_rso: null, last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(120) },
    // c5 active, pbs, 5 days stale
    { id: 'c5', user_id: 'u5', stage: 'pbs', status: 'active', assigned_va: 'rsoB', assigned_rso: 'rsoB', last_gp_activity_at: ago(5), updated_at: ago(5), created_at: ago(150) },
    // c6 active, visa (deferred -> pbs index), fresh
    { id: 'c6', user_id: 'u6', stage: 'visa', status: 'active', assigned_va: 'rsoA', assigned_rso: 'rsoA', last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(100) },
    // c7 complete, completed 3 days ago (this month)
    { id: 'c7', user_id: 'u7', stage: 'complete', status: 'active', completed_at: ago(3), assigned_rso: 'rsoA', last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(200) },
    // c8 complete, completed 200 days ago (>6mo) — must still count toward all-time total
    { id: 'c8', user_id: 'u8', stage: 'complete', status: 'active', completed_at: ago(200), assigned_rso: 'rsoB', last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(400) },
    // c9 withdrawn — excluded everywhere
    { id: 'c9', user_id: 'u9', stage: 'amc', status: 'withdrawn', assigned_rso: 'rsoA', last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(30) },
    // c10 active but >6mo stale — excluded unless allTime
    { id: 'c10', user_id: 'u10', stage: 'myintealth', status: 'active', assigned_rso: null, last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(300) },
    // c11 active, commencement, fresh
    { id: 'c11', user_id: 'u11', stage: 'commencement', status: 'active', assigned_rso: 'rsoB', last_gp_activity_at: ago(0), updated_at: ago(0), created_at: ago(80) }
  ];
  const tasks = [
    { id: 't1', case_id: 'c1', status: 'open', assignee: 'rsoA', due_date: ahead(5), created_at: ago(2), completed_at: null },
    { id: 't2', case_id: 'c1', status: 'in_progress', assignee: 'rsoA', due_date: ago(1), created_at: ago(10), completed_at: null }, // overdue
    { id: 't3', case_id: 'c2', status: 'escalated', assignee: 'rsoA', due_date: ago(2), created_at: ago(8), completed_at: null }, // overdue + escalated (counts)
    { id: 't4', case_id: 'c3', status: 'waiting_on_gp', assignee: 'rsoB', due_date: TODAY, created_at: ago(6), completed_at: null }, // due TODAY -> NOT overdue
    { id: 't5', case_id: 'c5', status: 'open', assignee: 'rsoB', due_date: null, created_at: ago(1), completed_at: null },
    { id: 't6', case_id: 'c9', status: 'open', assignee: 'rsoA', due_date: ago(3), created_at: ago(4), completed_at: null }, // withdrawn case -> excluded
    { id: 't7', case_id: 'c10', status: 'open', assignee: null, due_date: ago(3), created_at: ago(3), completed_at: null }, // stale case -> excluded
    { id: 't8', case_id: 'c4', status: 'cancelled', assignee: null, due_date: ago(2), created_at: ago(9), completed_at: null } // cancelled -> not open/overdue
  ];
  // completed tasks sample (separate query in prod) for task-health avg/this-week
  const completedSample = [
    { id: 'ct1', case_id: 'c1', status: 'completed', created_at: ago(9), completed_at: ago(2) },  // 7d resolve, this week
    { id: 'ct2', case_id: 'c2', status: 'completed', created_at: ago(20), completed_at: ago(11) }  // 9d resolve, not this week
  ];
  const apps = [
    { id: 'a1', user_id: 'u1', status: 'applied', applied_at: ago(3), updated_at: ago(3), practice_submission_status: 'pending_va_submission' },
    { id: 'a2', user_id: 'u2', status: 'submitted', applied_at: ago(40), updated_at: ago(5), practice_submission_status: 'submitted' }, // submitted_to_practice
    { id: 'a3', user_id: 'u3', status: 'interview_scheduled', applied_at: ago(50), updated_at: ago(6), practice_submission_status: 'submitted' }, // interviewing (status)
    { id: 'a4', user_id: 'u5', status: 'offer', applied_at: ago(60), updated_at: ago(2), practice_submission_status: 'submitted' }, // offer
    { id: 'a5', user_id: 'u6', status: 'placed', applied_at: ago(90), updated_at: ago(1), practice_submission_status: 'submitted' }, // secured (placed!)
    { id: 'a6', user_id: 'u11', status: 'contract_signed', applied_at: ago(100), updated_at: ago(0), practice_submission_status: 'submitted' }, // secured
    { id: 'a7', user_id: 'u9', status: 'applied', applied_at: ago(1), updated_at: ago(1), practice_submission_status: 'pending_va_submission' }, // withdrawn-case GP -> excluded by activeUserIds
    { id: 'a8', user_id: 'u6', status: 'placement_secured', applied_at: ago(200), updated_at: ago(200), practice_submission_status: 'submitted' } // 2nd secured app for u6 -> dedupe by user
  ];
  // career_interviews link by application_id
  const careerInterviews = [
    { id: 'iv1', application_id: 'a3', status: 'scheduled', scheduled_at: ahead(2) }
  ];
  const careerRoles = [
    { id: 'r1', practice_name: 'Practice One', is_active: true },
    { id: 'r2', practice_name: 'Practice Two', is_active: false }
  ];
  const tickets = [
    { id: 'tk1', user_id: 'u1', status: 'open', created_at: ago(3), first_reply_at: ago(2.5), resolved_at: null },
    { id: 'tk2', user_id: 'u2', status: 'closed', created_at: ago(10), first_reply_at: ago(9), resolved_at: ago(2) }, // resolved this week
    { id: 'tk3', user_id: 'u3', status: 'closed', created_at: ago(40), first_reply_at: null, resolved_at: ago(30) }, // resolved, null first_reply (excluded from reply avg)
    { id: 'tk4', user_id: 'u9', status: 'open', created_at: ago(1), first_reply_at: null, resolved_at: null } // withdrawn GP -> excluded if scoping on
  ];
  // stage_change timeline events (global)
  const stageEvents = [
    { case_id: 'c1', created_at: ago(2), title: 'Stage advanced to amc', metadata: { from_stage: 'myintealth', to_stage: 'amc' } },
    { case_id: 'c3', created_at: ago(1), title: 'Stage advanced to career', metadata: { from_stage: 'amc', to_stage: 'career' } },
    { case_id: 'c7', created_at: ago(3), title: 'Stage advanced to complete', metadata: { from_stage: 'commencement', to_stage: 'complete' } },
    { case_id: 'c2', created_at: ago(8), title: 'Stage advanced to ahpra', metadata: { from_stage: 'career', to_stage: 'ahpra' } }
  ];
  return { cases, tasks, completedSample, apps, careerInterviews, careerRoles, tickets, stageEvents };
}

describe('ceo-metrics constants + status helpers', () => {
  it('exports the exact status-set constants', () => {
    expect(M.OPEN_TASK_STATUSES).toEqual(['open','in_progress','waiting','waiting_on_gp','waiting_on_practice','waiting_on_external','escalated']);
    expect(M.OVERDUE_EXCLUDED_STATUSES).toEqual(['completed','cancelled']);
    expect(M.SIX_MONTHS_MS).toBe(1000*60*60*24*182);
  });
  it('FUNNEL_STAGES is ordered by true DB progression (#28)', () => {
    expect(M.FUNNEL_STAGES.map(s => s.key)).toEqual(['myintealth','amc','career','ahpra','pbs','commencement']);
    expect(M.FUNNEL_STAGES.find(s => s.key === 'career').label).toBe('Secure Placement');
  });
  it('DB_STAGE_ORDER puts visa at the pbs index (deferred) (#56)', () => {
    expect(M.DB_STAGE_ORDER.pbs).toBe(4);
    expect(M.DB_STAGE_ORDER.visa).toBe(4);
    expect(M.DB_STAGE_ORDER.complete).toBe(6);
  });
  it('isSecuredStatus treats placed as secured (#8); offer/interview helpers single-source (#61)', () => {
    expect(M.isSecuredStatus('placed')).toBe(true);
    expect(M.isSecuredStatus('hired')).toBe(true);
    expect(M.isSecuredStatus('Contract Signed')).toBe(true);
    expect(M.isSecuredStatus('applied')).toBe(false);
    expect(M.isInterviewStatus('interview_scheduled')).toBe(true);
    expect(M.isInterviewStatus('offer')).toBe(false);
    expect(M.isOfferStatus('offer')).toBe(true);
    expect(M.isOfferStatus('offered')).toBe(true);
    expect(M.isOfferStatus('placed')).toBe(false);
  });
});

export { makeFixture, NOW, TODAY, DAY, ago, ahead };
