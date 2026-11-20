// Australian GP build, WP-07: documents, end to end against the real server
// and the in-memory Supabase emulator. No model is ever called: the Australian
// review's model call is replaced with a stub (__setAuDocumentVerifierForTest),
// and any other outbound request is answered with an empty 200 by the harness.
//
// What this file proves:
//   - an Australian doctor's My Documents list, upload, replace and expiry
//   - the indemnity certificate path the report names as acceptance: upload ->
//     stubbed verdict -> approved -> visible in the admin Documents pane
//   - the two review rule books never cross, and a model outage rejects nothing
//   - the admin counts, the CEO drawer slots and staff filing on the doctor's
//     behalf
//   - reconcile-doc-tasks and the staff decision for an Australian document
//   - an existing overseas doctor is answered exactly as before, switch on;
//     and with the switch off nothing Australian exists and nothing new is read
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const fx = require('./helpers/au-fixtures.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const docReq = require('../lib/document-requirements.js');

const CRON = { headers: { Authorization: 'Bearer test-cron-secret' } };
// A date safely in the future that the server's sanity check accepts.
const NEXT_YEAR = (new Date().getUTCFullYear() + 2) + '-06-30';
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% FAKE TEST DOCUMENT, NOT A REAL CERTIFICATE\n%%EOF\n').toString('base64');

let h;
let auVr, auB, overseas, overseasUk;

function docs() { return h.emu.table('user_documents'); }
function tasks() { return h.emu.table('registration_tasks'); }
function rowFor(doctor, key) {
  return docs().filter((r) => r.user_id === doctor.userId && r.document_key === key)[0] || null;
}
function resetRows() {
  docs().length = 0;
  tasks().length = 0;
}
function upload(doctor, key, extra) {
  return h.put('/api/gp/au-documents', Object.assign({
    key, fileName: 'FAKE ' + key + '.pdf', mimeType: 'application/pdf', fileSize: 60, fileDataUrl: PDF
  }, extra || {}), { cookie: h.gpCookie(doctor.email, doctor.userId) });
}
function stubVerdict(byKey) {
  h.testUtils.__setAuDocumentVerifierForTest(async ({ documentKey }) => {
    const v = typeof byKey === 'function' ? byKey(documentKey) : byKey[documentKey];
    if (!v) return { ok: false, message: 'no stub for ' + documentKey };
    return { ok: true, verification: JSON.parse(JSON.stringify(v)) };
  });
}

beforeAll(async () => {
  auVr = fx.buildAuDoctor('au_vr');
  auB = fx.buildAuDoctor('au_restricted');
  overseas = fx.buildAuDoctor('overseas_null');
  // an existing overseas doctor whose country is BLANK (the fallback case)
  overseasUk = fx.buildAuDoctor('overseas_null', {
    idSuffix: '9', profile: { registration_country: '' }, state: { gp_selected_country: '' }
  });
  const tables = fx.buildAuFixtureDb([auVr, auB, overseas, overseasUk]);
  tables.user_documents = [];
  tables.registration_tasks = [];
  tables.task_timeline = [];
  tables.practice_doc_ops = [];
  tables.user_notifications = [];
  tables.user_nudges = [];
  h = await bootAuTestServer({ name: 'wp07', tables, emulator: { rpc: { rate_limit_hit: () => ({ allowed: true }) } } });
});

afterAll(async () => {
  if (h) { h.testUtils.__setAuDocumentVerifierForTest(null); await h.close(); }
});

beforeEach(() => {
  h.setSwitch(true);
  h.testUtils.__setAuDocumentVerifierForTest(null);
  h.emu.violations.length = 0;
  h.emu.forbid(null);
  resetRows();
});

describe('My Documents API for a doctor on an Australian pathway', () => {
  it('lists the Australian set for the doctor\'s pathway: "you provide" and "we prepare", nothing uploaded yet', async () => {
    const res = await h.get('/api/gp/au-documents', { cookie: h.gpCookie(auVr.email, auVr.userId) });
    expect(res.status).toBe(200);
    expect(res.json.set).toBe('au_reg');
    expect(res.json.youProvide.map((i) => i.key)).toEqual(
      docReq.auDocumentRequirements('au_vr').youProvide.map((i) => i.key));
    expect(res.json.weProvide.map((i) => i.key)).toEqual(['offer_contract', 'au_references']);
    expect(res.json.youProvide.every((i) => i.status === 'pending')).toBe(true);
    const ind = res.json.youProvide.find((i) => i.key === 'au_indemnity_certificate');
    expect(ind.canUpload).toBe(true);
    expect(ind.expiryTracked).toBe(true);
    expect(ind.help.steps.length).toBeGreaterThan(0);
    // the CV is the careers CV: shown, never uploaded twice
    const cv = res.json.youProvide.find((i) => i.key === 'career_cv');
    expect(cv.canUpload).toBe(false);
    expect(cv.manageUrl).toBe('/pages/career.html');
    // nothing staff-only reaches the doctor
    expect(res.raw).not.toMatch(/staffLabel|staffSlot|ai_review_state|"pathway"/);
  });

  it('a segment B doctor is also offered the supervision plan, the grant notice and the 19AB letter', async () => {
    const res = await h.get('/api/gp/au-documents', { cookie: h.gpCookie(auB.email, auB.userId) });
    const keys = res.json.youProvide.map((i) => i.key);
    expect(keys).toContain('au_supervision_plan');
    expect(keys).toContain('au_immigration_grant_notice');
    expect(keys).toContain('au_19ab_exemption_letter');
  });

  it('upload stores the file under au_reg, marks it for review and opens ONE review task under the Australian stage', async () => {
    const res = await upload(auVr, 'au_indemnity_certificate');
    expect(res.status).toBe(200);
    expect(res.json.document.status).toBe('under_review');
    const row = rowFor(auVr, 'au_indemnity_certificate');
    expect(row.country_code).toBe('au_reg');
    expect(row.status).toBe('under_review');
    expect(row.storage_path).toBe('users/' + auVr.userId + '/prepared-documents/au_reg/au_indemnity_certificate/current');
    const open = tasks().filter((t) => t.related_document_key === 'au_indemnity_certificate');
    expect(open.length).toBe(1);
    expect(open[0].task_type).toBe('doc_review');
    expect(open[0].related_stage).toBe('prestart');
    expect(open[0].related_stage).not.toBe('ahpra');
    expect(open[0].title).not.toMatch(/AHPRA documents ready/i);

    // replacing it does not open a second task
    await upload(auVr, 'au_indemnity_certificate', { fileName: 'FAKE replacement.pdf' });
    expect(tasks().filter((t) => t.related_document_key === 'au_indemnity_certificate').length).toBe(1);
    expect(docs().filter((r) => r.user_id === auVr.userId && r.document_key === 'au_indemnity_certificate').length).toBe(1);
    expect(rowFor(auVr, 'au_indemnity_certificate').file_name).toMatch(/replacement/);
  });

  it('refuses what is not the doctor\'s to upload', async () => {
    // not in a segment A doctor's set
    expect((await upload(auVr, 'au_supervision_plan')).status).toBe(400);
    // prepared by the team
    expect((await upload(auVr, 'au_references')).status).toBe(400);
    expect((await upload(auVr, 'offer_contract')).status).toBe(400);
    // the careers CV has its own upload
    expect((await upload(auVr, 'career_cv')).status).toBe(400);
    // an overseas key
    expect((await upload(auVr, 'mrcgp_certified')).status).toBe(400);
    // not a file
    expect((await upload(auVr, 'au_wwcc', { fileDataUrl: 'hello' })).status).toBe(400);
    // an executable dressed as a PDF
    const exe = 'data:application/pdf;base64,' + Buffer.from('MZ\x90\x00 not a pdf').toString('base64');
    expect((await upload(auVr, 'au_wwcc', { fileDataUrl: exe })).status).toBe(400);
    expect(docs().length).toBe(0);
  });

  it('the expiry date can be set on an expiry-tracked document, and only there', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    const cookie = h.gpCookie(auVr.email, auVr.userId);
    const ok = await h.post('/api/gp/au-documents/expiry', { key: 'au_indemnity_certificate', expiresAt: '2027-06-30' }, { cookie });
    expect(ok.status).toBe(200);
    expect(rowFor(auVr, 'au_indemnity_certificate').expires_at).toBe('2027-06-30T00:00:00.000Z');
    await upload(auVr, 'au_fellowship_certificate');
    expect((await h.post('/api/gp/au-documents/expiry', { key: 'au_fellowship_certificate', expiresAt: '2027-06-30' }, { cookie })).status).toBe(400);
    expect((await h.post('/api/gp/au-documents/expiry', { key: 'au_wwcc', expiresAt: '2027-06-30' }, { cookie })).status).toBe(404);
    expect((await h.post('/api/gp/au-documents/expiry', { key: 'au_indemnity_certificate', expiresAt: 'soon' }, { cookie })).status).toBe(400);
  });

  it('one doctor cannot read or write another doctor\'s documents', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    const other = await h.get('/api/gp/au-documents', { cookie: h.gpCookie(auB.email, auB.userId) });
    expect(other.json.youProvide.find((i) => i.key === 'au_indemnity_certificate').status).toBe('pending');
  });

  it('GET /api/gp/document-requirements answers an Australian doctor from the Australian set, whatever country is asked for', async () => {
    const cookie = h.gpCookie(auVr.email, auVr.userId);
    for (const q of ['', '?country=uk', '?country=gb', '?country=fr']) {
      const res = await h.get('/api/gp/document-requirements' + q, { cookie });
      expect(res.status).toBe(200);
      expect(res.json.au).toBe(true);
      expect(res.json.country).toBe('au_reg');
      expect(res.json.requirements.institution).toEqual([]);
      expect(res.raw).not.toMatch(/GMC|MRCGP|CCT|Good Standing|certified copy/i);
      expect(res.json.requirements.prepared.map((d) => d.key)).toContain('au_indemnity_certificate');
    }
  });

  it('the overseas "You prepare" upload route refuses a doctor on an Australian pathway (they are never put through the overseas review)', async () => {
    const res = await h.put('/api/prepared-documents', {
      country: 'uk', key: 'mrcgp_certified', fileName: 'FAKE.pdf', mimeType: 'application/pdf', fileSize: 60, fileDataUrl: PDF
    }, { cookie: h.gpCookie(auVr.email, auVr.userId) });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('au_pathway');
    expect(docs().length).toBe(0);
    expect(tasks().length).toBe(0);
  });

  it('APP-25: the deferred qualification-certificate gate says "not gated" for an Australian doctor, explicitly', async () => {
    // Make the accidental route impossible: give the doctor a register status
    // and a UK qualification country, which would gate an overseas doctor.
    const prof = h.emu.table('user_profiles').find((r) => r.user_id === auVr.userId);
    const saved = { register_status: prof.register_status, qualification_country: prof.qualification_country };
    prof.register_status = 'verified';
    prof.qualification_country = 'GB';
    try {
      const res = await h.get('/api/registration/qual-docs-status', { cookie: h.gpCookie(auVr.email, auVr.userId) });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, gated: false, missing: [] });
      // the same record on an overseas doctor IS gated (so the test would catch the skip going missing)
      const o = h.emu.table('user_profiles').find((r) => r.user_id === overseas.userId);
      const oSaved = { register_status: o.register_status, qualification_country: o.qualification_country };
      o.register_status = 'verified'; o.qualification_country = 'GB';
      const gated = await h.get('/api/registration/qual-docs-status', { cookie: h.gpCookie(overseas.email, overseas.userId) });
      Object.assign(o, oSaved);
      expect(gated.json.gated).toBe(true);
      expect(gated.json.missing.length).toBeGreaterThan(0);
    } finally {
      Object.assign(prof, saved);
    }
  });
});

