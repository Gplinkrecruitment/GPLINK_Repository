// FR-7 (guide walk): after an Australian placement the case goes to the default
// RSO for new cases, and nothing said so: the RSO staff expected saw an empty
// list, and neither the CEO nor the placing consultant knew who had the case.
// Now the timeline names the RSO, the placing consultant and the CEO are told
// once by email, and an RSO with no doctors is told why their list is empty.
// Overseas assignment is not changed, and with the switch off none of it exists.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootPlacementRig } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');

const ROOT = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(ROOT, 'pages/admin.html'), 'utf8');
const CEO = 'ceo.fr7@gplink-test.local';
const CONSULTANT = 'consultant.test@gplink-test.local';
const text = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

let rig;
let t;
let seq = 0;
function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(7300 + seq) }, o, {
    profile: Object.assign({ phone: '+614007' + String(10000 + seq), phone_number: '4007' + String(10000 + seq), country_dial: '+61' }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}
const rsoNotices = (cap) => cap.emailsOther.filter((e) => /^Pre-start for /.test(e.subject));
const toOf = (e) => (Array.isArray(e.to) ? e.to : [e.to]).join(',');

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'fr7-rso',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local', CEO_EMAIL: CEO },
    emulator: { defaults: { registration_tasks: { status: 'open' } } }
  });
  t = rig.testUtils;
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); rig.resetRecorders(); });

describe('who has the pre-start work is said, once', () => {
  it('an Australian placement: the timeline names the RSO; the placing consultant and the CEO are each emailed once; nothing goes to the doctor or the practice about it', async () => {
    const d = doctor('au_vr', { profile: { first_name: 'Tess', last_name: 'O\'Brien & Co' } });
    rig.table('registration_cases').find((c) => c.id === d.caseId).placing_consultant = CONSULTANT;
    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    await rig.settle(500);
    const cap = rig.capture(d);
    expect(cap.assignedRso).toBe(rig.RSO_USER_ID);

    const line = cap.timeline.filter((x) => x.title === 'RSO assigned for pre-start');
    expect(line.length).toBe(1);
    expect(String(line[0].detail || line[0].description || JSON.stringify(line[0]))).toContain('Test Rso (rso.test@gplink-test.local)');
    expect(JSON.stringify(line[0])).toContain('the default RSO for new cases');
    expect(JSON.stringify(line[0])).toContain('Assigned RSO');

    const notices = rsoNotices(cap);
    expect(notices.map(toOf).sort()).toEqual([CEO, CONSULTANT].sort());
    for (const n of notices) {
      expect(n.subject).toBe('Pre-start for Dr Tess O\'Brien & Co is with Test Rso');
      const body = text(n.html);
      expect(body).toContain('is with Test Rso (rso.test@gplink-test.local)');
      expect(body).toContain('Assigned RSO');
      expect(body).toContain('Tess O\'Brien & Co');
      // a name with "&" and "'" is escaped once, never twice
      expect(String(n.html)).not.toMatch(/&amp;(amp|#39|quot);/);
      // staff only: no fee, no figure
      expect(body).not.toMatch(/\$|fee|invoice|credit/i);
    }
    expect(cap.emailsToDoctor.filter((e) => /RSO|is with/.test(e.subject))).toEqual([]);
    expect(cap.emailsToPractice.filter((e) => /RSO|is with/.test(e.subject))).toEqual([]);

    // run again (a second sync, the daily pass, a forced re-run): no second notice, no second line
    rig.resetRecorders();
    await t.auRunPlacementHooks(d.userId, { force: true });
    await t.runAuPrestartSweep({});
    await t.assignRsoForPrestart(d.caseId, {});
    await rig.settle(300);
    const again = rig.capture(d);
    expect(rsoNotices(again)).toEqual([]);
    expect(again.timeline.filter((x) => x.title === 'RSO assigned for pre-start').length).toBe(1);
  });

  it('nobody recorded as placing consultant: the CEO alone is told', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    await rig.settle(400);
    expect(rsoNotices(rig.capture(d)).map(toOf)).toEqual([CEO]);
  });

  it('the CEO is the placing consultant: one email, not two', async () => {
    const d = doctor('au_vr');
    rig.table('registration_cases').find((c) => c.id === d.caseId).placing_consultant = CEO;
    await rig.place(d, 'ats_placement');
    await rig.settle(400);
    expect(rsoNotices(rig.capture(d)).map(toOf)).toEqual([CEO]);
  });

  it('a case a person already gave to an RSO keeps that RSO, and nobody is emailed', async () => {
    const d = doctor('au_vr');
    const row = rig.table('registration_cases').find((c) => c.id === d.caseId);
    row.assigned_rso = rig.OTHER_RSO_USER_ID || '00000000-0000-4000-8000-00000000e002';
    row.assigned_va = row.assigned_rso;
    await rig.place(d, 'ats_placement');
    await rig.settle(400);
    const cap = rig.capture(d);
    expect(cap.assignedRso).toBe(row.assigned_rso);
    expect(rsoNotices(cap)).toEqual([]);
    expect(cap.timeline.filter((x) => x.title === 'RSO assigned for pre-start')).toEqual([]);
  });

  it('an OVERSEAS placement: no such email, no such line, and the assignment is whatever it was', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: String(7390 + (seq += 1)), profile: { phone: '+447700933' + String(100 + seq) }, caseRow: { stage: 'career' },
      state: { gp_epic_progress: { stage: 'verification_issued', completed: { verification_issued: true } }, gp_amc_progress: { completed: { qualifications_verified: true } }, gp_career_state: { career_secured: false, applications: [] } } });
    rig.addDoctor(d);
    const before = rig.capture(d).assignedRso;
    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    await rig.settle(500);
    const cap = rig.capture(d);
    expect(rsoNotices(cap)).toEqual([]);
    expect(cap.timeline.filter((x) => x.title === 'RSO assigned for pre-start')).toEqual([]);
    expect(cap.assignedRso).toBe(before);
  });

  it('switch off: the function does nothing and sends nothing', async () => {
    const d = doctor('au_vr');
    rig.setSwitch(false);
    const before = rig.emu.requests.length;
    expect(await t.assignRsoForPrestart(d.caseId, {})).toMatchObject({ ok: false, assigned: false, reason: 'feature_off' });
    expect(rig.emu.requests.length).toBe(before);
    expect(rsoNotices(rig.capture(d))).toEqual([]);
  });
});

