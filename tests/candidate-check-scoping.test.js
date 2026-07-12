// Candidate "document check" routing: an un-placed candidate's flagged/doc-review
// task is routed to the least-loaded RSO via registration_tasks.assignee WITHOUT
// assigning the case. taskVisibleToRso lets that RSO see the routed task even though
// the case is not theirs, while preserving the normal case-scoping fail-closed rule.
// These unit-test the pure predicate exported from server.js (__testUtils).
import { describe, it, expect } from 'vitest';
const { __testUtils } = require('../server.js');
const { taskVisibleToRso, gpScopeAllowsCase } = __testUtils;

const ME = 'rso-me-0000-0000-000000000001';
const OTHER = 'rso-other-0000-0000-00000000002';
const meScope = { superAdmin: false, rsoUserId: ME };
const superScope = { superAdmin: true, rsoUserId: null };

describe('taskVisibleToRso', () => {
  it('(a) shows a task whose case is assigned to me (normal case-scoping)', () => {
    const task = { id: 't1', assignee: null, task_type: 'flagged_doc' };
    const caseRow = { assigned_rso: ME };
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(true);
  });

  it('(b) shows a doc-check task on an UNASSIGNED case routed to me via assignee', () => {
    const task = { id: 't2', assignee: ME, task_type: 'flagged_doc' };
    const caseRow = { assigned_rso: null, assigned_va: null };
    // Case-scoping alone would hide it (nobody owns the case)...
    expect(gpScopeAllowsCase(meScope, caseRow)).toBe(false);
    // ...but the task-level assignee routing reveals this document check to me.
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(true);
  });

  it('(c) hides a task on an UNASSIGNED case routed to another RSO', () => {
    const task = { id: 't3', assignee: OTHER, task_type: 'flagged_doc' };
    const caseRow = { assigned_rso: null, assigned_va: null };
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(false);
  });

  it('(c2) hides a task on an UNASSIGNED case with no assignee at all', () => {
    const task = { id: 't3b', assignee: null, task_type: 'flagged_doc' };
    const caseRow = { assigned_rso: null, assigned_va: null };
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(false);
  });

  it('(d) super-admin sees every task, including non-doc-check types', () => {
    // Super-admin bypasses both the case-scope and the doc-check gate.
    expect(taskVisibleToRso(superScope, { assignee: OTHER, task_type: 'email_triage' }, { assigned_rso: OTHER })).toBe(true);
    expect(taskVisibleToRso(superScope, { assignee: null, task_type: 'flagged_doc' }, { assigned_rso: null, assigned_va: null })).toBe(true);
    expect(taskVisibleToRso(superScope, { assignee: null }, null)).toBe(true);
  });

  it('(e) hides an assignee-owned task of a NON-review type on an unassigned case', () => {
    // email_triage is auto-assigned to the default RSO even on unassigned cases.
    // It must NOT surface via the assignee branch — that branch is only for the
    // candidate document checks (flagged_doc / doc_review) shown in "Document checks".
    const task = { id: 't6', assignee: ME, task_type: 'email_triage' };
    const caseRow = { assigned_rso: null, assigned_va: null };
    expect(gpScopeAllowsCase(meScope, caseRow)).toBe(false);
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(false);
  });

  it('does not leak another RSO’s assigned case when the task has no assignee', () => {
    const task = { id: 't4', assignee: null, task_type: 'flagged_doc' };
    const caseRow = { assigned_rso: OTHER };
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(false);
  });

  it('an admin with no roster identity (rsoUserId null) matches nothing', () => {
    const noIdScope = { superAdmin: false, rsoUserId: null };
    // Even a task with a null assignee must not match a null rsoUserId.
    expect(taskVisibleToRso(noIdScope, { assignee: null, task_type: 'flagged_doc' }, { assigned_rso: null })).toBe(false);
    expect(taskVisibleToRso(noIdScope, { assignee: ME, task_type: 'flagged_doc' }, { assigned_rso: null })).toBe(false);
  });

  it('assignee routing does not override case ownership by another RSO', () => {
    // Case is assigned to OTHER but the doc-check task happens to carry assignee===ME.
    // I still see it (it is routed to me); the point is the predicate is an OR, and
    // this asserts the assignee branch is what grants access, not the case branch.
    const task = { id: 't5', assignee: ME, task_type: 'doc_review' };
    const caseRow = { assigned_rso: OTHER };
    expect(gpScopeAllowsCase(meScope, caseRow)).toBe(false);
    expect(taskVisibleToRso(meScope, task, caseRow)).toBe(true);
  });
});