describe('the page itself', () => {
  it('an Australian doctor is sent the Australian page at the My Documents address, never cached', async () => {
    for (const path of ['/pages/my-documents.html?gp_shell=embedded', '/pages/my-documents?gp_shell=embedded', '/pages/MY-DOCUMENTS.html?gp_shell=embedded']) {
      const res = await h.get(path, { cookie: h.gpCookie(auVr.email, auVr.userId) });
      expect(res.status).toBe(200);
      expect(res.raw).toContain('id="auDocumentsRoot"');
      expect(res.raw).not.toContain('panel-direct_to_ahpra');
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('an overseas doctor is sent today\'s page, with today\'s caching', async () => {
    for (const d of [overseas, overseasUk]) {
      const res = await h.get('/pages/my-documents.html?gp_shell=embedded', { cookie: h.gpCookie(d.email, d.userId) });
      expect(res.status).toBe(200);
      expect(res.raw).toContain('panel-direct_to_ahpra');
      expect(res.raw).not.toContain('id="auDocumentsRoot"');
      expect(res.headers['cache-control']).toBe('private, no-cache');
    }
  });

  it('switch off: everyone is sent today\'s page and the pathway is not read', async () => {
    h.setSwitch(false);
    h.emu.forbid((request) => wp02NewNameViolation(request, { columns: fx.WP02_NEW_COLUMN_NAMES, tables: fx.WP02_NEW_TABLES }));
    const res = await h.get('/pages/my-documents.html?gp_shell=embedded', { cookie: h.gpCookie(auVr.email, auVr.userId) });
    expect(res.raw).toContain('panel-direct_to_ahpra');
    expect(h.emu.violations).toEqual([]);
  });
});

describe('automatic review (doc-ai-review job)', () => {
  const goodIndemnity = () => ({
    verified: true, legible: true, documentType: 'Certificate of currency',
    nameFound: auVr.profile.first_name + ' ' + auVr.profile.last_name,
    insurer: 'Test Insurer (FAKE)', coverStart: '2026-07-01', coverEnd: NEXT_YEAR, category: 'General practice'
  });

  it('ACCEPTANCE: an uploaded indemnity certificate passes review (stubbed verdict), is approved, and shows in the admin Documents pane', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    stubVerdict({ au_indemnity_certificate: goodIndemnity() });

    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ ok: true, scanned: 1, approved: 1, rejected: 0, manual: 0, errors: 0, au_reviewed: 1 });

    const row = rowFor(auVr, 'au_indemnity_certificate');
    expect(row.status).toBe('approved');
    expect(row.ai_review_state).toBe('auto_approved');
    expect(row.expires_at).toBe(NEXT_YEAR + 'T00:00:00.000Z'); // the end of cover, read off the certificate
    expect(row.reviewed_by == null).toBe(true);               // a uuid column: never written by the job
    expect(row.google_drive_file_id == null || row.google_drive_file_id === '').toBe(true); // no link-public Drive copy
    // the review task the upload opened is closed
    expect(tasks().filter((t) => t.related_document_key === 'au_indemnity_certificate' && ['open', 'in_progress', 'waiting'].indexOf(t.status) !== -1).length).toBe(0);

    // the doctor sees it approved
    const mine = await h.get('/api/gp/au-documents', { cookie: h.gpCookie(auVr.email, auVr.userId) });
    expect(mine.json.youProvide.find((i) => i.key === 'au_indemnity_certificate').status).toBe('approved');

    // and staff see it in the Documents pane, against the Australian set
    const sa = h.superAdmin();
    const pane = await h.get('/api/admin/gp-documents?case_id=' + auVr.caseId, sa);
    expect(pane.status).toBe(200);
    expect(pane.json.au).toBe(true);
    expect(pane.json.country).toBe('au_reg');
    expect(pane.json.documentSet).toBe('au_reg');
    expect(pane.json.directToAhpra).toEqual([]);
    const card = pane.json.preparedByCandidate.find((d) => d.key === 'au_indemnity_certificate');
    expect(card.status).toBe('approved');
    expect(card.label).toBe('Indemnity certificate of currency');
    expect(card.file_name).toMatch(/FAKE/);
    expect(pane.raw).not.toMatch(/MRCGP|CCT certificate|Certificate of good standing|Confirmation of training|SPPA|Section G|Supervisor CV/);
    expect(pane.json.preparedByGpLink.map((d) => d.key)).toEqual(['offer_contract']);

    // a second run does not look at it again
    const again = await h.get('/api/cron/doc-ai-review', CRON);
    expect(again.json.scanned).toBe(0);
  });

  it('with the model unreachable nothing is rejected: the document stays with a person', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    h.testUtils.__setAuDocumentVerifierForTest(async () => { throw new Error('AI blocked'); });
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json).toMatchObject({ ok: true, scanned: 1, approved: 0, rejected: 0 });
    const row = rowFor(auVr, 'au_indemnity_certificate');
    expect(row.status).toBe('under_review');
    expect(row.ai_review_state).toBe('manual_required');
    expect(row.rejection_reason || '').toBe('');
    expect(tasks().filter((t) => t.related_document_key === 'au_indemnity_certificate' && t.status === 'open').length).toBe(1);
  });

  it('with no stub at all (the harness answers the model call with an empty reply) it also fails safe', async () => {
    await upload(auVr, 'au_wwcc');
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.rejected).toBe(0);
    expect(rowFor(auVr, 'au_wwcc').status).toBe('under_review');
  });

  it('a certificate in somebody else\'s name is never approved by the machine', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    const v = goodIndemnity(); v.nameFound = 'Someone Else';
    stubVerdict({ au_indemnity_certificate: v });
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.approved).toBe(0);
    expect(run.json.rejected).toBe(0);
    expect(rowFor(auVr, 'au_indemnity_certificate').status).toBe('under_review');
  });

  it('an unreadable file is sent back to the doctor with plain wording', async () => {
    await upload(auVr, 'au_wwcc');
    stubVerdict({ au_wwcc: { verified: false, legible: false, documentType: '' } });
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.rejected).toBe(1);
    const row = rowFor(auVr, 'au_wwcc');
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toMatch(/could not read your Working with Children Check/);
    const mine = await h.get('/api/gp/au-documents', { cookie: h.gpCookie(auVr.email, auVr.userId) });
    const item = mine.json.youProvide.find((i) => i.key === 'au_wwcc');
    expect(item.status).toBe('rejected');
    expect(item.note).toBe(row.rejection_reason);
  });

  it('ROUTING: an Australian document goes to the Australian rules only; an overseas doctor\'s qualification goes to the overseas rules only', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    docs().push({
      id: 'doc-overseas-1', user_id: overseas.userId, document_key: 'mrcgp_certified', country_code: 'uk',
      status: 'uploaded', storage_path: 'users/' + overseas.userId + '/prepared-documents/uk/mrcgp_certified/current',
      mime_type: 'application/pdf', file_name: 'FAKE mrcgp.pdf', ai_review_state: null, reviewed_by: null, created_at: '2026-01-01T00:00:00Z'
    });
    const seen = [];
    h.testUtils.__setAuDocumentVerifierForTest(async ({ documentKey, prompt }) => {
      seen.push({ documentKey, text: prompt.system + prompt.user });
      return { ok: true, verification: goodIndemnity() };
    });
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.scanned).toBe(2);
    expect(run.json.au_reviewed).toBe(1);
    // the Australian verifier saw only the Australian document, with Australian rules
    expect(seen.map((s) => s.documentKey)).toEqual(['au_indemnity_certificate']);
    expect(seen[0].text).not.toMatch(/2007|MRCGP|certified true copy/i);
    // the overseas document went down the existing path (the model is unreachable in tests,
    // so it is left for a person; it was NOT approved by the Australian stub)
    const o = docs().find((r) => r.id === 'doc-overseas-1');
    expect(o.status).not.toBe('approved');
    expect(o.ai_review_state).toBe('manual_required');
    expect(rowFor(auVr, 'au_indemnity_certificate').status).toBe('approved');
  });

  it('an Australian doctor is never judged by the overseas rules, and an overseas doctor never by the Australian ones', async () => {
    // an Australian doctor with a stray overseas qualification row
    docs().push({
      id: 'doc-au-stray', user_id: auVr.userId, document_key: 'mrcgp_certified', country_code: 'uk',
      status: 'uploaded', storage_path: 'x/y', ai_review_state: null, reviewed_by: null, created_at: '2026-01-01T00:00:00Z'
    });
    // an overseas doctor with a stray au_reg row
    docs().push({
      id: 'doc-overseas-stray', user_id: overseas.userId, document_key: 'au_indemnity_certificate', country_code: 'au_reg',
      status: 'uploaded', storage_path: 'x/z', ai_review_state: null, reviewed_by: null, created_at: '2026-01-01T00:00:00Z'
    });
    let called = 0;
    h.testUtils.__setAuDocumentVerifierForTest(async () => { called++; return { ok: true, verification: goodIndemnity() }; });
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.scanned).toBe(0);
    expect(called).toBe(0);
    for (const id of ['doc-au-stray', 'doc-overseas-stray']) {
      const r = docs().find((x) => x.id === id);
      expect(r.status).toBe('uploaded');
      expect(r.ai_review_state).toBeNull();
    }
    expect(tasks().length).toBe(0);
  });

  it('switch off: no row is Australian, the pathway is never read, and the overseas path is what it was', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    h.setSwitch(false);
    h.emu.forbid((request) => wp02NewNameViolation(request, { columns: fx.WP02_NEW_COLUMN_NAMES, tables: fx.WP02_NEW_TABLES }));
    let called = 0;
    h.testUtils.__setAuDocumentVerifierForTest(async () => { called++; return { ok: true, verification: goodIndemnity() }; });
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.status).toBe(200);
    expect(run.json.au_reviewed).toBeUndefined();
    expect(called).toBe(0);
    expect(rowFor(auVr, 'au_indemnity_certificate').status).toBe('under_review');
    expect(h.emu.violations).toEqual([]);
  });
});

