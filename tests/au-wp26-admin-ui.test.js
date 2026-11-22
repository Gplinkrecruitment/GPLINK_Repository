// WP-26 (Australian GP build): what the RSO / admin page (pages/admin.html)
// draws for an AUSTRALIAN case. The page's own functions are pulled out of its
// inline script and run (tests/helpers/au-wp26-parity.js); the overseas side of
// every one of these views is pinned byte for byte in
// tests/au-wp26-overseas-parity.test.js.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const parity = require('./helpers/au-wp26-parity.js');

const ADMIN = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');
// What must never be on an Australian doctor's staff screens.
const OVERSEAS_WORDS = /\bGB\b|MyIntealth|AMC Portfolio|\bAMC\b|AHPRA Registration|AHPRA application|Visa Application|Log AHPRA letter|Supervisor CV/;
const RAW_KEYS = />\s*(prestart|commenced|guarantee|au_vr|au_restricted|reference_check|start_date_tracking|invoice_due|guarantee_checkin)\s*</;
const XSS = '<img src=x onerror=alert(1)>';

const AU_CASE = {
  id: 'case-au-1', user_id: 'user-au-1', gp_name: 'Dr Test Auvr ' + XSS, gp_email: 'au.vr.test@gplink-test.local', stage: 'prestart', substage: '',
  status: 'active', open_tasks: 3, urgent_tasks: 0, overdue_tasks: 0, assigned_va: 'rso-1', practice_name: 'Test Metro Practice (FAKE) ' + XSS,
  last_gp_activity_at: '2026-11-21T02:00:00Z', created_at: '2026-11-01T00:00:00Z', pathway: 'au_vr'
};
const AU_USER = {
  case_id: 'case-au-1', user_id: 'user-au-1', gp_name: AU_CASE.gp_name, gp_email: AU_CASE.gp_email, gp_phone: '+61491570156',
  country: 'AU', stage: 'prestart', quals_required: 5, quals_approved: 0, quals_missing: 5, practice_name: AU_CASE.practice_name,
  au: { pathway: 'au_vr', label: 'Australian VR', stage: 'prestart', stage_label: 'Pre-start', docs_have: 2, docs_approved: 1, docs_total: 8 }
};
const auTask = (id, type, extra, meta) => Object.assign({
  id, case_id: 'case-au-1', title: 'Task ' + id, task_type: type, status: 'open', priority: 'normal', due_date: '2026-11-22', related_stage: 'prestart',
  gp_name: AU_CASE.gp_name, case_stage: 'prestart',
  metadata: Object.assign({ au: true, owner: 'rso', what_to_do: 'Do the thing.' }, meta || {})
}, extra || {});
const TASKS = [
  auTask('t-ref', 'reference_check', { related_stage: 'placement' }, { owner: 'consultant' }),
  auTask('t-start', 'start_date_tracking', {}, { owner: 'consultant', owner_then: 'rso', expected_start_date: '2026-12-14' }),
  auTask('t-prov', 'provider_number_new_location'),
  auTask('t-ind', 'indemnity_certificate'),
  auTask('t-cred', 'credentialing_pack'),
  auTask('t-inv', 'invoice_due', { related_stage: 'commenced' }, { owner: 'ceo', lifecycle_kind: 'invoice_due' }),
  auTask('t-w12', 'guarantee_checkin', { related_stage: 'guarantee', due_date: '2027-02-14' }, { owner: 'consultant', mark: 'w12' }),
  auTask('t-w4', 'guarantee_checkin', { related_stage: 'guarantee', due_date: '2026-12-20' }, { owner: 'consultant', mark: 'w4' }),
  auTask('t-seg', 'manual', {}, { owner: 'rso', needs_its_action: true, lifecycle_kind: 'visa_transfer_decision' })
];
const AU_DOCS = {
  au: true, documentSet: 'au_reg', docCount: { have: 2, approved: 1, total: 8 }, directToAhpra: [],
  preparedByCandidate: [
    { key: 'au_indemnity_certificate', label: 'Indemnity certificate of currency', status: 'approved', file_name: 'i.pdf', required: true, expiry_tracked: true, expires_at: '2027-06-30T00:00:00.000Z' },
    { key: 'au_wwcc', label: 'Working with Children Check ' + XSS, status: 'under_review', file_name: 'w.pdf', required: true, expiry_tracked: true },
    { key: 'au_right_to_work', label: 'Right-to-work evidence', status: 'pending', required: true, expiry_tracked: false }
  ],
  preparedByGpLink: [], otherFiles: []
};

