// Australian GP build, WP-22 (walk-findings W3-D23, D4, APP-19): what a
// signed-in doctor is shown about a role, in the app.
//
//   Australian pathway  no internal role title ("Non-DPA - Parramatta - Mixed
//                       Billing"), no dollar figure and no percentage on a
//                       role listing ("70% to GP"); the billing MODEL stays;
//                       the plain facts are there; an offer's own terms are
//                       not touched
//   overseas doctor     with the switch on, Careers and the job page receive
//                       exactly what they receive with it off
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const auPublicJobs = require('../lib/au-public-jobs.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const localise = require('../js/au-localise.js');
const fx = require('./helpers/au-wp22-fixtures.js');

const ROOT = path.resolve(__dirname, '..');
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'practices',
  'career_suburb_geo_cache', 'ats_offers', 'career_interviews', 'scheduled_calls'];

let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'v' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const FIGURE = /\$|%|per cent|\b\d[\d,.]*\s?k\b/i;
const withoutIds = (role) => JSON.stringify(Object.assign({}, role, { id: '', sourceId: '', applicantBand: '', headerImageUrl: '', heroImageUrl: '' }));

beforeAll(async () => {
  const tables = buildAuFixtureDb([]);
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  tables.career_roles = fx.allRows();
  h = await bootAuTestServer({ name: 'wp22v', tables, emulator: { auth: true, rpc: { rate_limit_hit: function () { return { allowed: true }; } } } });
  t = h.testUtils;
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); });