describe('reconcile-doc-tasks', () => {
  it('an Australian document waiting for a person with no open task gets one, under the Australian stage; nothing overseas is raised', async () => {
    await upload(auVr, 'au_wwcc');
    tasks().length = 0; // the task went missing
    const run = await h.get('/api/cron/reconcile-doc-tasks', CRON);
    expect(run.status).toBe(200);
    const mine = tasks().filter((t) => t.related_document_key === 'au_wwcc');
    expect(mine.length).toBe(1);
    expect(mine[0].task_type).toBe('doc_review');
    expect(mine[0].related_stage).toBe('prestart');
    expect(tasks().every((t) => t.task_type !== 'flagged_doc')).toBe(true);
    expect(JSON.stringify(tasks())).not.toMatch(/AHPRA documents ready/i);
    // idempotent
    await h.get('/api/cron/reconcile-doc-tasks', CRON);
    expect(tasks().filter((t) => t.related_document_key === 'au_wwcc').length).toBe(1);
  });
});

describe('staff side', () => {
  it('ADM-08: the quick qualification snapshot counts an Australian doctor against the Australian set, never "GB 0/3"', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    const snap = await h.testUtils.getUserQualificationSnapshot(auVr.userId, 'GB');
    expect(snap.country).toBe('AU');
    expect(snap.document_set).toBe('au_reg');
    expect(snap.required.map((r) => r.key)).toEqual(['au_ahpra_certificate', 'au_fellowship_certificate', 'au_indemnity_certificate', 'au_right_to_work', 'au_wwcc']);
    expect(snap.uploaded_unverified.map((r) => r.key)).toEqual(['au_indemnity_certificate']);
    expect(snap.missing.length).toBe(4);
    expect(JSON.stringify(snap)).not.toMatch(/MRCGP|CCT|GB/);
  });

  it('parity: an overseas doctor\'s snapshot is today\'s, including the blank-country doctor who reads as GB', async () => {
    const uk = await h.testUtils.getUserQualificationSnapshot(overseasUk.userId, '');
    expect(uk.country).toBe('GB');
    expect(uk.required.map((r) => r.key)).toEqual(['primary_medical_degree', 'mrcgp_certified', 'cct_certified']);
    expect(uk.document_set).toBeUndefined();
    const ie = await h.testUtils.getUserQualificationSnapshot(overseas.userId, 'IE');
    expect(ie.country).toBe('IE');
    expect(ie.required.map((r) => r.key)).toEqual(['primary_medical_degree', 'micgp_certified', 'cscst_certified']);
  });

  it('the shared document-country resolver: au_reg for an Australian doctor, today\'s answer for everyone else', async () => {
    expect(await h.testUtils.resolveGpDocumentCountryForUser(auVr.userId)).toBe('au_reg');
    expect(await h.testUtils.resolveGpDocumentCountryForUser(auB.userId)).toBe('au_reg');
    expect(await h.testUtils.resolveGpDocumentCountryForUser(overseasUk.userId)).toBe('uk'); // legacy fallback, kept
    h.setSwitch(false);
    expect(await h.testUtils.resolveGpDocumentCountryForUser(auVr.userId)).not.toBe('au_reg');
  });

  it('the Documents pane for an overseas doctor is unchanged: three sections, the country list, no Australian keys', async () => {
    const pane = await h.get('/api/admin/gp-documents?case_id=' + overseasUk.caseId, h.superAdmin());
    expect(pane.status).toBe(200);
    expect(pane.json.au).toBeUndefined();
    expect(pane.json.documentSet).toBeUndefined();
    expect(pane.json.country).toBe('uk');
    expect(pane.json.directToAhpra.map((d) => d.key)).toEqual(['certificate_good_standing', 'criminal_history', 'confirmation_training']);
    expect(pane.json.preparedByCandidate.map((d) => d.key)).toEqual(['primary_medical_degree', 'cv_signed_dated', 'mrcgp_certified', 'cct_certified']);
    expect(pane.json.preparedByGpLink.map((d) => d.key)).toEqual(['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']);
    expect(pane.raw).not.toMatch(/au_/);
  });

  it('opening an Australian doctor\'s Documents pane creates no practice-pack rows', async () => {
    h.emu.table('practice_doc_ops').length = 0;
    await h.get('/api/admin/gp-documents?case_id=' + auVr.caseId, h.superAdmin());
    expect(h.emu.table('practice_doc_ops').length).toBe(0);
  });

  it('ADM-13: the CEO drawer gets pathway-aware slots (A: no segment B slots; B: supervision, grant notice, 19AB)', async () => {
    const a = await h.testUtils.auCandidateDocSlots(auVr.userId, await h.testUtils.auDocumentContextForUser(auVr.userId));
    expect(a.map((s) => s.key)).toEqual([
      'au_ahpra_certificate', 'au_fellowship_certificate', 'au_indemnity_certificate', 'au_right_to_work',
      'au_wwcc', 'au_provider_number_letter', 'au_references'
    ]);
    expect(a.every((s) => s.slot === 'au:' + s.key && s.has === false)).toBe(true);
    expect(a.find((s) => s.key === 'au_references').label).toBe('References (two referees)');
    const b = await h.testUtils.auCandidateDocSlots(auB.userId, await h.testUtils.auDocumentContextForUser(auB.userId));
    const bKeys = b.map((s) => s.key);
    expect(bKeys).toContain('au_supervision_plan');
    expect(bKeys).toContain('au_immigration_grant_notice');
    expect(bKeys).toContain('au_19ab_exemption_letter');
    expect(b.find((s) => s.key === 'au_immigration_grant_notice').label).toBe('Visa grant notice');
  });

  it('staff file a document into a slot on the doctor\'s behalf: approved, attributed, no review task, and the doctor sees it', async () => {
    const consultant = h.consultant();
    const res = await h.post('/api/ats/candidate/document', {
      case_id: auVr.caseId, slot: 'au:au_references', fileName: 'FAKE references.pdf', mimeType: 'application/pdf',
      fileSize: 60, fileBase64: PDF.split(',')[1]
    }, consultant);
    expect(res.status).toBe(200);
    const row = rowFor(auVr, 'au_references');
    expect(row.country_code).toBe('au_reg');
    expect(row.status).toBe('approved');
    expect(row.ai_review_state).toBe('staff_filed');
    expect(row.review_notes).toMatch(/on the candidate/);
    expect(tasks().length).toBe(0);
    const mine = await h.get('/api/gp/au-documents', { cookie: h.gpCookie(auVr.email, auVr.userId) });
    expect(mine.json.weProvide.find((i) => i.key === 'au_references').status).toBe('approved');
    const slots = await h.testUtils.auCandidateDocSlots(auVr.userId, await h.testUtils.auDocumentContextForUser(auVr.userId));
    expect(slots.find((s) => s.key === 'au_references').has).toBe(true);
    // the automatic review leaves a staff-filed document alone
    const run = await h.get('/api/cron/doc-ai-review', CRON);
    expect(run.json.scanned).toBe(0);
  });

  it('a slot outside the doctor\'s set is refused: segment B slot for a segment A doctor, any Australian slot for an overseas doctor', async () => {
    const consultant = h.consultant();
    const body = { fileName: 'FAKE.pdf', mimeType: 'application/pdf', fileSize: 60, fileBase64: PDF.split(',')[1] };
    const a = await h.post('/api/ats/candidate/document', Object.assign({ case_id: auVr.caseId, slot: 'au:au_supervision_plan' }, body), consultant);
    expect(a.status).toBe(409);
    const o = await h.post('/api/ats/candidate/document', Object.assign({ case_id: overseas.caseId, slot: 'au:au_indemnity_certificate' }, body), consultant);
    expect(o.status).toBe(409);
    const junk = await h.post('/api/ats/candidate/document', Object.assign({ case_id: auVr.caseId, slot: 'au:mrcgp_certified' }, body), consultant);
    expect(junk.status).toBe(400);
    expect(docs().length).toBe(0);
  });

  it('staff can open a filed document through the dashboard (bytes streamed, audited); a doctor cookie cannot', async () => {
    await upload(auVr, 'au_indemnity_certificate');
    const ok = await h.get('/api/ats/candidate-au-doc?case_id=' + auVr.caseId + '&key=au_indemnity_certificate', h.consultant());
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(ok.headers['content-disposition']).toMatch(/^inline/);
    const none = await h.get('/api/ats/candidate-au-doc?case_id=' + auVr.caseId + '&key=au_wwcc', h.consultant());
    expect(none.status).toBe(404);
    const bad = await h.get('/api/ats/candidate-au-doc?case_id=' + auVr.caseId + '&key=career_cv', h.consultant());
    expect(bad.status).toBe(400);
    const gp = await h.get('/api/ats/candidate-au-doc?case_id=' + auVr.caseId + '&key=au_indemnity_certificate', { cookie: h.gpCookie(auVr.email, auVr.userId) });
    expect([401, 403]).toContain(gp.status);
  });

  it('the Documents-pane upload (sign + finalize) accepts an Australian key only for a doctor on the Australian set', async () => {
    const sa = h.superAdmin();
    const au = await h.post('/api/admin/candidate-doc/sign-upload', { case_id: auVr.caseId, document_key: 'au_wwcc' }, sa);
    expect([200, 502]).toContain(au.status); // 502 = the emulator mints no signed URL; the key was accepted
    const crossA = await h.post('/api/admin/candidate-doc/sign-upload', { case_id: auVr.caseId, document_key: 'mrcgp_certified' }, sa);
    expect(crossA.status).toBe(400);
    const crossB = await h.post('/api/admin/candidate-doc/sign-upload', { case_id: overseasUk.caseId, document_key: 'au_wwcc' }, sa);
    expect(crossB.status).toBe(400);
    const overseasOk = await h.post('/api/admin/candidate-doc/sign-upload', { case_id: overseasUk.caseId, document_key: 'mrcgp_certified' }, sa);
    expect([200, 502]).toContain(overseasOk.status);
  });

  it('labels and stages for staff tasks and doctor emails', () => {
    expect(h.testUtils.getDocumentLabelForKey('au_indemnity_certificate')).toBe('Indemnity certificate of currency');
    expect(h.testUtils.getDocumentLabelForKey('mrcgp_certified')).toBe('MRCGP Certificate');
    expect(h.testUtils.inferStageFromDocKey('au_indemnity_certificate')).toBe('prestart');
    expect(h.testUtils.inferStageFromDocKey('mrcgp_certified')).toBe('ahpra');
    expect(h.testUtils.inferStageFromDocKey('career_cv')).toBe('career');
  });

  it('the old state-based checklist lists no overseas document for an Australian doctor, and is unchanged for everyone else', () => {
    const au = h.testUtils.getCandidateDocuments({}, { au: true });
    expect(JSON.stringify(au)).not.toMatch(/MRCGP|CCT|good standing|SPPA|Section G|Supervisor CV/i);
    const before = h.testUtils.getCandidateDocuments({});
    expect(JSON.stringify(before)).toMatch(/MRCGP certificate/);
    expect(h.testUtils.getDocMetaForCountry('au_reg')).toEqual([]);
    expect(h.testUtils.getDocMetaForCountry('nz').map((m) => m.key)).toContain('frnzcgp_certified');
    expect(h.testUtils.getDocMetaForCountry(undefined).map((m) => m.key)).toContain('mrcgp_certified'); // legacy default, kept
  });
});

