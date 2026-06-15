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

describe('shared filters + helpers', () => {
  const fx = makeFixture();

  it('filterActiveCases drops withdrawn + >6mo stale by default (#15/#52)', () => {
    const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
    const ids = active.map(c => c.id).sort();
    // c9 withdrawn out; c8 & c10 stale(200d) out; everything else in (ids are .sort()ed)
    expect(ids).toEqual(['c1','c11','c2','c3','c4','c5','c6','c7']);
  });
  it('filterActiveCases allTime keeps stale but still drops withdrawn (#52)', () => {
    const active = M.filterActiveCases(fx.cases, { nowMs: NOW, allTime: true });
    const ids = active.map(c => c.id).sort();
    expect(ids).toEqual(['c1','c10','c11','c2','c3','c4','c5','c6','c7','c8']); // c9 still out
    expect(ids).not.toContain('c9');
  });
  it('caseAgeMs uses last_gp_activity_at then updated_at then created_at (#37)', () => {
    expect(M.caseAgeMs({ last_gp_activity_at: ago(5), updated_at: ago(1), created_at: ago(40) }, NOW)).toBe(5 * DAY);
    expect(M.caseAgeMs({ last_gp_activity_at: null, updated_at: ago(8), created_at: ago(40) }, NOW)).toBe(8 * DAY);
    expect(M.caseAgeMs({ last_gp_activity_at: null, updated_at: null, created_at: ago(40) }, NOW)).toBe(40 * DAY);
  });
  it('withinPeriod treats current/all as always true; otherwise compares to nowMs', () => {
    expect(M.withinPeriod(ago(20), 'all', NOW)).toBe(true);
    expect(M.withinPeriod(ago(20), 'current', NOW)).toBe(true);
    expect(M.withinPeriod(ago(5), '7d', NOW)).toBe(true);
    expect(M.withinPeriod(ago(10), '7d', NOW)).toBe(false);
    expect(M.withinPeriod(ago(10), '14d', NOW)).toBe(true);
    expect(M.withinPeriod(null, '7d', NOW)).toBe(false);
  });
  it('isOverdue: DATE compare, excludes completed/cancelled, includes escalated (#1/#30)', () => {
    expect(M.isOverdue({ due_date: ago(2), status: 'open' }, TODAY)).toBe(true);
    expect(M.isOverdue({ due_date: ago(2), status: 'escalated' }, TODAY)).toBe(true); // escalated still overdue
    expect(M.isOverdue({ due_date: TODAY, status: 'open' }, TODAY)).toBe(false); // due today is NOT overdue
    expect(M.isOverdue({ due_date: ago(2), status: 'completed' }, TODAY)).toBe(false);
    expect(M.isOverdue({ due_date: ago(2), status: 'cancelled' }, TODAY)).toBe(false);
    expect(M.isOverdue({ due_date: null, status: 'open' }, TODAY)).toBe(false);
  });
  it('activeUserIdSet returns user_ids of the active cases (#6/#40)', () => {
    const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
    const set = M.activeUserIdSet(active);
    expect(set.has('u1')).toBe(true);
    expect(set.has('u9')).toBe(false); // withdrawn
    expect(set.has('u10')).toBe(false); // stale
  });
});

describe('securedAppUserIds + computeKpis', () => {
  const fx = makeFixture();

  it('securedAppUserIds dedupes and includes placed (#8)', () => {
    const set = M.securedAppUserIds(fx.apps);
    // a5(placed,u6), a6(contract_signed,u11), a8(placement_secured,u6 dup) -> u6,u11
    expect(Array.from(set).sort()).toEqual(['u11','u6']);
  });

  it('computeKpis: placed == unique secured GPs; completed_gps all-time; overdue via isOverdue', () => {
    const k = M.computeKpis({ cases: fx.cases, tasks: fx.tasks, apps: fx.apps, careerRoles: fx.careerRoles, period: 'current', nowMs: NOW, todayStr: TODAY });
    // active (non-withdrawn, non-stale) cases: c1..c7,c11 = 8 (c8 is >6mo stale -> excluded under 'current')
    expect(k.total_gps).toBe(8);
    // placed = unique secured GPs among active = u6,u11 = 2 (u8's app? u8 has no secured app)
    expect(k.placed).toBe(2);
    // open tasks on active cases: t1,t2,t3,t4,t5 (t6/t7 excluded by case; t8 cancelled) = 5
    expect(k.open_tasks).toBe(5);
    // overdue on active cases: t2(ago1), t3(escalated, ago2) ; t4 due TODAY not overdue = 2
    expect(k.overdue_tasks).toBe(2);
    // blocked active cases: c3,c4 = 2
    expect(k.blocked_cases).toBe(2);
    // completed_gps all-time: c7 + c8 (even though c8 is >6mo stale) = 2 (#15)
    expect(k.completed_gps).toBe(2);
  });
});

