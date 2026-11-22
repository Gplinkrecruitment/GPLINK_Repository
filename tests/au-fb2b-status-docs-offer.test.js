// FB-2b:
//   W3-D5         ONE true status per application for an Australian doctor
//   W3-D17 (R7)   My Documents wording per state; the Australian file is not
//                 served at its own address
//   W3-D20        the offer review screen names what is being signed
//   W3-D23        the apply sheet is shown once; the practice is named after
//                 applying
// Part 1 is pure. Part 2 runs the real server against the in-memory database.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const status = require('../lib/au-application-status.js');
const gpApp = require('../lib/au-gp-app.js');
const docsPage = require('../js/my-documents-au.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');
const { bootPlacementRig, PRACTICE_NAME, START_DATE, appIdFor } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');

const S = status.auApplicationStatus;

describe('W3-D5: one status, with the order of precedence written down', () => {
  const booked = { status: 'booked', scheduledAt: '2026-11-26T06:30:00Z' };
  const done = { status: 'completed', scheduledAt: '2026-11-26T06:30:00Z' };
  it('the five points the walk named, in order', () => {
    // interview to choose -> booked -> done, awaiting the practice -> offer received -> signed, secured
    expect(S({ storedStatus: 'interview', atsStage: 'interview', practiceDecision: 'approved' })).toMatchObject({ key: 'interview_to_choose', status: 'interview', statusLabel: 'Choose your interview time', interviewBookable: true });
    expect(S({ storedStatus: 'interview', atsStage: 'interview', practiceDecision: 'approved', interview: booked })).toMatchObject({ key: 'interview_booked', status: 'interview', statusLabel: 'Interview booked', interviewBookable: false });
    expect(S({ storedStatus: 'interview_completed', atsStage: 'interview', interview: done })).toMatchObject({ key: 'interview_done', status: 'interview_completed', statusLabel: 'Interview done: waiting to hear from the practice' });
    expect(S({ storedStatus: 'offer', atsStage: 'offer', interview: done, contractStage: 'sent_to_gp' })).toMatchObject({ key: 'offer_received', status: 'offer', statusLabel: 'Offer received: review and sign', cta: 'offer', ctaLabel: 'Review and sign' });
    expect(S({ storedStatus: 'placement_secured', atsStage: 'hired', interview: done, contractStage: 'signed', secured: true })).toMatchObject({ key: 'placement_secured', statusLabel: 'Signed: placement secured' });
  });
  it('THE BUG: an accepted interview invitation is never "offer accepted". The standard status is ignored for it', () => {
    // After booking, the standard code answers `finalising_placement` because the
    // practice's invitation (an ats_offers row) is "accepted". Before any contract:
    expect(S({ storedStatus: 'interview', atsStage: 'interview', practiceDecision: 'approved', payloadStatus: 'finalising_placement', interview: booked }).key).toBe('interview_booked');
    // After the interview:
    expect(S({ storedStatus: 'interview_completed', atsStage: 'interview', payloadStatus: 'finalising_placement', interview: done }).key).toBe('interview_done');
    // After the contract is sent, before any signature:
    expect(S({ storedStatus: 'offer', atsStage: 'offer', payloadStatus: 'finalising_placement', interview: done, contractStage: 'sent_to_gp' }).key).toBe('offer_received');
    // No status this function can return says "accepted" or "finalising".
    Object.keys(status.VIEW).forEach((k) => expect(status.VIEW[k].label + ' ' + status.VIEW[k].blurb, k).not.toMatch(/offer accepted|finalising/i));
  });
  it('each field outranks the ones below it', () => {
    const everything = { storedStatus: 'offer', atsStage: 'offer', practiceDecision: 'approved', interview: done, interviewCompletedAt: '2026-11-22T00:00:00Z' };
    expect(S(Object.assign({}, everything, { contractStage: 'signed' })).key).toBe('contract_signed');
    expect(S(Object.assign({}, everything, { contractStage: 'changes_requested' })).key).toBe('offer_changes');
    expect(S(Object.assign({}, everything, { contractStage: 'practice_review' })).key).toBe('offer_changes');
    expect(S(everything).key).toBe('offer_preparing');                       // interview done, offer stage, no contract with the doctor yet
    expect(S(Object.assign({}, everything, { atsStage: 'interview', storedStatus: 'interview_completed' })).key).toBe('interview_done');
    expect(S({ storedStatus: 'interview', atsStage: 'interview', interview: { status: 'no_show', scheduledAt: 'x' } }).key).toBe('interview_missed');
    expect(S({ storedStatus: 'applied', atsStage: 'reviewing' }).key).toBe('reviewing');
    expect(S({ storedStatus: 'applied', atsStage: 'submitted' }).key).toBe('submitted');
    expect(S({ storedStatus: 'applied', atsStage: 'new' }).key).toBe('under_review');
    // terminal answers win over everything
    expect(S(Object.assign({}, everything, { contractStage: 'sent_to_gp', storedStatus: 'withdrawn' })).key).toBe('withdrawn');
    expect(S(Object.assign({}, everything, { contractStage: 'sent_to_gp', atsStage: 'not_proceeding' })).key).toBe('not_proceeding');
    expect(S(Object.assign({}, everything, { payloadStatus: 'placement_ended', secured: false })).key).toBe('placement_ended');
    expect(S(Object.assign({}, everything, { payloadStatus: 'placement_complete' })).key).toBe('placement_complete');
    expect(S(Object.assign({}, everything, { contractStage: 'sent_to_gp', secured: true })).key).toBe('placement_secured');
  });
  it('an unanswered match is not an application: nothing is said about it here', () => {
    expect(S({ pendingMatch: true, storedStatus: 'matched' })).toBeNull();
    expect(S({ storedStatus: 'shortlisted' })).toBeNull();
  });
  it('one status at a time: the time picker is offered in exactly one, and "Review offer" (the old flow) in none', () => {
    const all = [
      { storedStatus: 'applied' }, { atsStage: 'submitted' }, { atsStage: 'reviewing' }, { atsStage: 'interview' },
      { atsStage: 'interview', interview: booked }, { atsStage: 'interview', interview: done }, { atsStage: 'offer', interview: done },
      { atsStage: 'offer', interview: done, contractStage: 'sent_to_gp' }, { atsStage: 'offer', contractStage: 'changes_requested' },
      { contractStage: 'signed' }, { secured: true }
    ].map(S);
    expect(all.filter((x) => x.interviewBookable).map((x) => x.key)).toEqual(['interview_to_choose']);
    expect(all.every((x) => x.offerPending === false)).toBe(true);
    expect(new Set(all.map((x) => x.key)).size).toBe(all.length);
  });
  it('no banned word, no dollar figure and no percentage in anything a doctor reads from it', () => {
    const words = Object.keys(status.VIEW).map((k) => [status.VIEW[k].label, status.VIEW[k].ribbon, status.VIEW[k].blurb, status.VIEW[k].ctaLabel].join(' ')).join(' ');
    expect(bannedIn(words)).toEqual([]);
    expect(words).not.toMatch(/\$|%|Registration Support Officer/);
  });
});

