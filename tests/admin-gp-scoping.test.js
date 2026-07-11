// Authorization scoping: a regular admin (RSO) may only see/act on GPs assigned
// to them (registration_cases.assigned_rso || assigned_va === their rso_team
// user_id); super admins (CEO) are never scoped; an admin not on the roster sees
// NOTHING (fail-closed). These unit-test the pure scoping helpers in server.js.
import { describe, it, expect } from 'vitest';
const { __testUtils } = require('../server.js');
const {
  resolveAdminGpScope,
  caseAssignedToRso,
  gpScopeAllowsCase,
  scopeDashboardToUserIds
} = __testUtils;

// From the RSO_TEAM seed (loadRsoTeam falls back to it when Supabase is unconfigured).
const HAZEL = { id: '7bed5eb8-f03d-40d6-b090-eb006cd02be7', email: 'hazel@mygplink.com.au' };
const KHALEED = { id: '2f94f870-7ab2-4f71-98ad-bf3756ed88db', email: 'khaleedmahmoud1211@gmail.com' };

describe('resolveAdminGpScope', () => {
  it('super_admin is never scoped (sees everything)', async () => {
    expect(await resolveAdminGpScope({ role: 'super_admin', email: HAZEL.email }))
      .toEqual({ superAdmin: true, rsoUserId: null });
  });
  it('a regular admin resolves to their roster user_id', async () => {
    const scope = await resolveAdminGpScope({ role: 'admin', email: HAZEL.email });
    expect(scope.superAdmin).toBe(false);
    expect(scope.rsoUserId).toBe(HAZEL.id);
  });
  it('email match is case-insensitive', async () => {
    expect((await resolveAdminGpScope({ role: 'admin', email: 'HAZEL@MyGPLink.com.au' })).rsoUserId)
      .toBe(HAZEL.id);
  });
  it('a staff admin not on the roster resolves to null (fail-closed: sees nothing)', async () => {
    expect(await resolveAdminGpScope({ role: 'staff', email: 'stranger@example.com' }))
      .toEqual({ superAdmin: false, rsoUserId: null });
  });
});

// "View RSO POV": a super-admin passes ?pov_rso=<email> to preview an RSO's scope.
// The override is honored ONLY for super-admins; a regular admin sending it is ignored.
const povUrl = (email) => new URL('http://x/api/admin/dashboard?pov_rso=' + encodeURIComponent(email));

describe('resolveAdminGpScope — View RSO POV override', () => {
  it('super_admin with pov_rso is scoped to that RSO (previews their view)', async () => {
    const scope = await resolveAdminGpScope({ role: 'super_admin', email: 'ceo@mygplink.com.au' }, povUrl(HAZEL.email));
    expect(scope.superAdmin).toBe(false);
    expect(scope.rsoUserId).toBe(HAZEL.id);
    expect(scope.povEmail).toBe(HAZEL.email);
  });
  it('pov_rso email match is case-insensitive', async () => {
    const scope = await resolveAdminGpScope({ role: 'super_admin', email: 'ceo@mygplink.com.au' }, povUrl('HAZEL@MyGPLink.com.au'));
    expect(scope.rsoUserId).toBe(HAZEL.id);
  });
  it('super_admin previewing an off-roster email gets an empty scope (faithful: they see nothing)', async () => {
    const scope = await resolveAdminGpScope({ role: 'super_admin', email: 'ceo@mygplink.com.au' }, povUrl('ghost@example.com'));
    expect(scope).toEqual({ superAdmin: false, rsoUserId: null, povEmail: 'ghost@example.com' });
  });
  it('a regular admin CANNOT use pov_rso to view another RSO (override ignored)', async () => {
    const scope = await resolveAdminGpScope({ role: 'admin', email: KHALEED.email }, povUrl(HAZEL.email));
    expect(scope.superAdmin).toBe(false);
    expect(scope.rsoUserId).toBe(KHALEED.id); // still their own scope, not Hazel's
  });
  it('super_admin without a pov_rso param is unchanged (sees everything)', async () => {
    expect(await resolveAdminGpScope({ role: 'super_admin', email: 'ceo@mygplink.com.au' }, new URL('http://x/api/admin/dashboard')))
      .toEqual({ superAdmin: true, rsoUserId: null });
  });
});

describe('caseAssignedToRso', () => {
  it('matches assigned_rso', () => {
    expect(caseAssignedToRso({ assigned_rso: HAZEL.id }, HAZEL.id)).toBe(true);
  });
  it('matches assigned_va when assigned_rso is empty', () => {
    expect(caseAssignedToRso({ assigned_va: HAZEL.id }, HAZEL.id)).toBe(true);
  });
  it('assigned_rso takes precedence over assigned_va', () => {
    expect(caseAssignedToRso({ assigned_rso: KHALEED.id, assigned_va: HAZEL.id }, HAZEL.id)).toBe(false);
    expect(caseAssignedToRso({ assigned_rso: HAZEL.id, assigned_va: KHALEED.id }, HAZEL.id)).toBe(true);
  });
  it('is false for another RSO, a null case, or a null rso', () => {
    expect(caseAssignedToRso({ assigned_rso: KHALEED.id }, HAZEL.id)).toBe(false);
    expect(caseAssignedToRso(null, HAZEL.id)).toBe(false);
    expect(caseAssignedToRso({ assigned_rso: HAZEL.id }, null)).toBe(false);
  });
});

describe('gpScopeAllowsCase', () => {
  it('super admin sees every case including unassigned / null', () => {
    expect(gpScopeAllowsCase({ superAdmin: true }, { assigned_rso: KHALEED.id })).toBe(true);
    expect(gpScopeAllowsCase({ superAdmin: true }, null)).toBe(true);
  });
  it('regular admin only sees their assigned case', () => {
    const scope = { superAdmin: false, rsoUserId: HAZEL.id };
    expect(gpScopeAllowsCase(scope, { assigned_rso: HAZEL.id })).toBe(true);
    expect(gpScopeAllowsCase(scope, { assigned_va: HAZEL.id })).toBe(true);
    expect(gpScopeAllowsCase(scope, { assigned_rso: KHALEED.id })).toBe(false);
    expect(gpScopeAllowsCase(scope, {})).toBe(false);
  });
  it('an admin with no roster identity (rsoUserId null) sees nothing', () => {
    expect(gpScopeAllowsCase({ superAdmin: false, rsoUserId: null }, { assigned_rso: HAZEL.id })).toBe(false);
  });
});

describe('scopeDashboardToUserIds', () => {
  const dash = () => ({
    summary: { totalGps: 3 },
    candidates: [{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }],
    verificationQueue: [{ userId: 'u2' }, { userId: 'u3' }],
    tickets: [{ id: 't1' }]
  });
  it('keeps only candidates/verificationQueue whose userId is assigned', () => {
    const out = scopeDashboardToUserIds(dash(), new Set(['u1', 'u3']));
    expect(out.candidates.map(c => c.userId)).toEqual(['u1', 'u3']);
    expect(out.verificationQueue.map(c => c.userId)).toEqual(['u3']);
  });
  it('empty assigned set yields empty GP arrays (fail-closed)', () => {
    const out = scopeDashboardToUserIds(dash(), new Set());
    expect(out.candidates).toEqual([]);
    expect(out.verificationQueue).toEqual([]);
  });
  it('does not mutate the source aggregate (shared-cache safety)', () => {
    const d = dash();
    scopeDashboardToUserIds(d, new Set(['u1']));
    expect(d.candidates).toHaveLength(3);
  });
});
