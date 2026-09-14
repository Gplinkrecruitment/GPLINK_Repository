// Owner 2026-09-15: "hide GP Link Sandbox Practice from any user". A practice
// flagged practices.metadata.hidden_from_doctors = true disappears from every
// doctor-facing LISTING (careers board, map pins + count, public jobs/SEO/
// sitemap, job page by URL, apply, filled-role alternatives) while staff
// surfaces and already-matched/applied doctors are untouched.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const P = require(path.join(process.cwd(), 'lib', 'ats-practices.js'));

describe('hidden-from-doctors practice — pure rules', () => {
  it('reads the flag strictly (boolean true only), from an object or a JSON string', () => {
    expect(P.isPracticeHiddenFromDoctors({ metadata: { hidden_from_doctors: true } })).toBe(true);
    expect(P.isPracticeHiddenFromDoctors({ metadata: '{"hidden_from_doctors":true}' })).toBe(true);
    expect(P.isPracticeHiddenFromDoctors({ metadata: { hidden_from_doctors: 'true' } })).toBe(false);
    expect(P.isPracticeHiddenFromDoctors({ metadata: { hidden_from_doctors: false } })).toBe(false);
    expect(P.isPracticeHiddenFromDoctors({ metadata: {} })).toBe(false);
    expect(P.isPracticeHiddenFromDoctors({})).toBe(false);
    expect(P.isPracticeHiddenFromDoctors(null)).toBe(false);
  });
  it('hides a role by practice_id, and by name only when the role has no practice_id', () => {
    const refs = P.buildHiddenPracticeRefs([
      { id: 'p-hidden', name: 'GP Link  Sandbox Practice', metadata: { hidden_from_doctors: true } },
      { id: 'p-open', name: 'Open Practice', metadata: {} },
    ]);
    expect(refs.ids.has('p-hidden')).toBe(true);
    expect(refs.ids.has('p-open')).toBe(false);
    expect(P.roleBelongsToHiddenPractice({ practice_id: 'p-hidden', practice_name: 'Anything' }, refs)).toBe(true);
    expect(P.roleBelongsToHiddenPractice({ practice_id: 'p-open', practice_name: 'GP Link Sandbox Practice' }, refs)).toBe(false); // id wins over name
    expect(P.roleBelongsToHiddenPractice({ practice_id: null, practice_name: 'gp link sandbox practice' }, refs)).toBe(true);
    expect(P.roleBelongsToHiddenPractice({ practice_id: null, practice_name: 'Open Practice' }, refs)).toBe(false);
    expect(P.roleBelongsToHiddenPractice(null, refs)).toBe(false);
    expect(P.roleBelongsToHiddenPractice({ practice_id: 'p-hidden' }, null)).toBe(false);
  });
});

describe('hidden-from-doctors practice — every doctor-facing listing is filtered server-side', () => {
  const s = read('server.js');
  it('loads the hidden set with one tiny keyed practices read, cached 60 s, failing open', () => {
    expect(s).toContain("await supabaseDbRequest('practices', 'select=id,name,metadata&metadata->>hidden_from_doctors=eq.true')");
    expect(s).toContain('const DOCTOR_HIDDEN_PRACTICES_TTL_MS = 60 * 1000;');
    expect(s).toContain('if (!r.ok || !Array.isArray(r.data)) return atsPracticeUtil.buildHiddenPracticeRefs([]);');
  });
  it('careers board (/api/career/roles, both branches), public jobs + practice map + SEO + sitemap, job page by URL, apply, alternatives', () => {
    expect(s).toContain('const visibleRows = rows.filter((row) => row && isInternalAtsRoleOpenForGp(row) && !atsPracticeUtil.roleBelongsToHiddenPractice(row, hiddenPracticeRefs));');
    expect(s).toContain('const localInternalRoles = (await listGpVisibleInternalAtsRoles()).filter((row) => !atsPracticeUtil.roleBelongsToHiddenPractice(row, localHiddenRefs));');
    const pub = s.slice(s.indexOf('async function getActivePublicJobRowsLive()'), s.indexOf('async function getPublicJobsRows('));
    expect(pub).toContain('!atsPracticeUtil.roleBelongsToHiddenPractice(row, hiddenPracticeRefs));');
    // job page: decided before the DPA stub, staff preview passes, a doctor with a row on the role passes
    const gate = s.indexOf('if (!isAdminPreviewRole && atsPracticeUtil.roleBelongsToHiddenPractice(finalRoleRow, await listDoctorHiddenPracticeRefs())) {');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(s.indexOf('const roleDetailGpProfile = await _resolveGpJobsProfile(roleDetailUserId, roleDetailEmail);'));
    expect(s).toContain("if (!hiddenPass) { sendJson(res, 404, { ok: false, message: 'Role not found.' }); return; }");
    expect(s).toContain('if (!existingAppRow && atsPracticeUtil.roleBelongsToHiddenPractice(roleRow, await listDoctorHiddenPracticeRefs())) {');
    expect(s).toContain('roPool = roPool.filter(function (j) { return !atsPracticeUtil.roleBelongsToHiddenPractice(j, roHiddenRefs); });');
  });
  it('the matches, applications and staff feeds are not touched', () => {
    const untouched = ["'/api/career/matches'", "'/api/career/applications'", "'/api/ats/matching/jobs'", "'/api/ats/practices'"];
    untouched.forEach((p) => { const at = s.indexOf('pathname === ' + p); expect(at).toBeGreaterThan(0); expect(s.slice(at, at + 4000)).not.toContain('roleBelongsToHiddenPractice'); });
  });
});