describe('W3-D5: the pages draw that one status (Australian doctors only)', () => {
  const career = read('pages/career.html');
  const detail = read('pages/application-detail.html');
  it('Careers: `auStatus` survives both allow-lists and is read before the per-field branches', () => {
    expect(career).toContain('auStatus: source.auStatus && typeof source.auStatus === "object" && source.auStatus.key ? source.auStatus : null,');
    expect(career).toContain('auStatus: app.auStatus || null,');
    const at = career.indexOf('const auOne = auDoctorInfo && app.auStatus && app.auStatus.key ? app.auStatus : null;');
    expect(at).toBeGreaterThan(0);
    // before the branch that said "OFFER ACCEPTED: we're finalising the paperwork"
    expect(at).toBeLessThan(career.indexOf('label: "Offer accepted", ribbon: "OFFER ACCEPTED"'));
    // that branch is still there, untouched, for everyone else
    expect(career).toContain('blurb: "We\'re finalising the paperwork — your placement page unlocks shortly."');
  });
  it('Careers never answers an Australian doctor from the tab\'s saved copy of the list (the "first load is stale" half of W3-D5)', () => {
    const at = career.indexOf('async function loadRemoteApplications(options = {}) {');
    const fn = career.slice(at, career.indexOf('mergeRemoteApplications(payload, shouldRender);', at));
    expect(fn).toContain('if (auDoctorInfo) options = Object.assign({}, options, { forceNetwork: true });');
    // before the cache is consulted
    expect(fn.indexOf('if (auDoctorInfo) options =')).toBeLessThan(fn.indexOf('if (options.forceNetwork) {'));
    // the saved copy is still what everyone else gets
    expect(fn).toContain('payload = await gpCacheFetch("/api/career/applications", {\n            onUpdate: function (freshData) { mergeRemoteApplications(freshData, true); }');
  });
  it('application detail: the cards are put in step with the one status', () => {
    expect(detail).toContain("var auOne = (auFmt() && app.auStatus && app.auStatus.key) ? app.auStatus : null;");
    expect(detail).toContain("if (auAfterInterview && auNoteEl) { auNoteEl.textContent = \"\"; auNoteEl.hidden = true; }");
    expect(detail).toContain("if (interviewCard && !interviewObj && auOne.key !== 'interview_to_choose') interviewCard.hidden = true;");
    expect(detail).toContain("var auOfferOn = ['offer_received', 'offer_changes', 'contract_signed'].indexOf(auOne.key) !== -1;");
    expect(detail).toContain("offerCard.style.setProperty('display', auOfferOn ? 'block' : 'none');");
  });
});