describe('computePipeline + pipelineCaseIds (count == drilldown length)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW }); // c1..c8,c11

  it('snapshot mode: count == its case-ids length per stage; visa folds into pbs (#56)', () => {
    const pipe = M.computePipeline(active, { cumulative: false });
    pipe.forEach(row => {
      const ids = M.pipelineCaseIds(active, row.key, { cumulative: false });
      expect(ids.length).toBe(row.count); // INVARIANT
    });
    const pbs = pipe.find(r => r.key === 'pbs');
    // snapshot pbs = c5(pbs) + c6(visa->pbs) = 2
    expect(pbs.count).toBe(2);
    expect(M.pipelineCaseIds(active, 'pbs', { cumulative: false }).sort()).toEqual(['c5','c6']);
  });

  it('rows are emitted in FUNNEL_STAGES order, complete excluded (#28)', () => {
    const pipe = M.computePipeline(active, { cumulative: false });
    expect(pipe.map(r => r.key)).toEqual(['myintealth','amc','career','ahpra','pbs','commencement']);
  });

  it('cumulative mode: monotonic narrowing + invariant holds (#2/#28/#29)', () => {
    const pipe = M.computePipeline(active, { cumulative: true });
    pipe.forEach(row => {
      const ids = M.pipelineCaseIds(active, row.key, { cumulative: true });
      expect(ids.length).toBe(row.count); // INVARIANT
    });
    // reached-or-passed myintealth = all non-complete active = c1,c2,c3,c4,c5,c6,c11 = 7
    expect(pipe.find(r => r.key === 'myintealth').count).toBe(7);
    // narrows monotonically top->bottom
    const counts = pipe.map(r => r.count);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i-1]);
  });

  it('blocked counted ONCE at current stage, not at every passed stage (#3)', () => {
    const pipe = M.computePipeline(active, { cumulative: true });
    const totalBlocked = pipe.reduce((s, r) => s + r.blocked, 0);
    // active blocked cases = c3(career), c4(ahpra) = 2 total across the whole funnel
    expect(totalBlocked).toBe(2);
    expect(pipe.find(r => r.key === 'career').blocked).toBe(1); // c3
    expect(pipe.find(r => r.key === 'ahpra').blocked).toBe(1);  // c4
    expect(pipe.find(r => r.key === 'myintealth').blocked).toBe(0); // not double-counted
  });
});

describe('computeBlockers (#57)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });

  it('one row per blocked active case, days_blocked from blocker_set_at', () => {
    const rows = M.computeBlockers(active, NOW);
    expect(rows.map(r => r.case_id).sort()).toEqual(['c3','c4']);
    const c3 = rows.find(r => r.case_id === 'c3');
    expect(c3.days_blocked).toBe(12); // blocker_set_at = ago(12)
    expect(c3.blocker_status).toBe('waiting_on_gp');
    const c4 = rows.find(r => r.case_id === 'c4');
    // c4 has null blocker_set_at -> fall back to caseAgeMs (last_gp_activity_at ago(3))
    expect(c4.days_blocked).toBe(3);
  });

  it('sorted by days_blocked desc', () => {
    const rows = M.computeBlockers(active, NOW);
    expect(rows[0].case_id).toBe('c3'); // 12 > 3
  });
});

describe('computeTaskHealth (#30/#31)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeIds = new Set(active.map(c => c.id));
  const scopedTasks = fx.tasks.filter(t => activeIds.has(t.case_id));

  it('open/in_progress counts + overdue matches isOverdue', () => {
    const th = M.computeTaskHealth(scopedTasks, fx.completedSample, TODAY);
    expect(th.open).toBe(2);        // t1, t5
    expect(th.in_progress).toBe(1); // t2
    expect(th.overdue).toBe(2);     // t2, t3 (t4 due today excluded)
  });
  it('completed_this_week + labelled avg over sample (#31)', () => {
    const th = M.computeTaskHealth(scopedTasks, fx.completedSample, TODAY);
    expect(th.completed_this_week).toBe(1); // ct1 completed ago(2)
    // avg of 7d and 9d = 8.0
    expect(th.avg_resolve_days).toBe(8);
    expect(th.avg_resolve_sample_size).toBe(2);
  });
});

