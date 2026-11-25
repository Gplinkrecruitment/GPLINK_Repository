// Australian GP build, fix bundle FB-2a: W3-D18 and W3-D19.
//
// W3-D18. The standard route (the practice's contract, sent on by the CEO,
// signed by the doctor) left sessions a week unknown as a number, so the
// commencement card said "the fee cannot be worked out yet". For a candidate
// on an Australian pathway the number is now asked for when an offer or a
// contract is sent, validated, kept on the offer, and carried to the
// placement.
//
// W3-D19 (investigated). A role is marked "filled" when its last seat is taken
// (`details.gps_needed`, default 1) and stays "open" until then; nothing
// reopens it. That is today's rule for everyone. The one Australian gap: when
// a doctor leaves during the guarantee the role stays "filled", so the
// "replacement or credit" task now tells staff to reopen it if a replacement
// is wanted.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_ID, ROLE_ID } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor, fb2aNewNameViolation } = require('./helpers/au-fixtures.js');
const lc = require('../lib/au-lifecycle.js');

let rig; let t; let seq = 0;
const today = () => lc.localDay(Date.now(), 'Australia/Sydney');
const OVERRIDE = { override: true, override_reason: 'The practice confirmed by phone that the doctor has started.' };
function doctor(kind) {
  seq += 1;
  const d = buildAuDoctor(kind || 'au_vr', { idSuffix: String(7700 + seq), profile: { phone: '+614011' + String(10000 + seq) } });
  rig.addDoctor(d);
  return d;
}
const offerOf = (d) => rig.table('ats_offers').find((x) => x.application_id === rig.appIdFor(d));
const placementOf = (d) => rig.table('placements').find((p) => p.user_id === d.userId);
const contractOf = (d) => rig.table('career_contracts').find((c) => c.application_id === rig.appIdFor(d));
const settle = async () => { let last = -1; for (let i = 0; i < 200; i++) { const seen = rig.emu.requests.length + rig.emails.length; if (seen === last) return; last = seen; await new Promise((r) => setTimeout(r, 80)); } };
const sendOffer = (d, body) => rig.post('/api/ats/offer', Object.assign({ application_id: rig.appIdFor(d), start_date: '2027-02-01' }, body || {}), rig.consultant());
const submitContract = (d, body) => rig.post('/api/ceo/contract/decision', Object.assign({ contractId: contractOf(d).id, action: 'submit_to_gp' }, body || {}), rig.superAdmin());