describe('W3-D17 (R7): My Documents says the right thing for each state', () => {
  it('four states, four sentences; only a doctor who can apply is told the CV is all that is needed', () => {
    const held = gpApp.documentsLead('held');
    const looking = gpApp.documentsLead('looking');
    const placed = gpApp.documentsLead('placed', { practiceName: 'Test Metro Practice (FAKE)' });
    const started = gpApp.documentsLead('started', { practiceName: 'Test Metro Practice (FAKE)' });
    expect(looking.lead).toBe('Upload these when you have them. Only your CV is needed to apply for roles; the rest we ask for once you have accepted a position.');
    expect(held.lead).not.toMatch(/apply for roles|Only your CV/);
    expect(held.lead).toMatch(/^You do not need to upload anything yet\./);
    expect(placed.lead).toBe('These are the documents we need before your first day at Test Metro Practice (FAKE). The ones marked "Needed before you start" are on your pre-start checklist too: upload each one once, in either place.');
    expect(placed.lead).not.toMatch(/apply for roles/);
    expect(started.lead).toMatch(/^This is what we hold on file for you\./);
    expect(started.lead).toMatch(/end date/);
    expect(started.lead).not.toMatch(/apply for roles|before your first day/);
    expect([held.state, looking.state, placed.state, started.state]).toEqual(['held', 'looking', 'placed', 'started']);
    expect(gpApp.documentsLead('nonsense').state).toBe('looking');
    expect(bannedIn([held.lead, looking.lead, placed.lead, started.lead].join(' '))).toEqual([]);
  });
  it('the page draws the server\'s sentence', () => {
    const item = { key: 'career_cv', label: 'CV', provider: 'you', status: 'approved' };
    const html = docsPage._viewHtml({ youProvide: [item], weProvide: [], state: 'held', lead: gpApp.documentsLead('held').lead }, 'you', Date.now());
    expect(html).toContain('data-aud-lead="held"');
    expect(htmlText(html)).toContain('You do not need to upload anything yet.');
    expect(htmlText(html)).not.toContain('Only your CV is needed');
    // a response with no sentence keeps the old one
    expect(htmlText(docsPage._viewHtml({ youProvide: [item], weProvide: [] }, 'you', Date.now()))).toContain('Only your CV is needed to apply for roles');
  });
});