describe('computeRsoWorkload + rsoCaseIds (#7/#32/#34)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeIds = new Set(active.map(c => c.id));
  const scopedTasks = fx.tasks.filter(t => activeIds.has(t.case_id));
  const roster = [
    { rso_id: 'rsoA', rso_name: 'Khaleed' },
    { rso_id: 'rsoB', rso_name: 'Hazel' }
  ];

  it('groups by assigned_rso with __unassigned__ bucket; count == rsoCaseIds length (#32)', () => {
    const rows = M.computeRsoWorkload(active, scopedTasks, roster, TODAY);
    rows.forEach(row => {
      const ids = M.rsoCaseIds(active, row.rso_id);
      expect(ids.length).toBe(row.case_count); // INVARIANT
    });
    const a = rows.find(r => r.rso_id === 'rsoA');
    // rsoA active cases: c1,c2,c6,c7 = 4
    expect(a.case_count).toBe(4);
    const unassigned = rows.find(r => r.rso_id === '__unassigned__');
    // c4 (assigned_rso null) ; c10 stale excluded already
    expect(unassigned.case_count).toBe(1);
    expect(M.rsoCaseIds(active, '__unassigned__')).toEqual(['c4']);
  });

  it('open_tasks/overdue_tasks attributed to case owner, match scoped task list (#33)', () => {
    const rows = M.computeRsoWorkload(active, scopedTasks, roster, TODAY);
    const a = rows.find(r => r.rso_id === 'rsoA');
    // tasks on rsoA cases: t1(c1 open), t2(c1 in_progress overdue), t3(c2 escalated overdue) = 3 open, 2 overdue
    expect(a.open_tasks).toBe(3);
    expect(a.overdue_tasks).toBe(2);
  });
});

describe('computePlacements + placementAppIds (tile == drilldown)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeUsers = M.activeUserIdSet(active);
  const interviewAppIds = new Set(fx.careerInterviews.map(i => i.application_id)); // {a3}

  function call(period) {
    return M.computePlacements(fx.apps, fx.careerRoles, activeUsers, interviewAppIds, period, NOW);
  }
  function ids(bucket, period) {
    return M.placementAppIds(fx.apps, bucket, activeUsers, interviewAppIds, period, NOW);
  }

  ['all','current','30d','14d','7d'].forEach(period => {
    it('every bucket count == placementAppIds length @ ' + period, () => {
      const p = call(period);
      ['applied','submitted_to_practice','interviewing','offers_made','secured'].forEach(b => {
        expect(ids(b, period).length).toBe(p[b]); // INVARIANT
      });
    });
  });

  it('secured includes placed + dedup not applied at app level; active scoping drops a7 (#8/#9)', () => {
    const p = call('all');
    // secured apps among active users: a5(placed,u6), a6(contract_signed,u11), a8(placement_secured,u6) = 3 app rows
    expect(p.secured).toBe(3);
    // a7 (withdrawn-case GP u9) excluded from applied
    expect(ids('applied','all')).not.toContain('a7');
    expect(ids('applied','all')).toContain('a1');
  });
  it('interviewing = status UNION interview membership, minus secured (#11)', () => {
    const p = call('all');
    // a3 (interview_scheduled + in interviewAppIds) = 1
    expect(p.interviewing).toBe(1);
    expect(ids('interviewing','all')).toEqual(['a3']);
    // a3 must NOT also be in applied
    expect(ids('applied','all')).not.toContain('a3');
  });
  it('offers_made uses offer set; not in applied (#10/#61)', () => {
    const p = call('all');
    expect(ids('offers_made','all')).toEqual(['a4']);
    expect(ids('applied','all')).not.toContain('a4');
  });
  it('active_roles counts is_active roles', () => {
    expect(call('all').active_roles).toBe(1);
  });
});

describe('computeGpActivity + gpActivityCaseIds (#12/#36/#37)', () => {
  const fx = makeFixture();
  // full active population (NOT period filtered) excluding complete: c1,c2,c3,c4,c5,c6,c11
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW }).filter(c => c.stage !== 'complete');

  it('bucket counts == gpActivityCaseIds length (#12)', () => {
    const a = M.computeGpActivity(active, NOW);
    ['active','inactive','cold'].forEach(b => {
      const ids = M.gpActivityCaseIds(active, b, NOW);
      const key = b === 'active' ? 'active_7d' : b === 'inactive' ? 'inactive_7_14d' : 'cold_14d_plus';
      expect(ids.length).toBe(a[key]); // INVARIANT
    });
    // active(<=7d): c1(2),c4(3),c5(5),c6(1),c11(0) = 5
    expect(a.active_7d).toBe(5);
    // inactive(7-14): c2(10) = 1
    expect(a.inactive_7_14d).toBe(1);
    // cold(>14): c3(20) = 1
    expect(a.cold_14d_plus).toBe(1);
  });

  it('cold_gps sorted by days_inactive desc before slice (#36)', () => {
    // build extra cold cases to prove ordering survives the cap
    const many = [];
    for (let i = 0; i < 13; i++) many.push({ id: 'x'+i, user_id: 'ux'+i, stage: 'amc', status: 'active', last_gp_activity_at: ago(15 + i), updated_at: ago(15+i), created_at: ago(100) });
    const a = M.computeGpActivity(many, NOW);
    expect(a.cold_gps.length).toBe(10); // capped at 10
    // most inactive first (x12 = 27 days)
    expect(a.cold_gps[0].days_inactive).toBeGreaterThanOrEqual(a.cold_gps[1].days_inactive);
    expect(a.cold_gps[0].days_inactive).toBe(27);
  });
});