describe('the cases list tells the staff page who the default RSO is', () => {
  it('switch on: an extra block with the default RSO\'s name; switch off: the reply has exactly the two keys it always had', async () => {
    const on = await rig.get('/api/admin/cases', rig.superAdmin());
    expect(on.status).toBe(200);
    expect(on.json.au).toEqual({ default_rso_name: 'Test Rso' });
    rig.setSwitch(false);
    let off;
    try { off = await rig.get('/api/admin/cases', rig.superAdmin()); } finally { rig.setSwitch(true); }
    expect(Object.keys(off.json).sort()).toEqual(['cases', 'ok']);
    // the list itself is the same either way
    const ids = (r) => r.json.cases.map((c) => c.id).sort();
    expect(ids(on)).toEqual(ids(off));
  });
});

describe('the RSO\'s empty list explains itself (pages/admin.html)', () => {
  // renderCaseList's empty branch, lifted from the page and run with stand-ins.
  function emptyState(S, isSa) {
    const a = adminHtml.indexOf('    if(!list.length){\n      // FR-7 (guide walk)');
    const b = adminHtml.indexOf('/* Split into priority lanes */', a);
    expect(a).toBeGreaterThan(0);
    const el = { innerHTML: '' };
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // eslint-disable-next-line no-new-func
    new Function('S', 'el', 'list', 'isSA', 'esc', '(function(){' + adminHtml.slice(a, b) + '})();')(S, el, [], () => isSa, esc);
    return el.innerHTML;
  }

  it('an RSO with no doctors, switch on: told that new cases go to the default RSO and how to get one assigned', () => {
    const html = emptyState({ cases: [], dashboard: {}, casesAu: { default_rso_name: 'Test Admin Pool (FAKE)' } }, false);
    expect(html).toContain('data-au-empty-rso="1"');
    expect(html).toContain('No doctors are assigned to you yet.');
    expect(html).toContain('A new case goes to Test Admin Pool (FAKE) first');
    expect(html).toContain('Assigned RSO');
  });

  it('a name with markup is escaped', () => {
    expect(emptyState({ cases: [], dashboard: {}, casesAu: { default_rso_name: '<b>x</b>' } }, false)).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('unchanged: switch off (no block), the CEO, a filter that hides every case, and the loading state', () => {
    expect(emptyState({ cases: [], dashboard: {}, casesAu: null }, false)).toBe('<div class="empty">No cases match filter.</div>');
    expect(emptyState({ cases: [], dashboard: {}, casesAu: { default_rso_name: 'X' } }, true)).toBe('<div class="empty">No cases match filter.</div>');
    expect(emptyState({ cases: [{ id: 1 }], dashboard: {}, casesAu: { default_rso_name: 'X' } }, false)).toBe('<div class="empty">No cases match filter.</div>');
    expect(emptyState({ cases: [], dashboard: null, casesAu: null }, false)).toBe('<div class="empty">Loading...</div>');
  });
});