describe('W3-D23: the apply sheet is shown once, and the practice is named after applying', () => {
  const job = read('pages/job.html');
  it('an Australian doctor whose sheet cannot be complete yet is asked what is needed first; everyone else opens the sheet as before', () => {
    const at = job.indexOf('if (auDoctorOnPage() && !currentShareConsentSheet()) { auAskWhatIsNeeded(); return; }');
    expect(at).toBeGreaterThan(0);
    const fn = job.slice(job.lastIndexOf('function applyForRole() {', at), job.indexOf('\n  }\n', at));
    expect(fn).toContain('openApplyConfirm();');
    expect(fn.indexOf('auAskWhatIsNeeded();')).toBeLessThan(fn.indexOf('openApplyConfirm();'));
    // the question goes through the ONE body builder (it carries the agreement whenever it has been given)
    const ask = job.slice(job.indexOf('async function auAskWhatIsNeeded() {'), job.indexOf('\n  }\n', job.indexOf('async function auAskWhatIsNeeded() {')));
    expect(ask).toContain('body: applyRequestBody()');
    expect(ask).toContain('handleApplyOutcome(res.status, data, {});');
    // the sheet with the agreement still opens from the server's "agreement needed" answer, and from nowhere else new
    expect(job).toContain('if (currentShareConsentSheet()) openApplyConfirm();');
    expect((job.match(/openApplyConfirm\(\);/g) || []).length).toBe(3);   // the standard open, the fallback when the server cannot be asked, and the agreement answer
  });
  it('after applying the role is read again and drawn as the server now sends it (Australian doctors only)', () => {
    expect(job).toContain('if (auDoctorOnPage()) auRefreshRoleAfterApply();');
    const fn = job.slice(job.indexOf('async function auRefreshRoleAfterApply() {'), job.indexOf('\n  }\n', job.indexOf('async function auRefreshRoleAfterApply() {')));
    expect(fn).toContain('const fresh = await loadRoleDetail(roleId, 25000, { bypassCache: true });');
    expect(fn).toContain('currentRole = mergeRoleData(currentRole, fresh);');
    // the masking rule itself is not on this page and is unchanged: a masked role is still drawn masked
    expect(job).toContain("const named = !!(role && role.nameRevealed && role.realPracticeName);");
    expect(job).toContain('PRACTICE NAME &middot; UNLOCKS WITH YOUR CV');
  });
});