describe('computeTicketMetrics + ticketIds (#39/#40)', () => {
  const fx = makeFixture();
  const active = M.filterActiveCases(fx.cases, { nowMs: NOW });
  const activeUsers = M.activeUserIdSet(active);

  it('open count scoped to active GPs == ticketIds length (#40)', () => {
    const t = M.computeTicketMetrics(fx.tickets, activeUsers, ago(7));
    // open: tk1(u1 active), tk4(u9 withdrawn -> excluded) => 1
    expect(t.open).toBe(1);
    expect(M.ticketIds(fx.tickets, 'open', activeUsers)).toEqual(['tk1']);
  });
  it('resolved_this_week + averages exclude nulls, expose sample sizes (#39)', () => {
    const t = M.computeTicketMetrics(fx.tickets, activeUsers, ago(7));
    // resolved closed tickets among active GPs: tk2(u2, resolved ago2 -> this week), tk3(u3, resolved ago30)
    expect(t.resolved_this_week).toBe(1);
    expect(M.ticketIds(fx.tickets, 'resolved', activeUsers).sort()).toEqual(['tk2','tk3']);
    // first-reply avg only over tickets with first_reply_at AND created_at: tk2 (ago10 -> ago9 = 24h)
    expect(t.avg_first_reply_hours).toBe(24);
    expect(t.avg_first_reply_sample_size).toBe(1); // tk3 has null first_reply_at
  });
});

describe('computeCompletions (#14/#15/#62)', () => {
  const fx = makeFixture();
  const completeAll = fx.cases.filter(c => c.stage === 'complete' && c.status !== 'withdrawn'); // c7, c8

  it('total all-time; this_month UTC + completed_at only (#15/#62)', () => {
    const c = M.computeCompletions(completeAll, fx.stageEvents, NOW);
    expect(c.total).toBe(2); // c7 (3d ago) + c8 (200d ago)
    // this month (June 2026 UTC): c7 completed ago(3)=2026-06-11 -> in month; c8 ago(200) -> not
    expect(c.this_month).toBe(1);
  });
  it('recent_milestones sorted globally by created_at desc + humanized labels (#14/#41)', () => {
    const c = M.computeCompletions(completeAll, fx.stageEvents, NOW);
    // newest stage event is c3 ago(1) -> career -> "Reached Secure Placement"
    expect(c.recent_milestones[0].milestone).toBe('Reached Secure Placement');
    // events are in strict created_at desc order
    for (let i = 1; i < c.recent_milestones.length; i++) {
      expect(new Date(c.recent_milestones[i-1].date) >= new Date(c.recent_milestones[i].date)).toBe(true);
    }
  });
  it('a case with null completed_at does not count toward this_month (#62)', () => {
    const withNull = [{ id: 'cz', user_id: 'uz', stage: 'complete', status: 'active', completed_at: null, updated_at: ago(1), created_at: ago(50) }];
    const c = M.computeCompletions(withNull, [], NOW);
    expect(c.total).toBe(1);
    expect(c.this_month).toBe(0);
  });
});