describe('an existing overseas doctor, switch on (nothing recorded): exactly as before', () => {
  it('the Australian routes do not exist for them', async () => {
    for (const d of [overseas, overseasUk]) {
      const cookie = h.gpCookie(d.email, d.userId);
      expect((await h.get('/api/gp/au-documents', { cookie })).status).toBe(404);
      expect((await upload(d, 'au_indemnity_certificate')).status).toBe(404);
      expect((await h.get('/api/gp/au-documents/download?key=au_indemnity_certificate', { cookie })).status).toBe(404);
      expect((await h.post('/api/gp/au-documents/expiry', { key: 'au_indemnity_certificate', expiresAt: '2027-01-01' }, { cookie })).status).toBe(404);
    }
    expect(docs().length).toBe(0);
  });

  it('GET /api/gp/document-requirements: the country list, and "unsupported" for a blank country (never a silent UK list)', async () => {
    const uk = await h.get('/api/gp/document-requirements?country=uk', { cookie: h.gpCookie(overseas.email, overseas.userId) });
    expect(uk.status).toBe(200);
    expect(uk.json.au).toBeUndefined();
    expect(uk.json.requirements.prepared.map((d) => d.key)).toEqual(['primary_medical_degree', 'mrcgp_certified', 'cct_certified', 'cv_signed_dated']);
    const blank = await h.get('/api/gp/document-requirements', { cookie: h.gpCookie(overseasUk.email, overseasUk.userId) });
    expect(blank.status).toBe(400);
    expect(blank.json.unsupported).toBe(true);
    expect(blank.json.supported).toEqual(['uk', 'ie', 'nz']);
  });

  it('their "You prepare" upload still works and still files under their own country', async () => {
    const res = await h.put('/api/prepared-documents', {
      country: 'uk', key: 'cv_signed_dated', fileName: 'FAKE cv.pdf', mimeType: 'application/pdf', fileSize: 60, fileDataUrl: PDF
    }, { cookie: h.gpCookie(overseasUk.email, overseasUk.userId) });
    expect(res.status).toBe(200);
    expect(rowFor(overseasUk, 'cv_signed_dated').country_code).toBe('uk');
  });
});

