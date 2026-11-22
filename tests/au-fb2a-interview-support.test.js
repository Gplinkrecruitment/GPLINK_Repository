// Australian GP build, fix bundle FB-2a, W3-D9.
//
// A self-signed-up Australian doctor booked an interview, was told "your GP
// Link consultant joins you", and nobody on staff was told to join (the
// overseas flow tells the doctor's RSO; an Australian case has no RSO before
// pre-start, and a self sign-up has no placing consultant: "Nobody recorded").
//
//   1. The consultant (or CEO) who submits the doctor to a practice becomes the
//      placing consultant when nobody is recorded.
//   2. At booking the placing consultant is told to join; nobody recorded: the
//      CEO and every consultant are told.
//   3. The doctor is promised a person on the call only when someone is told.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const fs = require('fs');
const path = require('path');
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');

let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
const caseOf = (d) => rows('registration_cases').find((c) => c.user_id === d.userId);
const timeline = (d) => rows('task_timeline').filter((e) => e.case_id === d.caseId);
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'i' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  return d;
}

beforeAll(async () => {
  const tables = buildAuFixtureDb([]);
  ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'admin_audit_log', 'runtime_kv', 'gp_nudge_log', 'user_roles'].forEach((n) => { tables[n] = []; });
  h = await bootAuTestServer({ name: 'fb2a-d9', tables });
  t = h.testUtils;
});
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); h.emu.forbid(null); h.emu.reset(); });

describe('the consultant who submits an Australian doctor to a practice takes them on', () => {
  it('nobody recorded: the submitting consultant is recorded, once, with a timeline line', async () => {
    const d = add('au_vr');
    expect(caseOf(d).placing_consultant || null).toBeNull();
    const out = await t.auRecordPlacingConsultantAtSubmission(d.userId, h.CONSULTANT_EMAIL.toUpperCase(), { applicationId: 'app-1', practiceName: 'Test Metro Practice (FAKE)' });
    expect(out).toEqual({ recorded: true, consultant: h.CONSULTANT_EMAIL });
    expect(caseOf(d).placing_consultant).toBe(h.CONSULTANT_EMAIL);
    const line = timeline(d).filter((e) => /^Placing consultant recorded/.test(e.title));
    expect(line).toHaveLength(1);
    expect(line[0].detail).toContain('Test Metro Practice (FAKE)');
    expect(line[0].metadata).toMatchObject({ placing_consultant: h.CONSULTANT_EMAIL, reason: 'submitted_to_practice' });
    // The CEO submitting a second application later does not take the doctor over.
    expect(await t.auRecordPlacingConsultantAtSubmission(d.userId, h.SUPER_EMAIL, {})).toMatchObject({ recorded: false, reason: 'already_recorded' });
    expect(caseOf(d).placing_consultant).toBe(h.CONSULTANT_EMAIL);
    expect(timeline(d).filter((e) => /^Placing consultant recorded/.test(e.title))).toHaveLength(1);
  });

  it('an RSO submitting does not become the placing consultant; two submitters at once record one', async () => {
    const d = add('au_vr');
    expect(await t.auRecordPlacingConsultantAtSubmission(d.userId, h.RSO_EMAIL, {})).toMatchObject({ recorded: false, reason: 'not_a_consultant' });
    expect(caseOf(d).placing_consultant || null).toBeNull();
    const both = await Promise.all([
      t.auRecordPlacingConsultantAtSubmission(d.userId, h.CONSULTANT_EMAIL, {}),
      t.auRecordPlacingConsultantAtSubmission(d.userId, h.SUPER_EMAIL, {})
    ]);
    expect(both.filter((r) => r.recorded)).toHaveLength(1);
    expect(timeline(d).filter((e) => /^Placing consultant recorded/.test(e.title))).toHaveLength(1);
  });

  it('OVERSEAS PARITY: an overseas doctor is never touched; switch off: nothing is asked at all', async () => {
    const os = add('overseas_null');
    expect(await t.auRecordPlacingConsultantAtSubmission(os.userId, h.CONSULTANT_EMAIL, {})).toMatchObject({ recorded: false, reason: 'not_au_pathway' });
    expect(caseOf(os).placing_consultant || null).toBeNull();
    expect(await t.auInterviewSupportFor(os.userId, os.caseId)).toBeNull();
    const au = add('au_vr');
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.auRecordPlacingConsultantAtSubmission(au.userId, h.CONSULTANT_EMAIL, {})).toEqual({ recorded: false, reason: 'feature_off' });
    expect(await t.auInterviewSupportFor(au.userId, au.caseId)).toBeNull();
    expect(h.emu.requests).toEqual([]);
  });
});

describe('who is told to join an Australian doctor\'s interview', () => {
  it('a placing consultant on record: that person', async () => {
    const d = add('au_vr', { caseRow: { placing_consultant: h.CONSULTANT_EMAIL } });
    expect(await t.auInterviewSupportFor(d.userId, d.caseId)).toEqual({ recipients: [h.CONSULTANT_EMAIL], basis: 'placing_consultant', consultant: h.CONSULTANT_EMAIL });
  });

  it('THE REPORTED CASE: nobody recorded -> the CEO and every consultant', async () => {
    const d = add('au_vr');
    const out = await t.auInterviewSupportFor(d.userId, d.caseId);
    expect(out.basis).toBe('nobody_recorded');
    expect(out.recipients).toEqual(expect.arrayContaining([h.CONSULTANT_EMAIL, h.SUPER_EMAIL]));
    expect(out.recipients).not.toContain(h.RSO_EMAIL);
  });
});

describe('the booking handler (source)', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('const bookAuSupport = await auInterviewSupportFor(appCtx.userId, appCtx.caseId);');
  const book = server.slice(start, start + 16000);

  it('asks once, before any message is written', () => {
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(server.indexOf("subject: 'Your interview is confirmed 🎉'"));
  });

  it('emails the people it found "Interview to support", skips anyone the RSO email already reached, and records it on the timeline', () => {
    expect(book).toContain("if (bookAuSupport && bookAuSupport.recipients.length && isEmailConfigured()) {");
    expect(book).toContain("const auSupportTo = bookAuSupport.recipients.filter(function (em) { return em !== bookRsoEmail.toLowerCase(); });");
    expect(book).toContain("subject: 'Interview to support, ' + appCtx.gpName + ' @ ' + (appCtx.practiceName || 'a practice'),");
    expect(book).toContain('nobody is recorded as their placing consultant');
    expect(book).toContain("'Interview booked: staff told to join'");
  });

  it('the doctor is promised a person on the call only when someone is told', () => {
    expect(book).toContain("const bookGpJoinLine = bookAuNobodyToTell");
    expect(book).toContain("? ' A member of the GP Link team will be in touch before the interview.'");
    expect(server).toContain("is locked in for <strong>' + _esc(gpWhen) + '</strong>.' + bookGpJoinLine + (joinUrl ?");
    // An overseas doctor's sentence is the one it always was.
    expect(book).toContain(": ' Your Registration Support Officer will join you, so you\\u2019re never in the room alone.';");
  });

  it('submitting to a practice records the submitter, behind the switch', () => {
    expect(server).toMatch(/if \(auPathwayFlag\.isAuPathwayEnabled\(\)\) \{\s*await auRecordPlacingConsultantAtSubmission\(appRow\.user_id, admin\.email, \{ applicationId, practiceName: inAppPracticeLabel \}\);/);
  });
});