describe('cross-metric reconciliation (every metric == its drilldown list, every period)', () => {
  const fx = makeFixture();

  ['all','current','30d','14d','7d'].forEach(period => {
    it('pipeline + placements reconcile @ ' + period, () => {
      const active = M.filterActiveCases(fx.cases, { nowMs: NOW, allTime: period === 'all' });
      const cumulative = period !== 'current';
      // pipeline
      M.computePipeline(active, { cumulative }).forEach(row => {
        expect(M.pipelineCaseIds(active, row.key, { cumulative }).length).toBe(row.count);
      });
      // placements
      const activeUsers = M.activeUserIdSet(active);
      const interviewAppIds = new Set(fx.careerInterviews.map(i => i.application_id));
      const p = M.computePlacements(fx.apps, fx.careerRoles, activeUsers, interviewAppIds, period, NOW);
      ['applied','submitted_to_practice','interviewing','offers_made','secured'].forEach(b => {
        expect(M.placementAppIds(fx.apps, b, activeUsers, interviewAppIds, period, NOW).length).toBe(p[b]);
      });
      // gp activity (period-independent population)
      const activeNoComplete = active.filter(c => c.stage !== 'complete');
      const ga = M.computeGpActivity(activeNoComplete, NOW);
      [['active','active_7d'],['inactive','inactive_7_14d'],['cold','cold_14d_plus']].forEach(([b, key]) => {
        expect(M.gpActivityCaseIds(activeNoComplete, b, NOW).length).toBe(ga[key]);
      });
      // rso workload
      const activeIds = new Set(active.map(c => c.id));
      const scopedTasks = fx.tasks.filter(t => activeIds.has(t.case_id));
      M.computeRsoWorkload(active, scopedTasks, [], TODAY).forEach(row => {
        expect(M.rsoCaseIds(active, row.rso_id).length).toBe(row.case_count);
      });
    });
  });
});

export { makeFixture, NOW, TODAY, DAY, ago, ahead };

import * as ceoMetrics from '../lib/ceo-metrics.js';

describe('ceo-metrics API surface consumed by server endpoints', () => {
  const required = [
    'filterActiveCases','caseAgeMs','withinPeriod','isOverdue','activeUserIdSet',
    'computeKpis','computePipeline','pipelineCaseIds','computeBlockers',
    'computeTaskHealth','computeRsoWorkload','rsoCaseIds','computePlacements',
    'placementAppIds','securedAppUserIds','computeGpActivity','gpActivityCaseIds',
    'computeTicketMetrics','ticketIds','computeCompletions',
    'isSecuredStatus','isInterviewStatus','isOfferStatus'
  ];
  it('exports every function the endpoints call', () => {
    for (const name of required) {
      expect(typeof ceoMetrics[name], name).toBe('function');
    }
  });
  it('exports the shared constants', () => {
    expect(Array.isArray(ceoMetrics.OPEN_TASK_STATUSES)).toBe(true);
    expect(Array.isArray(ceoMetrics.OVERDUE_EXCLUDED_STATUSES)).toBe(true);
    expect(Array.isArray(ceoMetrics.FUNNEL_STAGES)).toBe(true);
    expect(typeof ceoMetrics.DB_STAGE_ORDER).toBe('object');
    expect(typeof ceoMetrics.SIX_MONTHS_MS).toBe('number');
  });
});

import { FIXTURE } from './ceo-metrics.fixture.js';

describe('endpoint parity: every card count equals its drilldown id list length', () => {
  const NOW_FX = FIXTURE.nowMs;
  const TODAY_FX = new Date(NOW_FX).toISOString().slice(0, 10);
  // career_interviews link apps into the interviewing bucket; the lib's placement helpers
  // require this set so computePlacements and placementAppIds agree (contract signature).
  const interviewAppIds = new Set((FIXTURE.careerInterviews || []).map(i => i.application_id));
  const weekAgoIso = new Date(NOW_FX - 7 * 86400000).toISOString();

  for (const period of ['current', '7d', '14d', '30d', 'all']) {
    it('pipeline bar count === pipelineCaseIds length per stage [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW_FX });
      const cumulative = period !== 'current';
      const bars = M.computePipeline(cases, { cumulative });
      for (const bar of bars) {
        expect(M.pipelineCaseIds(cases, bar.key, { cumulative }).length, bar.key).toBe(bar.count);
      }
    });

    it('placements tile === placementAppIds length per bucket [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW_FX });
      const activeUserIds = M.activeUserIdSet(cases);
      const p = M.computePlacements(FIXTURE.apps, FIXTURE.careerRoles, activeUserIds, interviewAppIds, period, NOW_FX);
      for (const bucket of ['applied','submitted_to_practice','interviewing','offers_made','secured']) {
        expect(M.placementAppIds(FIXTURE.apps, bucket, activeUserIds, interviewAppIds, period, NOW_FX).length, bucket).toBe(p[bucket]);
      }
    });

    it('gp activity tile === gpActivityCaseIds length per bucket [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW_FX });
      const a = M.computeGpActivity(cases, NOW_FX);
      expect(M.gpActivityCaseIds(cases, 'active', NOW_FX).length).toBe(a.active_7d);
      expect(M.gpActivityCaseIds(cases, 'inactive', NOW_FX).length).toBe(a.inactive_7_14d);
      expect(M.gpActivityCaseIds(cases, 'cold', NOW_FX).length).toBe(a.cold_14d_plus);
    });
  }

  it('task health overdue === overdue tasks via isOverdue (KPI parity, #30)', () => {
    const cases = M.filterActiveCases(FIXTURE.cases, { allTime: true, nowMs: NOW_FX });
    const ids = new Set(cases.map(c => c.id));
    const tasks = FIXTURE.tasks.filter(t => ids.has(t.case_id));
    const th = M.computeTaskHealth(tasks, FIXTURE.completedTasks, TODAY_FX);
    const overdueList = tasks.filter(t => M.isOverdue(t, TODAY_FX));
    expect(overdueList.length).toBe(th.overdue);
  });

  it('tickets open count === ticketIds open length (#38)', () => {
    const cases = M.filterActiveCases(FIXTURE.cases, { allTime: true, nowMs: NOW_FX });
    const activeUserIds = M.activeUserIdSet(cases);
    const tm = M.computeTicketMetrics(FIXTURE.tickets, activeUserIds, weekAgoIso);
    expect(M.ticketIds(FIXTURE.tickets, 'open', activeUserIds).length).toBe(tm.open);
  });
});