function load(role, extraS) {
  return parity.loadAdmin({ S: Object.assign({
    cases: [AU_CASE, parity.UK.caseRow], tasks: TASKS.concat(parity.UK.tasks).concat([{ id: 't-rev', case_id: 'case-au-1', task_type: 'doc_review', related_document_key: 'au_wwcc', status: 'open', title: 'Review', related_stage: 'prestart' }]),
    dashboard: { candidates: [parity.UK.gp], tickets: [] },
    va: { dashboard: { users: [AU_USER, parity.UK.user] }, gpDetailCache: { 'user-au-1': { gpDocuments: AU_DOCS } } },
    _vaAccounts: [{ user_id: 'rso-1', display_name: 'Test Rso', email_address: 'rso@gplink-test.local' }], selectedCaseId: 'case-au-1',
    viewer: role === 'rso' ? { email: 'rso@gplink-test.local', role: 'admin' } : { email: 'ceo@gplink-test.local', role: 'super_admin' }
  }, extraS || {}) });
}

describe('the GP list (ADM-26)', () => {
  const a = load('ceo');
  it('an Australian card shows its stage in words and a pathway badge; the name is written as text', () => {
    const html = a.renderCaseCard({ rc: AU_CASE, gp: null }, false);
    expect(html).toContain('>Pre-start</span>');
    expect(html).toContain('data-au-pathway-badge');
    expect(html).toContain('Australian VR (segment A)');
    expect(html).not.toMatch(RAW_KEYS);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('the filter bar offers the pathway filter only when an Australian case is in the list', () => {
    const bar = a.auPathwayFilterHtml();
    expect(bar).toContain('data-au-pathway-filter=""');
    expect(bar).toContain('>Overseas<');
    expect(bar).toContain('>Australian<');
    expect(bar).toContain('Australian VR (segment A)');
    const none = parity.loadAdmin({ S: { cases: [parity.UK.caseRow] } });
    expect(none.auPathwayFilterHtml()).toBe('');
  });
  it('the filter narrows the list to Australian or to overseas cases', () => {
    const ids = () => a.filteredCases().map((m) => m.rc && m.rc.id).filter(Boolean).sort();
    a.S.fPathway = '';
    expect(ids()).toEqual(['case-au-1', 'case-uk-1']);
    a.S.fPathway = 'au';
    expect(ids()).toEqual(['case-au-1']);
    a.S.fPathway = 'overseas';
    expect(ids()).toEqual(['case-uk-1']);
    a.S.fPathway = 'au_vr';
    expect(ids()).toEqual(['case-au-1']);
    a.S.fPathway = '';
  });
});

describe('the GP file for an Australian case (D8, W3-D24)', () => {
  const a = load('ceo');
  a.renderDetail();
  const html = a.elements.detailContent.innerHTML;

  it('says AU, never GB; shows the one document count; draws the Australian rail', () => {
    expect(html).toContain(' • AU');
    expect(html).toContain('data-au-doc-pill');
    expect(html).toContain('>2 of 8 docs<');
    expect(html).not.toContain('0/5 docs');
    expect(html).toContain('data-au-rail="1"');
    ['Secure placement', 'Pre-start', 'Commenced', 'Guarantee', 'Complete'].forEach((w) => expect(html).toContain(w));
    expect(html).toContain('>Pre-start</span>');
    expect(html).toContain('Australian VR (segment A)');
  });
  it('carries no overseas stage name, no "Log AHPRA letter" and no raw key', () => {
    expect(html).not.toMatch(OVERSEAS_WORDS);
    expect(html).not.toMatch(RAW_KEYS);
    expect(html).not.toContain('data-log-ahpra-letter');
  });
  it('a doctor or practice name containing markup is written as text', () => {
    expect(html).not.toContain('<img src=x');
    expect(html.split('&lt;img src=x onerror=alert(1)&gt;').length).toBeGreaterThan(2);
  });
  it('the tasks pane with no open task also has no "Log AHPRA letter"', () => {
    const keep = a.S.tasks; a.S.tasks = [];
    const empty = a.renderGpTasksPane(AU_CASE);
    a.S.tasks = keep;
    expect(empty).toContain('data-add-task');
    expect(empty).not.toContain('Log AHPRA letter');
  });
  it('the case form offers no overseas stage and hides the overseas rollback', () => {
    const form = a.renderCaseManagementForm(AU_CASE);
    expect(form).not.toContain('VA Verified Stage');
    expect(form).not.toMatch(/MyIntealth|AMC Portfolio|AHPRA Registration|Visa Application/);
    expect(form).toContain('Pre-start (no change)');
    expect(form).toMatch(/border-top:1px dashed var\(--border\);padding-top:8px;margin-top:4px;display:none/);
    // a case still at Placement may be moved forward to Pre-start, and nowhere else
    const early = a.renderCaseManagementForm(Object.assign({}, AU_CASE, { stage: 'placement' }));
    expect(early).toContain('Move forward to Pre-start');
    expect(early).not.toContain('Commenced</option>');
  });
});

describe('Australian tasks are grouped by their own stage', () => {
  const a = load('ceo');
  it('Placement, Pre-start, Commenced, Guarantee period, in ladder order; nothing under an overseas stage', () => {
    const real = parity.fnSource(ADMIN, 'function groupTasksByStage(tasks){');
    const group = new Function('auCaseIsAu', 'auCaseById', 'auGroupTasksByStage', 'STAGE_ORDER', real + '; return groupTasksByStage;')(
      (c) => !!c && c.pathway === 'au_vr', (id) => (id === 'case-au-1' ? AU_CASE : parity.UK.caseRow), a.auGroupTasksByStage,
      ['onboarding', 'career', 'placement', 'myintealth', 'amc', 'ahpra', 'visa', 'pbs', 'commencement']);
    expect(group(TASKS).map((g) => g.stage)).toEqual(['placement', 'prestart', 'commenced', 'guarantee']);
    // an overseas case is grouped exactly as before (practice pack under AHPRA)
    expect(group(parity.UK.tasks).map((g) => g.stage)).toEqual(['myintealth', 'ahpra']);
  });
});

describe('guided actions on an Australian task (W3-D22)', () => {
  const ceo = load('ceo');
  const rso = load('rso');
  const by = (id) => TASKS.filter((t) => t.id === id)[0];
  it('each task gets the action that really finishes it', () => {
    expect(ceo.getGuidedAction(by('t-prov'))).toMatchObject({ label: 'Record number', action: 'auRecordProviderNumber' });
    expect(ceo.getGuidedAction(by('t-start'))).toMatchObject({ label: 'Save start date', action: 'auSaveStartDate' });
    expect(ceo.getGuidedAction(by('t-ref'))).toMatchObject({ label: 'Mark references checked', action: 'auCompleteReferenceCheck' });
    expect(ceo.getGuidedAction(by('t-cred'))).toMatchObject({ label: 'Mark Complete', action: 'completeTask' });
    expect(ceo.getGuidedAction(by('t-ind'))).toMatchObject({ action: 'none', disabled: true });
    expect(ceo.getGuidedAction(by('t-seg'))).toMatchObject({ action: 'none', disabled: true });
  });
  it('the invoice is the CEO\'s: "Mark invoice sent" for the CEO, nothing to press for an RSO', () => {
    expect(ceo.getGuidedAction(by('t-inv'))).toMatchObject({ label: 'Mark invoice sent', action: 'auMarkInvoiceSent' });
    expect(rso.getGuidedAction(by('t-inv'))).toMatchObject({ label: 'Waiting on the CEO', action: 'none', disabled: true });
  });
  it('every prompt still ends with who owns the task', () => {
    TASKS.forEach((t) => expect(ceo.getGuidedAction(t).prompt, t.id).toMatch(/Owner: (Consultant|RSO|CEO|Consultant, then RSO)\.$/));
  });
  it('facts are entered in a form in the page, never a browser prompt', () => {
    ['function auRecordProviderNumber(task,after){', 'function auSaveStartDate(task,after){', 'function auMarkInvoiceSent(task,after){', 'function auCompleteReferenceCheck(task,after){']
      .forEach((sig) => expect(parity.fnSource(ADMIN, sig), sig).not.toMatch(/window\.prompt|[^.]prompt\(/));
    expect(parity.fnSource(ADMIN, 'function auSaveStartDate(task,after){')).toContain("type:'date'");
    expect(parity.fnSource(ADMIN, 'function auMarkInvoiceSent(task,after){')).toContain('"/api/admin/au/commencement/invoice-sent"');
    expect(parity.fnSource(ADMIN, 'function auCompleteReferenceCheck(task,after){')).toContain('au_reason');
  });
  it('the form itself escapes what it is given and shows a refusal without closing', () => {
    const a = load('ceo');
    a.auOpenFactForm({ title: 'T', intro: XSS, submitLabel: 'Save', doneMessage: 'ok', fields: [{ id: 'x', label: XSS, value: '"><b>', placeholder: XSS }], send: () => Promise.resolve({ ok: false }) });
    const body = a.elements.modalBody.innerHTML;
    expect(body).not.toContain('<img');
    expect(body).not.toContain('"><b>');
    expect(body).toContain('id="auFactError"');
  });
});

describe('the Ops Queue for Australian tasks (W3-D24)', () => {
  const ceo = load('ceo');
  const rso = load('rso');
  const by = (id) => TASKS.filter((t) => t.id === id)[0];
  const noon = new Date(2026, 10, 22, 12, 0, 0);
  it('the owner chip shows who owns the task, not the RSO\'s name', () => {
    expect(ceo.auOpsOwnerPill(by('t-ref')).label).toBe('Consultant');
    expect(ceo.auOpsOwnerPill(by('t-inv')).label).toBe('CEO');
    expect(ceo.auOpsOwnerPill(by('t-prov')).label).toBe('RSO');
    expect(ceo.auOpsOwnerPill(Object.assign({}, by('t-ref'), { status: 'waiting_on_gp' })).label).toBe('GP');
    expect(ceo.auOpsOwnerPill(parity.UK.tasks[0])).toBe(null);
  });
  it('a task is due ON its day and overdue only from the day after', () => {
    expect(ceo.opsGetDueCell(by('t-inv'), noon)).toContain('Due today');
    expect(ceo.opsGetDueCell(by('t-inv'), noon)).not.toContain('OVERDUE');
    expect(ceo.opsTaskIsOverdue(by('t-inv'), noon)).toBe(false);
    expect(ceo.opsTaskIsOverdue(by('t-inv'), new Date(2026, 10, 23, 9, 0, 0))).toBe(true);
    expect(ceo.opsGetDueCell(by('t-inv'), new Date(2026, 10, 23, 9, 0, 0))).toContain('OVERDUE');
    // an ordinary task is judged exactly as before
    expect(ceo.opsTaskIsOverdue(parity.UK.tasks[2], new Date(parity.FIXED_NOW))).toBe(true);
  });
  it('the row says what kind of task it is, in words', () => {
    expect(ceo.opsGetSubtitle(by('t-w4'))).toBe('Guarantee check-in · owner: Consultant');
    expect(ceo.opsGetSubtitle(by('t-start'))).toBe('Notice period and start date · owner: Consultant, then RSO');
  });
  it('the card: the invoice button by role, the reference button, a way to the decision', () => {
    expect(ceo.renderOpsGeneric(by('t-inv'), [], [])).toContain('data-ops-au-action="invoice-sent"');
    expect(ceo.renderOpsGeneric(by('t-inv'), [], [])).not.toContain('Mark Complete');
    expect(rso.renderOpsGeneric(by('t-inv'), [], [])).toContain('The CEO records the invoice as sent');
    expect(rso.renderOpsGeneric(by('t-inv'), [], [])).not.toContain('data-ops-au-action="invoice-sent"');
    expect(ceo.renderOpsGeneric(by('t-ref'), [], [])).toContain('data-ops-au-action="reference-check"');
    expect(ceo.renderOpsGeneric(by('t-seg'), [], [])).toContain('Open the case to decide');
    expect(ceo.renderOpsGeneric(by('t-cred'), [], [])).toContain('Mark Complete');
  });
  it('the whole table: week 4 before week 12, Australian stages in words, no raw key, names as text', () => {
    ceo.S.opsTasks = TASKS.map((t) => Object.assign({ case_assigned: true }, t));
    ceo.renderOpsTable();
    const html = ceo.elements.opsTableBody.innerHTML;
    expect(html.indexOf('Task t-w4')).toBeLessThan(html.indexOf('Task t-w12'));
    expect(html).toContain('>Pre-start</span>');
    expect(html).not.toMatch(RAW_KEYS);
    expect(html).not.toMatch(OVERSEAS_WORDS);
    expect(html).not.toContain('>Hazel<');
    expect(html).not.toContain('<img src=x');
  });
});

describe('documents (ADM-08, ADM-13)', () => {
  const a = load('ceo');
  const html = a.renderCategorizedDocuments(AU_DOCS, 'case-au-1', 'user-au-1');
  it('the pane shows the same count as the pill, and no "Direct to AHPRA" section', () => {
    expect(html).toContain('2 of 8 on file · 1 approved');
    expect(html).not.toContain('Direct to AHPRA');
    expect(a.auDocPillText(AU_CASE, AU_USER)).toBe('2 of 8 docs');
    // before the pane has been read, the count that came with the list
    const fresh = parity.loadAdmin({ S: { cases: [AU_CASE], va: { dashboard: { users: [AU_USER] }, gpDetailCache: {} } } });
    expect(fresh.auDocPillText(AU_CASE, AU_USER)).toBe('2 of 8 docs');
  });
  it('a card can be reviewed, dated and replaced; its label is written as text', () => {
    expect(html).toContain('data-au-doc-review="t-rev"');
    expect(html).toContain('data-au-doc-expiry="au_indemnity_certificate"');
    expect(html).toContain('expires 30 Jun 2027');
    expect(html).toContain('>Change expiry<');
    expect(html).toContain('>Set expiry<');
    // not on file, or not a dated document: no expiry control
    expect(html).not.toContain('data-au-doc-expiry="au_right_to_work"');
    expect(html).toContain('data-candidate-doc-upload="au_right_to_work"');
    expect(html).toContain('data-doc-view-url=');
    expect(html).not.toContain('<img src=x');
  });
  it('an overseas card gets nothing extra', () => {
    expect(a.auDocCardExtrasHtml({ key: 'primary_medical_degree', label: 'Degree' }, 'approved', 'case-uk-1')).toBe('');
  });
});

describe('the assistance-call dialog (ADM-20)', () => {
  function run(caseData, cases) {
    const select = Object.assign(parity.fakeElement(), { innerHTML: '<option value="myintealth">MyIntealth</option><option value="amc">AMC</option><option value="ahpra">AHPRA</option>', value: '' });
    const label = Object.assign(parity.fakeElement(), { textContent: 'Registration Stage' });
    select.parentNode = { querySelector: () => label };
    const a = parity.loadAdmin({ S: { cases }, elements: { zoomStageSelect: select } });
    return { a, select, label, open: (d) => a.openZoomScheduleModal(d || caseData) };
  }
  it('an Australian doctor is offered a pre-start call, never MyIntealth / AMC / AHPRA', () => {
    const r = run({ case_id: 'case-au-1', stage: 'prestart', first_name: 'Test', last_name: 'Auvr' }, [AU_CASE]);
    r.open();
    expect(r.select.innerHTML).toBe('<option value="prestart">Pre-start call</option>');
    expect(r.select.value).toBe('prestart');
    expect(r.label.textContent).toBe('Call type');
  });
  it('an overseas doctor gets exactly the three choices and the stage of their case, also straight after an Australian one', () => {
    const original = '<option value="myintealth">MyIntealth</option><option value="amc">AMC</option><option value="ahpra">AHPRA</option>';
    const r = run(null, [AU_CASE, parity.UK.caseRow]);
    r.open({ case_id: 'case-uk-1', stage: 'amc', first_name: 'Test', last_name: 'Ukgp' });
    expect(r.select.innerHTML).toBe(original);
    expect(r.select.value).toBe('amc');
    expect(r.label.textContent).toBe('Registration Stage');
    r.open({ case_id: 'case-au-1', stage: 'prestart', first_name: 'Test', last_name: 'Auvr' });
    expect(r.select.value).toBe('prestart');
    r.open({ case_id: 'case-uk-1', stage: '', first_name: 'Test', last_name: 'Ukgp' });
    expect(r.select.innerHTML).toBe(original);
    expect(r.select.value).toBe('myintealth');
    expect(r.label.textContent).toBe('Registration Stage');
  });
});

describe('safety', () => {
  it('nothing new re-renders the whole page from a blur or focus handler', () => {
    // (tests/admin-pending-render-flush.test.js pins the flush itself)
    const flush = parity.fnSource(ADMIN, 'function flushPendingRender(){').replace(/\/\/[^\n]*/g, '');
    expect(flush).not.toMatch(/renderAll\(\)|renderDetail\(\)/);
    expect(ADMIN).not.toMatch(/addEventListener\("(blur|focusout|focusin|focus)"[^)]*auOpenFactForm/);
  });
  it('the Australian document keys are only added to the task form for an Australian case', () => {
    expect(parity.fnSource(ADMIN, 'function auExtendTaskModal(d){')).toContain('if(docSel&&auCaseIsAu(auCaseById(S.selectedCaseId))&&Array.isArray(d.document_keys)');
  });
  it('no Australian label is hard-coded on the page: the words come from the shared helper', () => {
    const start = ADMIN.indexOf('/* ── WP-26: Australian cases on this page ──');
    expect(start).toBeGreaterThan(-1);
    expect(ADMIN).not.toMatch(/prestart:\s*['"]Pre-start/);
    expect(ADMIN).not.toMatch(/guarantee:\s*['"]Guarantee/);
  });
});
