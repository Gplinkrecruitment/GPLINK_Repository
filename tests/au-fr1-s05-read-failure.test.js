// Fix bundle FR-1, defect S-05: a failed database read must never lift a hold.
// An unreadable pathway used to be treated as "an ordinary overseas doctor",
// so a held segment B / C doctor could apply for any DPA role whenever one
// read failed. Unreadable now means: nothing identified, nothing applied for,
// on that request.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const re = require('../lib/role-eligibility.js');
const cp = require('../lib/candidate-pathway.js');

const NOW = '2026-11-20T00:00:00.000Z';
const ROLE_BASE = { provider: 'internal_ats', is_active: true, status: 'open', created_at: NOW, updated_at: NOW, tags: [], source_payload: {} };
const seedRoles = () => [
  Object.assign({}, ROLE_BASE, { id: 'role-dpa', provider_role_id: 'ats_fr1_dpa', title: 'GP (FAKE regional DPA)', masked_title: 'DPA - Dubbo - Bulk Billing',
    practice_name: 'Test Regional Practice (FAKE)', practice_id: 'p-dubbo', suburb: 'Dubbo', location_city: 'Dubbo', location_state: 'NSW', nearest_city: 'Dubbo',
    billing_model: 'bulk', dpa: true, dpa_status: 'yes', mmm: 'MM3', regional: true, vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false }),
  Object.assign({}, ROLE_BASE, { id: 'role-metro', provider_role_id: 'ats_fr1_metro', title: 'GP (FAKE metro)', masked_title: 'Non-DPA - Parramatta - Mixed Billing',
    practice_name: 'Test Metro Practice (FAKE)', practice_id: 'p-metro', suburb: 'Parramatta', location_city: 'Parramatta', location_state: 'NSW', nearest_city: 'Sydney',
    billing_model: 'mixed', dpa: false, dpa_status: 'no', mmm: 'MM1', metro: true, vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false })
];
const DPA = 'internal_ats:ats_fr1_dpa';
const DPA_ROLE = { dpa: true, dpa_status: 'yes', vr_requirement: 'vr_required' };
const METRO_ROLE = { dpa: false, dpa_status: 'no', vr_requirement: 'vr_required' };

describe('S-05: the rule (roleEligibilityFor), every pathway', () => {
  const profileFor = (pathway) => ({ candidate_pathway: pathway, candidate_basis: 'australia', pathway_set_by: 'ceo@gplink-test.local', pathway_confirmed_at: NOW, pathway_confirmed_by: 'ceo@gplink-test.local' });
  it('readFailed: nothing can be applied for and nothing is identified, whatever the doctor would otherwise be', () => {
    const variants = [
      cp.overseasDefault({ flagEnabled: true, readFailed: true }),
      Object.assign(cp.overseasDefault({ flagEnabled: true, legacyDpaExempt: true }), { readFailed: true }),
      { readFailed: true },
      Object.assign(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), credentials: null, flagEnabled: true }), { readFailed: true }),
      Object.assign(cp.resolvePathwayFromRecords({ profile: profileFor('au_non_vr'), credentials: null, flagEnabled: true }), { readFailed: true }),
      Object.assign(cp.resolvePathwayFromRecords({ profile: profileFor('au_restricted'), credentials: null, flagEnabled: true }), { readFailed: true })
    ];
    for (const p of variants) for (const role of [DPA_ROLE, METRO_ROLE, {}, null]) {
      const out = re.roleEligibilityFor(p, role);
      expect(out).toMatchObject({ canApply: false, identifiable: false, eligible: false, unreadable: true, legacyReason: 'dpa_restricted' });
      expect(out.reasons).toContain(re.REASON.PATHWAY_UNREADABLE);
    }
  });
  it('the old behaviour, pinned so it cannot return: an unreadable pathway used to open every DPA role', () => {
    const out = re.roleEligibilityFor(cp.overseasDefault({ flagEnabled: true, readFailed: true }), DPA_ROLE);
    expect(out.canApply).toBe(false);
  });
  it('a genuinely overseas doctor whose reads SUCCEED gets exactly today\'s answer', () => {
    const restricted = cp.overseasDefault({ flagEnabled: true, legacyDpaExempt: false });
    const exempt = cp.overseasDefault({ flagEnabled: true, legacyDpaExempt: true });
    expect(re.roleEligibilityFor(restricted, DPA_ROLE)).toEqual({ visible: true, identifiable: true, canApply: true, eligible: true, hold: false, reasons: [], legacyReason: '' });
    expect(re.roleEligibilityFor(restricted, METRO_ROLE)).toEqual({ visible: true, identifiable: false, canApply: false, eligible: false, hold: false, reasons: ['dpa_restricted'], legacyReason: 'dpa_restricted' });
    expect(re.roleEligibilityFor(exempt, METRO_ROLE)).toEqual({ visible: true, identifiable: true, canApply: true, eligible: true, hold: false, reasons: [], legacyReason: '' });
  });
  it('switch off, and "the migration is not applied" (schemaMissing), are overseas by design: unchanged', () => {
    const off = cp.overseasDefault({ flagEnabled: false, legacyDpaExempt: false });
    expect(off.readFailed).toBeUndefined();
    expect(re.roleEligibilityFor(off, DPA_ROLE).canApply).toBe(true);
    const missing = Object.assign(cp.overseasDefault({ flagEnabled: true, legacyDpaExempt: false }), { schemaMissing: true });
    expect(re.roleEligibilityFor(missing, DPA_ROLE)).toMatchObject({ canApply: true, identifiable: true, hold: false });
    expect(re.roleEligibilityFor(missing, DPA_ROLE).unreadable).toBeUndefined();
    expect(re.roleEligibilityFor(missing, METRO_ROLE).canApply).toBe(false);
    // no result at all: restricted, as before
    expect(re.roleEligibilityFor(null, DPA_ROLE).canApply).toBe(true);
    expect(re.roleEligibilityFor(null, METRO_ROLE).canApply).toBe(false);
  });
});