describe('trends shared status helpers', () => {
  it('isSecuredStatus includes placed (Zoho stage) and the legacy secured set', () => {
    ['hired','secured','placed','placement_secured','offer_accepted','contract_signed'].forEach(function(s) {
      expect(M.isSecuredStatus(s), s).toBe(true);
    });
    ['applied','interview','offer','rejected','withdrawn'].forEach(function(s) {
      expect(M.isSecuredStatus(s), s).toBe(false);
    });
  });
});

describe('KPI tile drilldown reconciliation (#24)', () => {
  const NOW = FIXTURE.nowMs;
  const TODAY = new Date(NOW).toISOString().slice(0, 10);
  const interviewAppIds = new Set((FIXTURE.careerInterviews || []).map(i => i.application_id));
  // Placed KPI counts unique active GPs holding a secured app and is independent of the
  // applied_at period window; the secured placement drilldown is period-scoped by design
  // (Tasks 3.2/3.3). They therefore reconcile under the periods the tile actually uses
  // (no applied_at window): 'current' and 'all'. (#24)
  for (const period of ['current','all']) {
    it('Placed tile === secured placementAppIds unique GPs [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const activeUserIds = M.activeUserIdSet(cases);
      const kpi = M.computeKpis({ cases, allCases: FIXTURE.cases, tasks: FIXTURE.tasks, apps: FIXTURE.apps, careerRoles: FIXTURE.careerRoles, period, nowMs: NOW, todayStr: TODAY, activeUserIds });
      const securedAppIds = M.placementAppIds(FIXTURE.apps, 'secured', activeUserIds, interviewAppIds, period, NOW);
      const uniqueGps = new Set(FIXTURE.apps.filter(a => securedAppIds.includes(a.id)).map(a => a.user_id));
      expect(uniqueGps.size).toBe(kpi.placed);
    });
  }
  for (const period of ['current','7d','30d','all']) {
    it('Overdue tile === isOverdue tasks on active cases [' + period + ']', () => {
      const cases = M.filterActiveCases(FIXTURE.cases, { allTime: period === 'all', nowMs: NOW });
      const ids = new Set(cases.map(c => c.id));
      const activeUserIds = M.activeUserIdSet(cases);
      const tasks = FIXTURE.tasks.filter(t => ids.has(t.case_id));
      const kpi = M.computeKpis({ cases, allCases: FIXTURE.cases, tasks, apps: FIXTURE.apps, careerRoles: FIXTURE.careerRoles, period, nowMs: NOW, todayStr: TODAY, activeUserIds });
      expect(tasks.filter(t => M.isOverdue(t, TODAY)).length).toBe(kpi.overdue_tasks);
    });
  }
});

describe('RSO oversight reconciliation', () => {
  it('every RSO row case_count equals rsoCaseIds length (incl. __unassigned__)', () => {
    // Deterministic active-scope: pin nowMs to the frozen fixture clock so the
    // 6-month staleness boundary doesn't depend on the wall clock.
    var active = M.filterActiveCases(FIXTURE.cases, { allTime: false, nowMs: FIXTURE.nowMs });
    var roster = FIXTURE.rsoRoster;
    // Fixture must seed a roster + a null-assigned_rso active case so both the
    // named and __unassigned__ buckets are exercised by this invariant.
    expect(Array.isArray(roster) && roster.length >= 2).toBe(true);
    var rows = M.computeRsoWorkload(active, FIXTURE.tasks, roster, FIXTURE.todayStr);
    rows.forEach(function (row) {
      expect(row.case_count).toBe(M.rsoCaseIds(active, row.rso_id).length);
    });
    // Both bucket kinds present and reconciling.
    var named = rows.find(function (r) { return r.rso_id !== '__unassigned__' && r.case_count > 0; });
    var unassigned = rows.find(function (r) { return r.rso_id === '__unassigned__'; });
    expect(named && named.case_count).toBe(M.rsoCaseIds(active, named && named.rso_id).length);
    expect(unassigned && unassigned.case_count).toBe(M.rsoCaseIds(active, '__unassigned__').length);
  });
});