describe('a doctor on an Australian pathway', () => {
  it('Careers: no internal title and no figure on any role; the billing model and the facts are there', async () => {
    const au = add('au_vr');
    const res = await h.get('/api/career/roles', { cookie: au.cookie });
    expect(res.status).toBe(200);
    const list = res.json.roles.filter((r) => !r.blurred);
    expect(list.length).toBeGreaterThanOrEqual(6);
    list.forEach((role) => {
      expect(withoutIds(role), role.id).not.toMatch(FIGURE);
      expect(auPublicJobs.isInternalRoleTitle(role.roleType), role.id).toBe(false);
      expect(auPublicJobs.isInternalRoleTitle(role.auTitle), role.id).toBe(false);
      expect(role.auFacts).toBeTruthy();
      expect(role.earnings).toBe('');
      expect(role.earningNote).toBe('');
      expect(role.filterTokens).not.toContain('High Earning');
      expect(auDoctorText.violations(withoutIds(role)), role.id).toEqual([]);
    });
    const one = list.filter((r) => r.id === fx.publicId(1))[0];
    expect(one.auTitle).toBe('General Practice · Parramatta, NSW');
    expect(one.roleType).toBe('General Practitioner');
    expect(one.billing).toMatch(/mixed/i);
    expect(one.auFacts.billingModel).toBe('mixed');
    expect(one.packageTerms.billingSplit).toBe('');
    expect(one.packageTerms.incomeGuarantee).toBe('');
    expect(one.benefits).toEqual(['Full nursing support', 'Modern rooms']);
    // The masked headline Careers reads the suburb out of is left as it is.
    expect(one.practiceName).toBe('Non-DPA - Parramatta - Mixed Billing');
    expect(list.filter((r) => r.id === fx.publicId(6))[0].auTitle).toBe('Family GP with a skin interest');
  });

  it('the job page payload: the same, including the detail cards', async () => {
    const au = add('au_vr');
    const res = await h.get('/api/career/role?id=' + encodeURIComponent(fx.publicId(1)), { cookie: au.cookie });
    expect(res.status).toBe(200);
    const role = res.json.role;
    expect(withoutIds(role)).not.toMatch(FIGURE);
    expect(JSON.stringify(role.detailCards || [])).not.toMatch(/Non-DPA - /);
    expect(role.auTitle).toBe('General Practice · Parramatta, NSW');
    expect(role.auFacts.vrRequirement).toBe('vr_required');
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('an application keeps the practice\'s own offer terms; only the listing inside it loses its figures', () => {
    const app = {
      id: 'app-1', roleTitle: 'Non-DPA - Parramatta - Mixed Billing', status: 'offer_received',
      offer: { salary: '$310,000', billingSplit: '68% to GP', notes: 'Sign-on bonus $5,000' },
      role: { roleType: 'DPA - Dubbo - Bulk Billing', practiceName: 'DPA - Dubbo - Bulk Billing', earnings: '$350k - $450k', benefits: ['70% of billings', 'Nursing'] },
      interviewAt: '2026-12-01T03:00:00.000Z'
    };
    const out = auPublicJobs.neutraliseDoctorApplicationPayload({ applications: [app] }).applications[0];
    expect(out.roleTitle).toBe('General Practice · Parramatta');
    expect(out.offer).toEqual(app.offer);
    expect(out.role.earnings).toBe('');
    expect(out.role.benefits).toEqual(['Nursing']);
    expect(out.role.roleType).toBe('General Practitioner');
    expect(out.role.practiceName).toBe('DPA - Dubbo - Bulk Billing');
    expect(out.interviewAt).toBe(app.interviewAt);
    expect(out.status).toBe('offer_received');
  });

  it('a screen that still draws the internal title has it rewritten in the browser', () => {
    expect(localise.localiseText('Non-DPA - Parramatta - Mixed Billing', false)).toBe('General Practice · Parramatta');
    expect(localise.localiseText('You applied to DPA – Dubbo – Bulk Billing on 20 Nov 2026', false)).toBe('You applied to General Practice · Dubbo on 20 Nov 2026');
    expect(localise.localiseText('DPA eligible', false)).toBe('DPA eligible');
    expect(localise.localiseText('Mixed billing', false)).toBe('Mixed billing');
  });

  it('the in-app job page still draws an Australian doctor\'s facts from auFacts, with none of the rows for a doctor moving country', () => {
    const job = fs.readFileSync(path.join(ROOT, 'pages', 'job.html'), 'utf8');
    const start = job.indexOf('function buildPracticeFactsHtml(role) {');
    const auBranch = job.slice(start, job.indexOf('if (typeof role.dpa === "boolean") {', start));
    expect(auBranch).toContain('window.GPAuJobFacts.rows(auFacts, { showDpa: auPathway !== "au_vr" })');
    expect(auBranch).toContain('return \'<div class="at-sech">The practice</div>\'');
    expect(auBranch).not.toMatch(/overseas-trained|Sponsorship available/);
    expect(job).toContain('/js/au-job-facts.js?v=20261122a');
  });
});

describe('an overseas doctor, switch on: Careers and the job page receive what they always did', () => {
  it('the role list and a role are identical with the switch on and off', async () => {
    const os = add('overseas_null');
    // Opening a role writes its public profile back to the row (the existing
    // enrichment), so open it once first: after that nothing moves.
    await h.get('/api/career/role?id=' + encodeURIComponent(fx.publicId(2)), { cookie: os.cookie });
    const listOn = await h.get('/api/career/roles', { cookie: os.cookie });
    const roleOn = await h.get('/api/career/role?id=' + encodeURIComponent(fx.publicId(2)), { cookie: os.cookie });
    h.setSwitch(false);
    const listOff = await h.get('/api/career/roles', { cookie: os.cookie });
    const roleOff = await h.get('/api/career/role?id=' + encodeURIComponent(fx.publicId(2)), { cookie: os.cookie });
    expect(listOn.status).toBe(200);
    expect(listOn.json).toEqual(listOff.json);
    expect(roleOn.json).toEqual(roleOff.json);
    // And it is today's content: the internal headline and the figures.
    const two = listOn.json.roles.filter((r) => r.id === fx.publicId(2))[0];
    expect(two.practiceName).toBe('DPA - Dubbo - Bulk Billing');
    expect(two.earnings).toBe('$350k - $450k');
    expect(two.auFacts).toBeUndefined();
    expect(two.auTitle).toBeUndefined();
    expect(roleOn.json.role.auTitle).toBeUndefined();
  });

  it('the overseas match popup request and the shell make no new request', () => {
    const popup = fs.readFileSync(path.join(ROOT, 'js', 'match-popup.js'), 'utf8');
    expect(popup).toContain('if (shareConsent) payload.shareConsent = shareConsent;');
    const shell = fs.readFileSync(path.join(ROOT, 'js', 'app-shell.js'), 'utf8');
    expect(shell).toContain('if (applyIntentAsked || !applyIntentFlagged() || typeof window.fetch !== "function") return;');
    expect(shell.match(/apply-intent\/claim/g)).toHaveLength(1);
  });
});