// ── the real server ────────────────────────────────────────────────────────
describe('the real server: status, documents, offer summary', () => {
  let rig;
  const au = buildAuDoctor('au_vr', { credentials: { staff_verified_at: '2026-11-20T02:00:00.000Z', staff_verified_by: 'consultant.test@gplink-test.local' } });
  const held = buildAuDoctor('au_restricted');
  const uk = buildAuDoctor('overseas_null');
  const as = (d) => ({ cookie: rig.gpCookie(d.email, d.userId) });
  const appRow = (d) => rig.table('gp_applications').find((a) => a.id === appIdFor(d));
  const offerRow = (d) => rig.table('ats_offers').find((o) => o.application_id === appIdFor(d));
  const contractRow = (d) => rig.table('career_contracts').find((c) => c.application_id === appIdFor(d));
  const listed = async (d) => ((await rig.get('/api/career/applications', as(d))).json.applications || []).find((a) => a.id === appIdFor(d));
  const one = async (d) => (await rig.get('/api/career/application?id=' + encodeURIComponent(appIdFor(d)), as(d))).json.application;
  // Put BOTH doctors' applications at the same point of the pipeline.
  function setPoint(point) {
    for (const d of [au, uk]) {
      const a = appRow(d); const o = offerRow(d); const c = contractRow(d);
      rig.table('scheduled_calls').forEach((r) => { if (r.application_id === a.id) r.status = 'cancelled'; });
      Object.assign(a, { status: 'interview', ats_stage: 'interview', practice_decision: 'approved', revealed: true, interview_completed_at: null });
      o.status = 'sent'; c.status = 'void';
      const call = (status) => rig.table('scheduled_calls').push({ id: 'iv-' + point + '-' + d.userId.slice(-6), application_id: a.id, user_id: d.userId, meeting_kind: 'interview', status, scheduled_at: '2026-11-26T06:30:00.000Z', duration_minutes: 30, timezone: 'Australia/Perth', zoom_join_url: 'https://zoom.us/j/1?pwd=fake', practice_availability_status: 'received', practice_availability_windows: [] });
      if (point === 'booked') { o.status = 'accepted'; call('booked'); }
      if (point === 'done') { o.status = 'accepted'; call('completed'); a.status = 'interview_completed'; a.interview_completed_at = '2026-11-26T07:00:00.000Z'; }
      if (point === 'contract_sent') { o.status = 'accepted'; call('completed'); Object.assign(a, { status: 'offer', ats_stage: 'offer', interview_completed_at: '2026-11-26T07:00:00.000Z' }); c.status = 'sent_to_gp'; }
    }
  }

  beforeAll(async () => {
    rig = await bootPlacementRig({ name: 'fb2b-status', doctors: [au, held, uk] });
    rig.setSwitch(true);
  }, 60000);
  afterAll(async () => { if (rig) await rig.close(); });
  beforeEach(() => { rig.setSwitch(true); });

  it('interview booked: the Australian doctor is told "Interview booked", in the list and on the application', async () => {
    setPoint('booked');
    for (const got of [await listed(au), await one(au)]) {
      expect(got).toMatchObject({ status: 'interview', statusLabel: 'Interview booked', offerPending: false });
      expect(got.auStatus).toMatchObject({ key: 'interview_booked', label: 'Interview booked', ribbon: 'INTERVIEW BOOKED' });
    }
  });
  it('interview done: "waiting to hear from the practice"', async () => {
    setPoint('done');
    for (const got of [await listed(au), await one(au)]) {
      expect(got).toMatchObject({ status: 'interview_completed', statusLabel: 'Interview done: waiting to hear from the practice' });
      expect(got.auStatus.key).toBe('interview_done');
    }
    expect((await one(au)).interviewBookable).toBe(false);
  });
  it('contract sent, not signed: "Offer received: review and sign" and nothing says accepted', async () => {
    setPoint('contract_sent');
    for (const got of [await listed(au), await one(au)]) {
      expect(got).toMatchObject({ status: 'offer', statusLabel: 'Offer received: review and sign', contractStage: 'sent_to_gp', offerPending: false });
      expect(got.auStatus).toMatchObject({ key: 'offer_received', cta: 'offer', ctaLabel: 'Review and sign' });
      expect(JSON.stringify(got)).not.toMatch(/finalising|Offer accepted/i);
    }
  });
  it('OVERSEAS: unchanged, switch on and off, with no `auStatus`: once the contract is sent the status still says "Offer accepted: finalising your placement" (the live bug)', async () => {
    const capture = async () => {
      const out = {};
      for (const point of ['booked', 'done', 'contract_sent']) {
        setPoint(point);
        const l = await rig.get('/api/career/applications', as(uk));
        const o = await rig.get('/api/career/application?id=' + encodeURIComponent(appIdFor(uk)), as(uk));
        out[point] = [l.raw, o.raw];
      }
      return out;
    };
    const on = await capture();
    rig.setSwitch(false);
    let off;
    try { off = await capture(); } finally { rig.setSwitch(true); }
    expect(on).toEqual(off);
    for (const point of ['booked', 'done', 'contract_sent']) {
      expect(on[point][0], point).not.toContain('auStatus');
      expect(on[point][1], point).not.toContain('auStatus');
    }
    // The standard status only consults the offer row once the application is
    // at the offer stage. Up to then it is right:
    expect(JSON.parse(on.booked[0]).applications[0]).toMatchObject({ status: 'interview', statusLabel: 'Interview stage' });
    expect(JSON.parse(on.done[0]).applications[0].status).toBe('interview_completed');
    // ...and from the moment the contract is sent it reads the accepted
    // INTERVIEW INVITATION as an accepted employment offer, before any signature:
    expect(JSON.parse(on.contract_sent[0]).applications[0]).toMatchObject({ status: 'finalising_placement', statusLabel: 'Offer accepted — finalising your placement', contractStage: 'sent_to_gp' });
    // and an Australian doctor's own record is an overseas doctor's while the switch is off
    rig.setSwitch(false);
    try { expect(JSON.stringify(await listed(au))).not.toContain('auStatus'); } finally { rig.setSwitch(true); }
  });

  it('W3-D20: the offer review screen is told what is being signed; an overseas doctor\'s answer has no such key', async () => {
    setPoint('contract_sent');
    Object.assign(offerRow(au), { sessions_per_week_numeric: 8 });
    const res = await rig.get('/api/career/contract?applicationId=' + encodeURIComponent(appIdFor(au)), as(au));
    expect(res.status).toBe(200);
    expect(res.json.contract.auSummary).toMatchObject({ practiceName: PRACTICE_NAME, role: 'General Practitioner', location: 'Parramatta, NSW', startDate: START_DATE, sessionsPerWeek: 8 });
    expect(res.json.contract.auSummary.rows).toEqual([
      { key: 'practice', label: 'Practice', value: PRACTICE_NAME },
      { key: 'role', label: 'Role', value: 'General Practitioner, Parramatta, NSW' },
      { key: 'start_date', label: 'Proposed start date', value: START_DATE, date: true },
      { key: 'sessions', label: 'Sessions a week', value: '8' }
    ]);
    // nothing invented, nothing "Pending", no money
    const raw = JSON.stringify(res.json.contract.auSummary);
    expect(raw).not.toMatch(/Pending|\$|%|70/);
    expect(bannedIn(raw)).toEqual([]);
    // the internal listing title never reaches the doctor from here
    expect(raw).not.toContain('Non-DPA');
    // a fact that is not on file is simply absent
    Object.assign(offerRow(au), { sessions_per_week_numeric: null, start_date: null });
    const bare = (await rig.get('/api/career/contract?applicationId=' + encodeURIComponent(appIdFor(au)), as(au))).json.contract.auSummary;
    expect(bare.rows.map((r) => r.key)).toEqual(['practice', 'role']);
    // not revealed: the practice is not named
    appRow(au).revealed = false;
    expect((await rig.get('/api/career/contract?applicationId=' + encodeURIComponent(appIdFor(au)), as(au))).json.contract.auSummary.rows.map((r) => r.key)).toEqual(['role']);
    appRow(au).revealed = true;
    const ukOn = await rig.get('/api/career/contract?applicationId=' + encodeURIComponent(appIdFor(uk)), as(uk));
    expect(ukOn.raw).not.toContain('auSummary');
    rig.setSwitch(false);
    try {
      const strip = (s) => s.replace(/token=[^"&]+/g, 'token=x').replace(/"(contractUrl|url)":"[^"]*"/g, '"$1":"u"');
      const ukOff = await rig.get('/api/career/contract?applicationId=' + encodeURIComponent(appIdFor(uk)), as(uk));
      expect(strip(ukOff.raw)).toBe(strip(ukOn.raw));
      expect((await rig.get('/api/career/contract?applicationId=' + encodeURIComponent(appIdFor(au)), as(au))).raw).not.toContain('auSummary');
    } finally { rig.setSwitch(true); }
  });
  it('W3-D20: the page shows the facts for an Australian doctor only, with readable helper text', () => {
    const html = read('pages/offer-review.html');
    expect(html).toContain('<dl class="au-offer-facts" id="auOfferFacts" hidden></dl>');
    expect(html).toContain('auRenderOfferFacts(contract);');
    expect(html).toContain("if (!rows.length) { host.hidden = true; host.innerHTML = ''; return; }");
    expect(html).toContain('html.gp-au-doctor #contractState .agr-small,');
    expect(html).toContain('.au-offer-facts[hidden] { display:none; }');
    // the links were #475569 on a dark page; they keep that colour for everyone else
    expect(html).toContain("font-size:12.5px; color:#475569; text-decoration:underline; cursor:pointer; text-align:left; }");
  });

  it('W3-D17: GET /api/gp/au-documents says which state, and the sentence that goes with it', async () => {
    const heldRes = (await rig.get('/api/gp/au-documents', as(held))).json;
    expect(heldRes).toMatchObject({ ok: true, state: 'held' });
    expect(heldRes.lead).not.toMatch(/Only your CV|apply for roles/);
    const looking = (await rig.get('/api/gp/au-documents', as(au))).json;
    expect(looking).toMatchObject({ state: 'looking' });
    expect(looking.lead).toMatch(/Only your CV is needed to apply for roles/);
    // placed
    setPoint('contract_sent');
    expect((await rig.place(au, 'ats_placement')).status).toBe(200);
    await rig.settle(120);
    const placed = (await rig.get('/api/gp/au-documents', as(au))).json;
    expect(placed).toMatchObject({ state: 'placed' });
    expect(placed.lead).toContain('before your first day at ' + PRACTICE_NAME);
    // started
    const row = rig.table('placements').find((p) => p.user_id === au.userId);
    Object.assign(row, { commenced_at: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) });
    const started = (await rig.get('/api/gp/au-documents', as(au))).json;
    expect(started).toMatchObject({ state: 'started' });
    expect(started.lead).toMatch(/^This is what we hold on file for you\./);
    // the route does not exist for an overseas doctor
    expect((await rig.get('/api/gp/au-documents', as(uk))).status).toBe(404);
  });

  it('W3-D17: the Australian My Documents file is never served at its own address', async () => {
    for (const q of ['', '?gp_shell=embedded']) {
      const mine = await rig.get('/pages/my-documents-au' + q, as(au));
      expect([mine.status, mine.headers.location]).toEqual([302, '/pages/my-documents' + q]);
      const theirs = await rig.get('/pages/my-documents-au' + q, as(uk));
      expect([theirs.status, theirs.headers.location]).toEqual([302, '/pages/my-documents' + q]);
    }
    expect((await rig.get('/pages/my-documents-au.html?gp_shell=embedded', as(uk))).status).toBe(302);
    expect((await rig.get('/pages/MY-DOCUMENTS-AU?gp_shell=embedded', as(uk))).status).toBe(302);
    // at the ordinary address: the Australian page for the Australian doctor, the standard page for everyone else
    const auPage = await rig.get('/pages/my-documents?gp_shell=embedded', as(au));
    expect(auPage.status).toBe(200);
    expect(auPage.raw).toContain('GPMyDocumentsAu');
    const ukPage = await rig.get('/pages/my-documents?gp_shell=embedded', as(uk));
    expect(ukPage.status).toBe(200);
    expect(ukPage.raw).not.toContain('GPMyDocumentsAu.mount');
    const ukOnRaw = ukPage.raw;
    rig.setSwitch(false);
    try {
      expect((await rig.get('/pages/my-documents?gp_shell=embedded', as(uk))).raw).toBe(ukOnRaw);
      expect((await rig.get('/pages/my-documents?gp_shell=embedded', as(au))).raw).toBe(ukOnRaw);   // an overseas doctor while it is off
      const off = await rig.get('/pages/my-documents-au?gp_shell=embedded', as(au));
      expect([off.status, off.headers.location]).toEqual([302, '/pages/my-documents?gp_shell=embedded']);
    } finally { rig.setSwitch(true); }
  });
});