describe('RSO summary reconciles with roster', () => {
  it('rsoCaseIds length == computeRsoWorkload case_count per id', () => {
    // Pin nowMs to the frozen fixture clock so the active-scope boundary is deterministic.
    var active = M.filterActiveCases(FIXTURE.cases, { allTime: false, nowMs: FIXTURE.nowMs });
    var rows = M.computeRsoWorkload(active, FIXTURE.tasks, FIXTURE.rsoRoster, FIXTURE.todayStr);
    var byId = {};
    rows.forEach(function (r) { byId[r.rso_id] = r.case_count; });
    Object.keys(byId).forEach(function (id) {
      expect(M.rsoCaseIds(active, id).length).toBe(byId[id]);
    });
  });
});

describe('opsTasksForRso (per-RSO ops grouping)', () => {
  const tasks = [
    { id: 't1', case_id: 'c1' },
    { id: 't2', case_id: 'c2' },
    { id: 't3', case_id: null }
  ];
  const caseById = {
    c1: { assigned_rso: 'rsoA' },
    c2: { assigned_rso: null }
  };

  it('returns only the tasks whose case is assigned to the given RSO', () => {
    expect(M.opsTasksForRso(tasks, caseById, 'rsoA').map(t => t.id)).toEqual(['t1']);
  });

  it('buckets null-rso and case-less tasks under __unassigned__', () => {
    // c2 has null assigned_rso; t3 has no case -> both __unassigned__
    expect(M.opsTasksForRso(tasks, caseById, '__unassigned__').map(t => t.id)).toEqual(['t2', 't3']);
  });
});

describe('callsForRso (per-RSO scheduled calls by email)', () => {
  const calls = [
    { id: 'k1', assigned_rso_email: 'a@x.com' },
    { id: 'k2', assigned_rso_email: 'B@X.com' },
    { id: 'k3', assigned_rso_email: '' },
    { id: 'k4' }
  ];

  it('filters by assigned_rso_email (exact)', () => {
    expect(M.callsForRso(calls, 'a@x.com').map(c => c.id)).toEqual(['k1']);
  });

  it('matches case-insensitively', () => {
    expect(M.callsForRso(calls, 'b@x.com').map(c => c.id)).toEqual(['k2']);
  });

  it('null/empty email returns calls with no assigned_rso_email (unassigned)', () => {
    expect(M.callsForRso(calls, null).map(c => c.id)).toEqual(['k3', 'k4']);
  });
});

describe('gpTasksByStage (GP file Tasks sub-tab grouping)', () => {
  const TODAY = '2026-06-14';
  const tasks = [
    { id: 't1', related_stage: 'ahpra', status: 'open', due_date: '2026-06-10' },     // active, overdue
    { id: 't2', related_stage: 'myintealth', status: 'completed', due_date: '2026-06-01' }, // completed -> hidden by default
    { id: 't3', related_stage: 'ahpra', status: 'in_progress', due_date: '2026-06-20' }, // active, not overdue
    { id: 't4', related_stage: null, status: 'waiting', due_date: null },              // active, no stage
    { id: 't5', related_stage: 'amc', status: 'cancelled', due_date: '2026-06-05' },   // cancelled -> hidden by default
    { id: 't6', related_stage: 'amc', status: 'escalated', due_date: '2026-06-30' }    // active
  ];

  it('excludes completed/cancelled by default and groups active tasks by related_stage in DB stage order, none-stage last', () => {
    const groups = M.gpTasksByStage(tasks, { showAll: false, todayStr: TODAY });
    // active tasks: t1,t3 (ahpra), t4 (none), t6 (amc). amc(idx1) before ahpra(idx3), none last.
    expect(groups.map(g => g.stage)).toEqual(['amc', 'ahpra', '__none__']);
    expect(groups.map(g => g.tasks.map(t => t.id))).toEqual([['t6'], ['t1', 't3'], ['t4']]);
  });

  it('showAll includes completed/cancelled tasks', () => {
    const groups = M.gpTasksByStage(tasks, { showAll: true, todayStr: TODAY });
    // now myintealth(idx0,t2), amc(idx1,t5+t6), ahpra(idx3,t1+t3), none(t4)
    expect(groups.map(g => g.stage)).toEqual(['myintealth', 'amc', 'ahpra', '__none__']);
    expect(groups.map(g => g.tasks.map(t => t.id))).toEqual([['t2'], ['t5', 't6'], ['t1', 't3'], ['t4']]);
  });

  it('marks overdue active tasks via isOverdue (completed/cancelled never overdue)', () => {
    const groups = M.gpTasksByStage(tasks, { showAll: true, todayStr: TODAY });
    const byId = {};
    groups.forEach(g => g.tasks.forEach(t => { byId[t.id] = t; }));
    expect(byId.t1.overdue).toBe(true);   // open + past due
    expect(byId.t3.overdue).toBe(false);  // future due
    expect(byId.t4.overdue).toBe(false);  // no due_date
    expect(byId.t5.overdue).toBe(false);  // cancelled -> never overdue even though past due
  });

  it('returns [] for empty/missing tasks', () => {
    expect(M.gpTasksByStage(null, { todayStr: TODAY })).toEqual([]);
    expect(M.gpTasksByStage([], { todayStr: TODAY })).toEqual([]);
  });
});