describe('S-05: on the server', () => {
  let h;
  let seq = 0;
  const rows = (table) => h.emu.table(table);
  function add(kind, overrides) {
    seq += 1;
    const d = buildAuDoctor(kind, Object.assign({ idSuffix: 's' + seq }, overrides || {}));
    const db = buildAuFixtureDb([d]);
    Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
    rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
    d.cookie = h.gpCookie(d.email, d.userId);
    return d;
  }
  const WP09_AGREED = { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION };
  const apply = (d, roleId) => h.post('/api/career/apply', /^au_/.test(d.kind) ? { roleId, shareConsent: WP09_AGREED } : { roleId }, { cookie: d.cookie });
  const appsOf = (d) => rows('gp_applications').filter((a) => a.user_id === d.userId);

  beforeAll(async () => {
    const tables = { career_roles: seedRoles(), practices: [
      { id: 'p-metro', name: 'Test Metro Practice (FAKE)', location_state: 'NSW', suburb: 'Parramatta', metadata: {}, is_active: true },
      { id: 'p-dubbo', name: 'Test Regional Practice (FAKE)', location_state: 'NSW', suburb: 'Dubbo', metadata: {}, is_active: true }] };
    ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents', 'admin_audit_log', 'runtime_kv', 'rate_limits', 'gp_nudge_log',
      'user_profiles', 'gp_credentials', 'registration_cases', 'user_state', 'career_interviews', 'ats_offers', 'ats_stage_events'].forEach((n) => { tables[n] = []; });
    h = await bootAuTestServer({ name: 'fr1-s05', tables });
  }, 60000);
  afterAll(async () => { if (h) await h.close(); });
  beforeEach(() => { h.setSwitch(true); h.emu.forbid(null); h.emu.failTables = {}; });

  it.each([['au_non_vr'], ['au_registrar'], ['au_restricted']])('a held %s doctor cannot apply for a DPA role while their records cannot be read (and could not before the failure either)', async (kind) => {
    const d = add(kind);
    const held = await apply(d, DPA);
    expect(held.status).toBeGreaterThanOrEqual(400);
    for (const table of ['gp_credentials', 'user_profiles']) {
      h.emu.failTables = { [table]: 500 };
      let res;
      try { res = await apply(d, DPA); } finally { h.emu.failTables = {}; }
      expect(res.status, kind + ' with ' + table + ' unreadable').toBeGreaterThanOrEqual(400);
      expect(res.json && res.json.ok).not.toBe(true);
    }
    expect(appsOf(d)).toEqual([]);
  });

  it('an overseas doctor whose reads succeed still applies for a DPA role exactly as before; with the switch off a failing new table changes nothing', async () => {
    const uk = add('overseas_null');
    const ok = await apply(uk, DPA);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(appsOf(uk).length).toBe(1);
    const uk2 = add('overseas_null');
    h.setSwitch(false);
    h.emu.failTables = { gp_credentials: 500 };
    let off;
    try { off = await apply(uk2, DPA); } finally { h.emu.failTables = {}; h.setSwitch(true); }
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(appsOf(uk2).length).toBe(1);
  });
});