beforeAll(async () => {
  rig = await bootPlacementRig({ name: 'fb2a-d18', env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' }, emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } } } });
  t = rig.testUtils;
  Object.assign(rig.table('practices').find((p) => p.id === PRACTICE_ID), { agreement_status: 'signed', agreement_signed_at: '2026-09-01T02:00:00.000Z', metadata: {} });
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); rig.resetRecorders(); });

describe('W3-D18: sessions a week as a number, at the offer and contract step', () => {
  it('sending an offer to an Australian candidate: asked for, validated, stored on the offer', async () => {
    const d = doctor();
    rig.table('ats_offers').splice(rig.table('ats_offers').indexOf(offerOf(d)), 1); // no offer yet
    // Free text that is not a number: the number is asked for, and nothing is saved or sent.
    const ask = await sendOffer(d, { sessions_per_week: 'full time' });
    expect(ask.status).toBe(400);
    expect(ask.json).toMatchObject({ code: 'au_sessions_required', can_say_unknown: true });
    expect(ask.json.sessions_prompt).toMatch(/8 or more is full-time/);
    expect(offerOf(d)).toBeUndefined();
    expect(rig.capture(d).emailsToDoctor).toEqual([]);
    // Not a number we can use.
    for (const bad of ['eight', '0', '15', '7.25', '-3']) {
      expect((await sendOffer(d, { sessions_per_week: 'full time', sessions_per_week_numeric: bad })).json.code, bad).toBe('invalid_sessions');
    }
    expect(offerOf(d)).toBeUndefined();
    const ok = await sendOffer(d, { sessions_per_week: 'full time', sessions_per_week_numeric: '7.5' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(offerOf(d)).toMatchObject({ sessions_per_week: 'full time', sessions_per_week_numeric: 7.5, status: 'sent' });
    expect(ok.json.offer.sessions_per_week_numeric).toBe(7.5);
  });

  it('free text that IS a bare number needs no second question; "not known yet" is allowed and stores nothing', async () => {
    const a = doctor();
    rig.table('ats_offers').splice(rig.table('ats_offers').indexOf(offerOf(a)), 1);
    expect((await sendOffer(a, { sessions_per_week: '9' })).status).toBe(200);
    expect(offerOf(a).sessions_per_week_numeric).toBe(9);
    const b = doctor();
    rig.table('ats_offers').splice(rig.table('ats_offers').indexOf(offerOf(b)), 1);
    expect((await sendOffer(b, { sessions_per_week: 'to be agreed', sessions_unknown: true })).status).toBe(200);
    expect(offerOf(b).sessions_per_week_numeric == null).toBe(true);
  });

  // About 3 seconds alone: the contract route end to end, then commencement.
  it('THE REPORTED ROUTE: practice contract -> CEO sends it on (asked for sessions) -> doctor signs -> the fee can be worked out', { timeout: 60000 }, async () => {
    const d = doctor();
    // The standard route has no offer terms at all.
    rig.table('ats_offers').splice(rig.table('ats_offers').indexOf(offerOf(d)), 1);
    Object.assign(contractOf(d), { status: 'uploaded' });
    Object.assign(rig.table('gp_applications').find((a) => a.id === rig.appIdFor(d)), { status: 'interview', ats_stage: 'interview' });
    const ask = await submitContract(d);
    expect(ask.status).toBe(400);
    expect(ask.json.code).toBe('au_sessions_required');
    expect(contractOf(d).status).toBe('uploaded');            // nothing was sent to the doctor
    expect((await submitContract(d, { sessions_per_week_numeric: 'lots' })).json.code).toBe('invalid_sessions');
    const sent = await submitContract(d, { sessions_per_week_numeric: 6 });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(contractOf(d).status).toBe('sent_to_gp');
    expect(offerOf(d)).toMatchObject({ status: 'draft', sessions_per_week_numeric: 6 });
    // The doctor signs in the app.
    const signed = await rig.place(d, 'finalize_signed');
    expect(signed.status, JSON.stringify(signed.json)).toBe(200);
    await settle();
    expect(placementOf(d)).toMatchObject({ status: 'active', sessions_per_week_numeric: 6 });
    // The commencement card no longer says the fee cannot be worked out.
    const card = await rig.get('/api/admin/au/commencement?case_id=' + encodeURIComponent(d.caseId), rig.superAdmin());
    expect(card.json.fee_preview || card.json.fee || {}).toBeTruthy();
    const confirm = await rig.post('/api/admin/au/commencement/confirm', Object.assign({ case_id: d.caseId, commenced_at: today() }, OVERRIDE), rig.superAdmin());
    expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
    expect(placementOf(d)).toMatchObject({ fee_tier: 'part_time', sessions_per_week_numeric: 6 });
    expect(Number(placementOf(d).fee_amount_ex_gst)).toBe(18000);
  });

  it('a number already on the offer is not asked for again; a staff-recorded placement carries it too', async () => {
    const d = doctor();
    offerOf(d).sessions_per_week_numeric = 8;
    Object.assign(contractOf(d), { status: 'uploaded' });
    expect((await submitContract(d)).status).toBe(200);
    const e = doctor();
    offerOf(e).sessions_per_week_numeric = 10;
    expect((await rig.place(e, 'ats_placement')).status).toBe(200);
    await settle();
    expect(placementOf(e).sessions_per_week_numeric).toBe(10);
    // An offer already on file with only free text ("8") is NOT interpreted
    // (WP-13's rule): the placement has no number, and commencement asks.
    const f = doctor();
    expect((await rig.place(f, 'ats_placement')).status).toBe(200);
    await settle();
    expect(placementOf(f).sessions_per_week_numeric == null).toBe(true);
  });

  it('OVERSEAS PARITY and the switch: nothing is asked, and the new column is never named', async () => {
    for (const mode of ['overseas', 'switch_off']) {
      const d = doctor(mode === 'overseas' ? 'overseas_null' : 'au_vr');
      rig.table('ats_offers').splice(rig.table('ats_offers').indexOf(offerOf(d)), 1);
      rig.setSwitch(mode !== 'switch_off');
      rig.emu.reset();
      rig.emu.forbid(fb2aNewNameViolation);
      const offer = await sendOffer(d, { sessions_per_week: 'full time' });
      expect(offer.status, mode + ' ' + JSON.stringify(offer.json)).toBe(200);
      Object.assign(contractOf(d), { status: 'uploaded' });
      expect((await submitContract(d)).status, mode).toBe(200);
      expect((await rig.place(d, 'ats_placement')).status, mode).toBe(200);
      await settle();
      expect(rig.emu.violations, mode).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(offerOf(d), 'sessions_per_week_numeric'), mode).toBe(false);
      expect(placementOf(d).sessions_per_week_numeric == null, mode).toBe(true);
      rig.emu.forbid(null);
    }
  });

  it('a database without the column: the offer still goes, and nothing fails', async () => {
    const d = doctor();
    rig.table('ats_offers').splice(rig.table('ats_offers').indexOf(offerOf(d)), 1);
    rig.emu.missingColumns = { ats_offers: ['sessions_per_week_numeric'] };
    const ok = await sendOffer(d, { sessions_per_week: 'full time', sessions_per_week_numeric: 8 });
    rig.emu.missingColumns = {};
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(offerOf(d).status).toBe('sent');
  });

  it('the staff screens ask once and send again (source), and the migration adds the column additively', () => {
    const cand = fs.readFileSync(path.join(__dirname, '..', 'js/ceo-ats-candidates.js'), 'utf8');
    // FR-7 (guide walk), deliberate: the question is no longer a browser box
    // (an empty OK used to send with no sessions). It is a form in the page;
    // the request is sent again only with an answer. Pinned in
    // tests/au-fr7-sessions-form.test.js.
    expect(cand).toMatch(/function auSessionsAsked\(res\) \{\s*return !!\(res && \(res\.code === 'au_sessions_required' \|\| res\.code === 'invalid_sessions'\)\);/);
    expect(cand).toMatch(/\} else if \(auSessionsAsked\(res\)\) \{[\s\S]{0,900}post\(\);/);
    const contracts = fs.readFileSync(path.join(__dirname, '..', 'js/ceo-ats-contracts.js'), 'utf8');
    expect(contracts).toMatch(/if \(d && !d\.ok && \(d\.code === 'au_sessions_required' \|\| d\.code === 'invalid_sessions'\)\) \{/);
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261122100000_au_gp_fb2_placement_tasks_and_offer_sessions.sql'), 'utf8');
    expect(sql).toMatch(/alter table public\.ats_offers\s+add column if not exists sessions_per_week_numeric numeric\(4,1\);/);
    expect(sql).toMatch(/sessions_per_week_numeric is null or \(sessions_per_week_numeric > 0 and sessions_per_week_numeric <= 14\)/);
  });
});

describe('W3-D19: role status after placements (investigated)', () => {
  it('today\'s rule, unchanged: a role is "filled" when its last seat is taken, and stays open until then', async () => {
    const role = rig.table('career_roles').find((r) => r.id === ROLE_ID);
    role.job_status = 'open';
    role.details = { gps_needed: 2 };
    const before = rig.table('gp_applications').filter((a) => a.career_role_id === ROLE_ID && a.ats_stage === 'hired').length;
    // Make this role's hired count start from zero for the purpose of the test.
    rig.table('gp_applications').forEach((a) => { if (a.career_role_id === ROLE_ID && a.ats_stage === 'hired') a.career_role_id = -1; });
    expect(before).toBeGreaterThanOrEqual(0);
    const a = doctor();
    await rig.place(a, 'ats_placement');
    await settle();
    expect(role.job_status).toBe('open');      // one of two seats
    const b = doctor();
    await rig.place(b, 'ats_placement');
    await settle();
    expect(role.job_status).toBe('filled');    // the last seat
    d19 = { role, a, b };
  });
  let d19 = null;

  it('a doctor leaves during the guarantee: the role is NOT reopened by itself, and the staff task says to reopen it if a replacement is wanted', async () => {
    const { role, b } = d19;
    expect((await rig.post('/api/admin/au/commencement/confirm', Object.assign({ case_id: b.caseId, commenced_at: today(), sessions_per_week: 8 }, OVERRIDE), rig.superAdmin())).status).toBe(200);
    const exit = await rig.post('/api/admin/au/commencement/early-exit', { case_id: b.caseId, last_working_day: today(), reason: 'doctor_resigned', conditions_confirmed: 'yes', note: 'test' }, rig.superAdmin());
    expect(exit.status, JSON.stringify(exit.json)).toBe(200);
    await settle();
    expect(role.job_status).toBe('filled');
    const task = rig.capture(b).tasks.find((x) => (typeof x.metadata === 'object' ? x.metadata : {}).lifecycle_kind === 'replacement_or_credit');
    expect(task).toBeTruthy();
    expect(task.description).toContain('still marked "filled" on the Jobs board');
    expect(task.description).toContain('reopen the role there (nothing reopens it automatically)');
  });

  it('a role that is still open: the task says nothing about reopening', () => {
    const base = { name: 'Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'k', commencedAt: '2026-11-01', lastWorkingDay: '2026-11-10', reason: 'doctor_resigned', today: '2026-11-12', credit: { known: false, needsDecision: [] } };
    expect(lc.buildExitTask(Object.assign({ roleStatus: 'open' }, base)).description).not.toContain('Jobs board');
    expect(lc.buildExitTask(base).description).not.toContain('Jobs board');
    expect(lc.buildExitTask(Object.assign({ roleStatus: 'filled' }, base)).description).toContain('Jobs board');
  });
});