describe('gpNotesFromTimeline (GP file Notes sub-tab)', () => {
  const timeline = [
    { id: 'e1', event_type: 'note', title: 'First note', detail: 'd1', actor: 'RSO A', created_at: '2026-06-10T09:00:00Z' },
    { id: 'e2', event_type: 'stage_change', title: 'Moved to AHPRA', detail: 'd2', actor: 'system', created_at: '2026-06-11T09:00:00Z' },
    { id: 'e3', event_type: 'note', title: 'Latest note', detail: 'd3', actor: 'RSO B', created_at: '2026-06-12T09:00:00Z' },
    { id: 'e4', event_type: 'task_completed', title: 'Task done', detail: 'd4', actor: 'RSO A', created_at: '2026-06-13T09:00:00Z' },
    { id: 'e5', event_type: 'note', title: 'Middle note', detail: 'd5', actor: 'RSO A', created_at: '2026-06-11T12:00:00Z' }
  ];

  it('keeps only event_type === "note", newest first by created_at', () => {
    // notes are e1(06-10), e5(06-11 12:00), e3(06-12); newest-first -> e3, e5, e1
    expect(M.gpNotesFromTimeline(timeline).map(n => n.id)).toEqual(['e3', 'e5', 'e1']);
  });

  it('preserves the original note fields', () => {
    const first = M.gpNotesFromTimeline(timeline)[0];
    expect(first).toMatchObject({ id: 'e3', detail: 'd3', actor: 'RSO B' });
  });

  it('returns [] for empty/missing timeline', () => {
    expect(M.gpNotesFromTimeline(null)).toEqual([]);
    expect(M.gpNotesFromTimeline([])).toEqual([]);
  });
});

describe('mergeGpTimeline (GP file Timeline sub-tab)', () => {
  const timeline = [
    { id: 'tl1', event_type: 'note', title: 'A note', detail: 'nd', actor: 'RSO A', created_at: '2026-06-10T09:00:00Z' },
    { id: 'tl2', event_type: 'stage_change', title: 'To AHPRA', detail: 'sd', actor: 'system', created_at: '2026-06-12T09:00:00Z' }
  ];
  const messages = [
    { id: 'm1', direction: 'outbound', channel: 'email', sender: 'ops@gp', recipient: 'gp@x', subject: 'Welcome', body_text: 'Hi there', created_at: '2026-06-11T09:00:00Z' },
    { id: 'm2', direction: 'inbound', channel: 'sms', sender: 'gp@x', recipient: 'ops@gp', subject: null, body_text: 'Thanks', created_at: '2026-06-13T09:00:00Z' }
  ];

  it('merges timeline + messages, newest first by created_at', () => {
    // created_at order desc: m2(06-13), tl2(06-12), m1(06-11), tl1(06-10)
    expect(M.mergeGpTimeline(timeline, messages).map(e => e.id)).toEqual(['m2', 'tl2', 'm1', 'tl1']);
  });

  it('tags each entry with its kind (event vs message)', () => {
    const byId = {};
    M.mergeGpTimeline(timeline, messages).forEach(e => { byId[e.id] = e; });
    expect(byId.tl1.kind).toBe('event');
    expect(byId.m1.kind).toBe('message');
  });

  it('handles missing/empty inputs', () => {
    expect(M.mergeGpTimeline(null, null)).toEqual([]);
    expect(M.mergeGpTimeline(timeline, null).map(e => e.id)).toEqual(['tl2', 'tl1']);
    expect(M.mergeGpTimeline(null, messages).map(e => e.id)).toEqual(['m2', 'm1']);
  });
});
