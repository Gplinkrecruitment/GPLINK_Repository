'use strict';
// WP-26 (Australian GP build): what the two staff dashboards draw for an
// OVERSEAS doctor, captured as text.
//
// tests/fixtures/au-wp26-overseas-parity.snapshot.json was written from this
// file BEFORE any WP-26 code changed. tests/au-wp26-overseas-parity.test.js
// asserts the same output afterwards, so an overseas doctor's markup on every
// view WP-26 touched is byte for byte what it was. Never regenerate the
// snapshot to make a test pass.
//
// There is no DOM in this suite. The CEO dashboard's modules are run whole
// inside a stand-in window; the admin page's functions are pulled out of its
// inline script by brace matching. Anything a function reaches for that is not
// supplied resolves to a harmless stub, and every fetch is recorded.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FIXED_NOW = Date.parse('2026-11-22T03:00:00Z');

function fnSource(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error('not found: ' + signature);
  const open = src.indexOf('{', start + signature.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + signature);
}
function constSource(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error('not found: ' + signature);
  const end = src.indexOf('];', start);
  return src.slice(start, end + 2);
}

function htmlEsc(s) {
  return String(s == null || s === false || s === 0 ? (s === 0 ? '' : (s || '')) : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A scope in which every unknown name is a stub. `known` wins.
function makeScope(known, calls) {
  const stubs = {};
  const target = Object.assign({}, known);
  return new Proxy(target, {
    has() { return true; },
    get(t, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key in t) return t[key];
      if (typeof key !== 'string') return undefined;
      if (key in globalThis && key !== 'fetch' && key !== 'document' && key !== 'window') return globalThis[key];
      if (!stubs[key]) stubs[key] = function () { return ''; };
      return stubs[key];
    },
    set(t, key, value) { t[key] = value; return true; }
  });
}

function fakeElement() {
  return {
    innerHTML: '', textContent: '', value: '', style: {}, children: [], hidden: false, scrollTop: 0, parentElement: null, parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; }, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }
  };
}

// ── pages/admin.html ───────────────────────────────────────────────────────
const ADMIN_FUNCTIONS = [
  'function substageLabel(raw){', 'function ini(n){', 'function fmtD(d){', 'function safeUrl(u,fallback){', 'function _safeProtocolUrl(',
  'function isHostMatch(', 'function isDtUrl(u){', 'function isSA(){',
  'function findGp(rc){', 'function buildJourney(gp,regCase){', 'function dashUserForCase(rc){',
  'function caseActionItems(caseId){', 'function renderCaseCard(m,showUrgencyDetail){',
  'function renderJourneyRail(c,u){', 'function auTaskMeta(t){', 'function auTaskOwnerLabel(m){', 'function isQualDocReviewTask(t){',
  'function getGuidedAction(t){', 'function renderOpsGeneric(task,msgs,docs){',
  'function opsGetBallPill(status){', 'function opsGetDueCell(t,now){', 'function opsGetSubtitle(t){', 'function opsGetAction(t){',
  'function docStatusLabel(status){', 'function renderDocPlaceholderCard(doc,status,caseId){', 'function renderCategorizedDocuments(gpDocs,caseId,gpUserId){',
  'function renderGpTasksPane(c){', 'function auCaseLooksAustralian(c){', 'function renderCaseManagementForm(c){',
  'function wqItem(t){', 'function renderDetail(){', 'function openAddTaskModal(caseId,prefill){', 'function renderOpsTable(){',
  // added by WP-26 itself (absent from the page the snapshot was taken from)
  'function auCaseIsAu(c){', 'function auCaseById(caseId){', 'function auStageWords(stage,c){', 'function auPathwayFilterHtml(){',
  'function auPathwayBadgeHtml(c){', 'function auOpsOwnerPill(t){', 'function auOpsDueDays(t,now){', 'function opsTaskIsOverdue(t,now){',
  'function renderFilters(){', 'function filteredCases(){', 'function mergedCases(){', 'function caseNeedsAction(m){'
];