describe('switch off', () => {
  it('none of the Australian routes exist, for anyone, and nothing new is read', async () => {
    h.setSwitch(false);
    h.emu.forbid((request) => wp02NewNameViolation(request, { columns: fx.WP02_NEW_COLUMN_NAMES, tables: fx.WP02_NEW_TABLES }));
    const cookie = h.gpCookie(auVr.email, auVr.userId);
    expect((await h.get('/api/gp/au-documents', { cookie })).status).toBe(404);
    expect((await upload(auVr, 'au_indemnity_certificate')).status).toBe(404);
    expect((await h.get('/api/ats/candidate-au-doc?case_id=' + auVr.caseId + '&key=au_indemnity_certificate', h.consultant())).status).toBe(404);
    const slot = await h.post('/api/ats/candidate/document', {
      case_id: auVr.caseId, slot: 'au:au_references', fileName: 'FAKE.pdf', mimeType: 'application/pdf', fileSize: 60, fileBase64: PDF.split(',')[1]
    }, h.consultant());
    expect(slot.status).toBe(400); // "Unknown document slot", as for any unknown slot
    const sign = await h.post('/api/admin/candidate-doc/sign-upload', { case_id: auVr.caseId, document_key: 'au_wwcc' }, h.superAdmin());
    expect(sign.status).toBe(400);
    // the doctor is an overseas doctor again: the requirements route answers by country
    const req = await h.get('/api/gp/document-requirements?country=uk', { cookie });
    expect(req.json.au).toBeUndefined();
    expect(req.json.country).toBe('uk');
    // staff views
    const pane = await h.get('/api/admin/gp-documents?case_id=' + auVr.caseId, h.superAdmin());
    expect(pane.json.au).toBeUndefined();
    const snap = await h.testUtils.getUserQualificationSnapshot(auVr.userId, 'GB');
    expect(snap.country).toBe('GB');
    await h.get('/api/cron/reconcile-doc-tasks', CRON);
    expect(docs().length).toBe(0);
    expect(h.emu.violations).toEqual([]);
  });
});