function loadAdmin(opts) {
  const o = opts || {};
  const html = read('pages/admin.html');
  const calls = { fetch: [] };
  const elements = {};
  const documentStub = {
    getElementById(id) { if (!elements[id]) elements[id] = fakeElement(); return elements[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return fakeElement(); }, body: { contains() { return true; } }, head: fakeElement()
  };
  const sources = [];
  ADMIN_FUNCTIONS.forEach(function (sig) {
    try { sources.push(fnSource(html, sig)); } catch (e) { /* a function this version of the page does not have */ }
  });
  const fixedDate = class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(FIXED_NOW); }
    static now() { return FIXED_NOW; }
  };
  const S = Object.assign({
    view: 'gps', selectedCaseId: null, cases: [], tasks: [], dashboard: { candidates: [], tickets: [] },
    va: { dashboard: { users: [] }, gpDetailCache: {} }, _vaAccounts: [], viewer: { email: 'ceo@gplink-test.local', role: 'super_admin' },
    gpsProfileTab: 'tasks', expanded: {}, query: '', filter: 'all', opsTasks: [], opsExpandedId: null
  }, o.S || {});
  const known = {
    S, document: documentStub, Date: fixedDate,
    window: Object.assign({ GPAuStaff: o.withHelper === false ? undefined : require(path.join(ROOT, 'js/au-staff-labels.js')) }, o.window || {}),
    fetch() { calls.fetch.push(Array.prototype.slice.call(arguments)); return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }); },
    setTimeout() { return 0; },
    esc(s) { return htmlEsc(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },
    escAttr(s) { return known.esc(String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')); },
    fmtR(d) { return d ? 'R(' + d + ')' : 'never'; },
    isSameDay(a, b) { return a.toDateString() === b.toDateString(); },
    loadAuTaskTypes() { return { then() { return this; } }; },
    isParkedWaiting() { return false; }, isS80Task() { return false; }, isRegGrantedPanelTask() { return false; },
    gps() { return S.dashboard && Array.isArray(S.dashboard.candidates) ? S.dashboard.candidates : []; },
    groupTasksByStage(tasks) { return [{ stage: 'other', tasks: tasks }]; },
    SUBSTAGE_LABELS: {}, QUAL_REVIEW_DOC_KEYS: new Set(), ELS_PATHWAY_DOCS: {}, PLAYBOOK: {}
  };
  known.window.GPAuStaff = known.window.GPAuStaff || undefined;
  known.GPAuStaff = known.window.GPAuStaff;
  const scope = makeScope(known, calls);
  const body = 'with (scope) {\n' +
    constSource(html, 'const STEPS=[') + '\n' + constSource(html, 'const STAGE_ORDER=[') + '\n' + constSource(html, 'const ROLLBACK_STAGE_ORDER=[') + '\n' +
    sources.join('\n') + '\n' +
    'return { ' + ADMIN_FUNCTIONS.map(function (sig) { const n = /function (\w+)/.exec(sig)[1]; return n + ': (typeof ' + n + ' === "function" ? ' + n + ' : null)'; }).join(', ') + ', STEPS: STEPS };\n}';
  const api = new Function('scope', body)(scope);
  api.calls = calls; api.elements = elements; api.S = S; api.html = html;
  return api;
}

// ── the CEO dashboard's modules, run whole ─────────────────────────────────
function loadCeoModule(rel, exportNames, opts) {
  const o = opts || {};
  let src = read(rel);
  const calls = { api: [], swr: [], fetch: [] };
  const elements = {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const shared = {};
  const ATS = Object.assign({
    esc, escAttr: esc,
    initials: (name) => String(name || '').replace(/^Dr\s+/i, '').trim().split(/\s+/).map((w) => w[0] || '').slice(0, 2).join('').toUpperCase() || '?',
    avatarColor: () => '#60a5fa',
    flag: (c) => (/australia|\bau\b/i.test(String(c || '')) ? 'AUFLAG' : (/kingdom|\buk\b|gb/i.test(String(c || '')) ? 'UKFLAG' : 'GLOBE')),
    countryLabel: (c) => (c ? ATS.flag(c) + ' ' + esc(c) : '—'),
    bandClass: (s) => (s == null ? 'cold' : s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold'),
    bandLabel: (s) => (s == null ? '—' : s >= 70 ? 'Hot' : s >= 40 ? 'Warm' : 'Cold'),
    intentChip: (score, band) => '<span class="intent">' + esc(score) + ':' + esc(band) + '</span>',
    loadingHtml: (l) => '<div class="ats-loading">' + esc(l) + '</div>',
    emptyHtml: (l) => '<div class="ats-empty">' + esc(l) + '</div>',
    isConsultant: () => o.consultant === true,
    api(p, opt) { calls.api.push([p, opt || null]); return Promise.resolve({ ok: false }); },
    swr(p) { calls.swr.push(p); },
    toast() {}, downloadCsv() { return Promise.resolve(); }, fmtDate: (d) => 'D(' + d + ')', timeAgo: (d) => 'T(' + d + ')'
  }, shared, o.ATS || {});
  const documentStub = {
    getElementById(id) { return elements[id] || null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return fakeElement(); }, addEventListener() {}, removeEventListener() {}, body: fakeElement(), head: fakeElement()
  };
  const windowStub = Object.assign({
    ATS, addEventListener() {}, confirm() { return true; }, open() { return null; },
    GPAuStaff: o.withHelper === false ? undefined : require(path.join(ROOT, 'js/au-staff-labels.js'))
  }, o.window || {});
  const fixedDate = class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(FIXED_NOW); }
    static now() { return FIXED_NOW; }
  };
  // Open the module's closure so its inner functions can be handed back.
  const tail = src.lastIndexOf('})();');
  if (tail === -1) throw new Error('not an IIFE: ' + rel);
  const exportsCode = '\n  window.__wp26 = { ' + exportNames.map((n) => n + ': (typeof ' + n + ' !== "undefined" ? ' + n + ' : undefined)').join(', ') + ' };\n';
  src = src.slice(0, tail) + exportsCode + src.slice(tail);
  src = src.replace(/(\(function \(\) \{\s*)'use strict';/, '$1');
  const known = {
    window: windowStub, document: documentStub, Date: fixedDate, ATS,
    fetch() { calls.fetch.push(Array.prototype.slice.call(arguments)); return Promise.resolve({ ok: false, json: () => Promise.resolve({}) }); },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, console: { log() {}, error() {}, warn() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
  const scope = makeScope(known, calls);
  new Function('scope', 'with (scope) {\n' + src + '\n}')(scope);
  const api = windowStub.__wp26 || {};
  api.calls = calls; api.elements = elements; api.window = windowStub; api.ATS = ATS;
  return api;
}

// ── overseas fixtures (obviously fake) ─────────────────────────────────────
const UK = {
  caseRow: {
    id: 'case-uk-1', user_id: 'user-uk-1', gp_name: 'Dr Test Ukgp', gp_email: 'uk.doctor@gplink-test.local', stage: 'ahpra', substage: 'upload_qualifications',
    status: 'active', open_tasks: 2, urgent_tasks: 1, overdue_tasks: 0, assigned_va: 'rso-1', practice_name: 'Test Regional Practice (FAKE)',
    last_gp_activity_at: '2026-11-20T02:00:00Z', created_at: '2026-10-01T00:00:00Z', gp_verified_stage: 'ahpra', pathway: null
  },
  user: {
    case_id: 'case-uk-1', user_id: 'user-uk-1', gp_name: 'Dr Test Ukgp', gp_email: 'uk.doctor@gplink-test.local', gp_phone: '+447700900123',
    country: 'GB', stage: 'ahpra', quals_required: 5, quals_approved: 2, quals_missing: 3, practice_name: 'Test Regional Practice (FAKE)',
    practice_contact: { practiceName: 'Test Regional Practice (FAKE)' }, myintealth_id: 'MI-123', doubletick_conversation_url: null
  },
  gp: { userId: 'user-uk-1', email: 'uk.doctor@gplink-test.local', name: 'Dr Test Ukgp', pathwaySteps: [{ id: 'myintealth', status: 'done', substeps: [{ label: 'Create Account', status: 'done' }] }, { id: 'amc', status: 'done', substeps: [] }, { id: 'ahpra', status: 'current', substeps: [] }] },
  tasks: [
    { id: 't-uk-1', case_id: 'case-uk-1', title: 'Review uploaded: Primary medical degree', task_type: 'doc_review', status: 'open', priority: 'urgent', due_date: '2026-11-22', related_stage: 'ahpra', related_document_key: 'primary_medical_degree', gp_name: 'Dr Test Ukgp', case_stage: 'ahpra', practice_name: 'Test Regional Practice (FAKE)' },
    { id: 't-uk-2', case_id: 'case-uk-1', title: 'Supervisor CV', task_type: 'practice_pack_child', status: 'waiting_on_practice', priority: 'normal', due_date: '2026-11-30', related_stage: 'ahpra', related_document_key: 'supervisor_cv', gp_name: 'Dr Test Ukgp', case_stage: 'ahpra' },
    { id: 't-uk-3', case_id: 'case-uk-1', title: 'Call the doctor', task_type: 'manual', status: 'open', priority: 'normal', due_date: '2026-11-20', related_stage: 'ahpra', description: 'A manual task', gp_name: 'Dr Test Ukgp', case_stage: 'ahpra' },
    { id: 't-uk-4', case_id: 'case-uk-1', title: 'Chase <b>bold</b>', task_type: 'chase', status: 'waiting_on_gp', priority: 'high', due_date: null, related_stage: 'myintealth', gp_name: 'Dr Test Ukgp', case_stage: 'myintealth' }
  ],
  gpDocs: {
    directToAhpra: [{ key: 'criminal_history', label: 'Criminal history check', status: 'requested', referenceNumber: 'REF-1' }, { key: 'cogs', label: 'Certificate of good standing', status: 'pending' }],
    preparedByCandidate: [{ key: 'primary_medical_degree', label: 'Primary medical degree', status: 'approved', file_name: 'degree.pdf' }, { key: 'cv_signed_dated', label: 'CV (signed and dated)', status: 'pending' }],
    preparedByGpLink: [], otherFiles: []
  }
};

const UK_LIST_ROW = {
  case_id: 'case-uk-1', user_id: 'user-uk-1', name: 'Dr Test Ukgp', email: 'uk.doctor@gplink-test.local', country: 'United Kingdom',
  reg_stage: 'ahpra', reg_stage_label: 'AHPRA', blocked: false, blocked_days: 0, intent_score: 62, intent_band: 'Warm',
  onboarding_completed: true, onboarding_pct: 100, docs: { cv: true, coverLetter: false }, account_status: 'active', rso: 'rso-1',
  doc_reviews_pending: 1, live_apps: [], high_velocity: false, career_locked: false, review_register: '', review_account: ''
};
const UK_CANDIDATE = {
  case_id: 'case-uk-1', user_id: 'user-uk-1', name: 'Dr Test Ukgp', email: 'uk.doctor@gplink-test.local', phone: '+447700900123',
  country: 'United Kingdom', reg: '7654321', account_status: 'active', joined: '2026-10-01T00:00:00Z', rso: 'rso-1', zoho: '',
  intent: { score: 62, band: 'Warm', signals: [{ label: 'Onboarding', w: 20, v: 1, points: 20 }] },
  reg_stage: 'ahpra', reg_stage_label: 'AHPRA', blocked: false, blocked_days: 0,
  rail: [{ key: 'myintealth', label: 'MyIntealth', state: 'done' }, { key: 'amc', label: 'AMC', state: 'done' }, { key: 'ahpra', label: 'AHPRA', state: 'current' }],
  onboarding: { completed: true, fieldsFilled: 1, qualCountry: 'United Kingdom', specialty: 'General Practice', target: '2027-02', city: 'Sydney', family: 'Partner and 2 children', idVerified: true },
  docs: { cv: true, coverLetter: false, primaryDegree: true, idDoc: true }, comms: null, calls: [], apps: [], ai_handover: null,
  doc_reviews: [], doc_reviews_pending: 0, career_lock: null
};
const UK_LEAD = {
  id: 'lead-uk-1', name: 'Dr Test Lead', email: 'lead.uk@gplink-test.local', phone: '+447700900456', country: 'uk', segment: 'overseas',
  source: 'meta', created_at: '2026-11-20T01:00:00Z', stopped: '', calls_paused: false, call_back_at: null,
  hazel: { state: 'queued', reason: '', label: 'Hazel will ring' }, chase: null, status: 'new'
};
const UK_MEETINGS = [
  { id: 'm1', gp_name: 'Dr Test Ukgp', status: 'booked', is_interview: true, meeting_kind_label: 'Interview', application_id: 'app-uk-1', practice_name: 'Test Regional Practice (FAKE)', scheduled_at: '2026-11-21T00:00:00Z', zoom_join_url: 'https://zoom.example/j/1' },
  { id: 'm2', gp_name: 'Dr Test Lead', status: 'completed', is_interview: false, meeting_kind_label: 'Consultation', scheduled_at: '2026-11-19T00:00:00Z', meeting_summary: 'A summary', invitee_email: 'lead.uk@gplink-test.local' }
];

function safe(fn) { try { const v = fn(); return v === undefined ? '(undefined)' : v; } catch (e) { return 'THROWS: ' + (e && e.message); } }

function buildAdminSnapshot() {
  const out = {};
  const a = loadAdmin({ S: {
    cases: [UK.caseRow], tasks: UK.tasks, dashboard: { candidates: [UK.gp], tickets: [] },
    va: { dashboard: { users: [UK.user] }, gpDetailCache: { 'user-uk-1': { gpDocuments: UK.gpDocs } } },
    _vaAccounts: [{ user_id: 'rso-1', display_name: 'Test Rso', email_address: 'rso@gplink-test.local' }], selectedCaseId: 'case-uk-1'
  } });
  out['admin.caseCard.needsAction'] = safe(() => a.renderCaseCard({ rc: UK.caseRow, gp: UK.gp }, true));
  out['admin.caseCard.onTrack'] = safe(() => a.renderCaseCard({ rc: UK.caseRow, gp: UK.gp }, false));
  out['admin.caseCard.candidateOnly'] = safe(() => a.renderCaseCard({ rc: null, gp: UK.gp }, false));
  out['admin.journeyRail'] = safe(() => a.renderJourneyRail(UK.caseRow, UK.user));
  out['admin.caseManagementForm'] = safe(() => a.renderCaseManagementForm(UK.caseRow));
  UK.tasks.forEach(function (t) {
    out['admin.guidedAction.' + t.id] = safe(() => JSON.stringify(a.getGuidedAction(t)));
    out['admin.opsGeneric.' + t.id] = safe(() => a.renderOpsGeneric(t, [], []));
    out['admin.opsDueCell.' + t.id] = safe(() => a.opsGetDueCell(t, new Date(FIXED_NOW)));
    out['admin.opsSubtitle.' + t.id] = safe(() => a.opsGetSubtitle(t));
    out['admin.wqItem.' + t.id] = safe(() => a.wqItem(t));
  });
  ['open', 'in_progress', 'waiting_on_gp', 'waiting_on_practice', 'waiting_on_external', 'escalated', 'waiting', 'other'].forEach(function (st) {
    out['admin.opsBallPill.' + st] = safe(() => JSON.stringify(a.opsGetBallPill(st)));
  });
  out['admin.documentsPane'] = safe(() => a.renderCategorizedDocuments(UK.gpDocs, 'case-uk-1', 'user-uk-1'));
  out['admin.tasksPane.empty'] = safe(() => { a.S.tasks = []; const h = a.renderGpTasksPane(UK.caseRow); a.S.tasks = UK.tasks; return h; });
  out['admin.tasksPane.withTasks'] = safe(() => a.renderGpTasksPane(UK.caseRow));
  out['admin.detail'] = safe(() => { a.renderDetail(); return a.elements.detailContent ? a.elements.detailContent.innerHTML : '(none)'; });
  out['admin.opsTable'] = safe(() => { a.S.opsTasks = UK.tasks; a.renderOpsTable(); return a.elements.opsTableBody ? a.elements.opsTableBody.innerHTML : '(none)'; });
  out['admin.addTaskModal'] = safe(() => { a.openAddTaskModal('case-uk-1', {}); return a.elements.modalBody ? a.elements.modalBody.innerHTML : '(none)'; });
  out['admin.fetchCalls'] = JSON.stringify(a.calls.fetch.map((c) => String(c[0])));
  // Source text of pieces that cannot be run here.
  out['admin.src.zoomModal'] = safe(() => fnSource(a.html, 'function openZoomScheduleModal(caseData, opts) {'));
  return out;
}

function buildCeoSnapshot() {
  const out = {};
  const cand = loadCeoModule('js/ceo-ats-candidates.js', ['rowHtml', 'listScaffold', 'detailHtml', 'profileCardInner', 'onboardingCardInner', 'docsCardInner', 'pipelineCardInner', 'applicationsCardInner', 'auCardsHtml', 'auTasksCardInner']);
  out['ceo.cand.row'] = safe(() => cand.rowHtml(UK_LIST_ROW));
  out['ceo.cand.listScaffold'] = safe(() => cand.listScaffold());
  out['ceo.cand.detail'] = safe(() => cand.detailHtml(UK_CANDIDATE));
  out['ceo.cand.profileCard'] = safe(() => cand.profileCardInner(UK_CANDIDATE));
  out['ceo.cand.onboardingCard'] = safe(() => cand.onboardingCardInner(UK_CANDIDATE));
  out['ceo.cand.docsCard'] = safe(() => cand.docsCardInner(UK_CANDIDATE));
  out['ceo.cand.pipelineCard'] = safe(() => cand.pipelineCardInner(UK_CANDIDATE));
  out['ceo.cand.auCards'] = safe(() => cand.auCardsHtml(UK_CANDIDATE));
  out['ceo.cand.requests'] = JSON.stringify({ api: cand.calls.api.map((c) => c[0]), swr: cand.calls.swr, fetch: cand.calls.fetch.map((c) => String(c[0])) });

  const leads = loadCeoModule('js/ceo-ats-leads.js', ['rowHtml', 'actionsHtml', 'hazelLineHtml', 'drawerHtml', 'scaffold']);
  out['ceo.leads.row'] = safe(() => leads.rowHtml(UK_LEAD));
  out['ceo.leads.actions'] = safe(() => leads.actionsHtml(UK_LEAD));
  out['ceo.leads.hazelLine'] = safe(() => leads.hazelLineHtml(UK_LEAD));
  out['ceo.leads.drawer'] = safe(() => leads.drawerHtml(UK_LEAD, [], null, false, ''));

  const mtg = loadCeoModule('js/ceo-ats-meetings.js', ['rowHtml', 'scaffold', 'group']);
  UK_MEETINGS.forEach(function (m) { out['ceo.meetings.row.' + m.id] = safe(() => mtg.rowHtml(m, false).replace(/<span class="mtg-time">[^<]*<\/span>/, '<span class="mtg-time">T</span>')); });
  out['ceo.meetings.scaffold'] = safe(() => mtg.scaffold());

  const match = loadCeoModule('js/ceo-ats-matching.js', ['mbBlockLabels', 'mbGpBlockedTrackHtml']);
  out['ceo.matching.blockLabels'] = safe(() => JSON.stringify(match.mbBlockLabels({ reasons: ['no_cv', 'onboarding_incomplete', 'placed', 'career_locked', 'at_interview_stage', 'account_gated', 'account_not_active', 'dpa_ineligible', 'existing_application', 'some_future_code'] })));
  out['ceo.matching.blockedTrack'] = safe(() => match.mbGpBlockedTrackHtml({ blocked: { reasons: ['no_cv', 'dpa_ineligible'] } }));
  return out;
}

// Dashboard times are printed in the viewer's own zone, so the snapshot is
// always built as one fixed viewer (Sydney), whatever machine runs the test.
function buildOverseasSnapshot() {
  const before = process.env.TZ;
  process.env.TZ = 'Australia/Sydney';
  try { return Object.assign({}, buildAdminSnapshot(), buildCeoSnapshot()); }
  finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

module.exports = {
  FIXED_NOW, UK, UK_LIST_ROW, UK_CANDIDATE, UK_LEAD, UK_MEETINGS,
  fnSource, loadAdmin, loadCeoModule, buildAdminSnapshot, buildCeoSnapshot, buildOverseasSnapshot,
  SNAPSHOT_PATH: path.join(ROOT, 'tests', 'fixtures', 'au-wp26-overseas-parity.snapshot.json')
};
