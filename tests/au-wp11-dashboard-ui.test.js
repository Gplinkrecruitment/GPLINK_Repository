// WP-11 (Australian GP build): the staff pages.
//
// There is no DOM in this suite, so the page code is read as text and the
// small functions are pulled out and run with stubs.
//
//   - ADM-10: the manual task form's markup is exactly today's four options;
//     the Australian types are added only from the server's list (which does
//     not exist with the switch off)
//   - an Ops Queue card for each Australian type says what to do and who owns it
//   - ADM-11: a card moved to Hired for an Australian doctor opens the placement
//     form; the form requires a start date for them
//   - cache-busters
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const prestart = require('../lib/au-prestart.js');

const adminHtml = read('pages/admin.html');
const ceoHtml = read('pages/ceo-dashboard.html');
const candidatesJs = read('js/ceo-ats-candidates.js');
const jobsJs = read('js/ceo-ats-jobs.js');

// The source of one function declaration, by brace matching.
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

describe('ADM-10: the manual task form (pages/admin.html)', () => {
  const modal = fnSource(adminHtml, 'function openAddTaskModal(caseId,prefill){');

  it('the form\'s own markup is exactly today\'s four types: nothing Australian is written into the page', () => {
    expect(modal).toContain('<select id="newTaskType"><option value="manual">Manual</option><option value="practice_pack_child"${pf.task_type===\'practice_pack_child\'?\' selected\':\'\'}>Practice Pack Doc</option><option value="verify">Verify</option><option value="review">Review</option></select>');
    for (const type of prestart.MANUAL_TASK_TYPES) {
      expect(adminHtml.indexOf('<option value="' + type + '"'), type).toBe(-1);
    }
    expect(modal).toContain('<select id="newTaskStage"><option value="">Any</option>${STEPS.map(');
  });

  it('the Australian types come from the server, which answers 404 with the switch off', () => {
    expect(modal).toContain('loadAuTaskTypes().then(auExtendTaskModal);');
    const loader = fnSource(adminHtml, 'function loadAuTaskTypes(){');
    expect(loader).toContain('fetch("/api/admin/au/task-types",{credentials:"same-origin"})');
    expect(loader).toMatch(/r\.ok\?r\.json\(\):null/);
    // a failed or empty answer leaves the form alone
    const extend = fnSource(adminHtml, 'function auExtendTaskModal(d){');
    expect(extend).toMatch(/if\(!d\|\|!sel\|\|sel\.getAttribute\("data-au-types"\)\)return;/);
    expect(extend).toContain('group.label="Australian placement"');
  });

  it('auExtendTaskModal adds one option per type, the Australian stages, and fills the defaults when a type is picked', () => {
    // a small stand-in for the handful of DOM calls the function makes
    function el(tag) {
      const node = { tag, children: [], attrs: {}, style: {}, listeners: {}, value: '', textContent: '', label: '',
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] || null; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        addEventListener(name, fn) { this.listeners[name] = fn; },
        closest() { return grid; }, insertBefore(c) { this.children.push(c); return c; } };
      return node;
    }
    const byId = { newTaskType: el('select'), newTaskStage: el('select'), newTaskTitle: el('input'), newTaskDue: el('input') };
    const holder = el('div');
    const grid = el('div');
    grid.parentNode = holder;
    const documentStub = { getElementById: (id) => byId[id] || null, createElement: (tag) => el(tag) };
    const info = (d, type) => (d.task_types || []).filter((x) => x.task_type === type)[0] || null;
    const run = new Function('document', 'auTaskTypeInfo', fnSource(adminHtml, 'function auExtendTaskModal(d){') + '\nreturn auExtendTaskModal;')(documentStub, info);
    const payload = { task_types: prestart.manualTaskOptions(), stages: [{ key: 'placement', label: 'Placement' }, { key: 'prestart', label: 'Pre-start checks' }] };
    run(payload);
    const group = byId.newTaskType.children[0];
    expect(group.label).toBe('Australian placement');
    expect(group.children.map((o) => o.value)).toEqual(prestart.MANUAL_TASK_TYPES);
    expect(group.children.map((o) => o.textContent)).toEqual(prestart.MANUAL_TASK_TYPES.map((k) => prestart.TASK_INFO[k].label));
    expect(byId.newTaskStage.children[0].children.map((o) => o.value)).toEqual(['placement', 'prestart']);
    // called twice (the form re-opened quickly): not added twice
    run(payload);
    expect(byId.newTaskType.children.length).toBe(1);
    // nothing from the server: nothing added
    const untouched = el('select');
    byId.newTaskType = untouched;
    run(null);
    expect(untouched.children).toEqual([]);
    // picking a type fills the title, the due date and the stage, and shows what to do
    byId.newTaskType = el('select');
    run(payload);
    byId.newTaskType.value = 'provider_number_new_location';
    byId.newTaskType.listeners.change();
    expect(byId.newTaskTitle.value).toBe('Medicare provider number (new location)');
    expect(byId.newTaskDue.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(byId.newTaskStage.value).toBe('prestart');
    const hint = holder.children[holder.children.length - 1];
    expect(hint.textContent).toMatch(/provider number/);
    expect(hint.textContent).toMatch(/Owner: RSO\./);
    // back to an ordinary type: the hint goes, the typed values stay
    byId.newTaskType.value = 'manual';
    byId.newTaskType.listeners.change();
    expect(hint.style.display).toBe('none');
  });

  it('a refused Australian task says why; an ordinary task behaves as it always did', () => {
    expect(modal).toContain('if(newTypeIsAu&&!createRes.ok){');
    expect(modal).toContain('closeModal();await loadAll(true);}catch(e){alert(e.message);btn.disabled=false;btn.textContent="Create";}');
  });
});

describe('Ops Queue cards for the Australian task types', () => {
  function guidedFrom(html, signature, extraSignatures) {
    const helpers = (extraSignatures || []).map((s) => fnSource(html, s)).join('\n');
    // the page helpers the function calls for OTHER kinds of task
    const stubs = ['isQualDocReviewTask', 'isMigrationAgentTask', 'isGpPassportsTask', 'isConditionsTrackerTask', 'isWaitingStatus']
      .map((n) => 'function ' + n + '(){return false;}').join(' ') + ' function rgMeta(){return {};} function rgCaseForTask(){return {};} function fmtD(){return "";}';
    return new Function(stubs + '\n' + helpers + '\n' + fnSource(html, signature) + '\nreturn getGuidedAction;')();
  }
  const adminGuided = guidedFrom(adminHtml, 'function getGuidedAction(t){', ['function auTaskMeta(t){', 'function auTaskOwnerLabel(m){']);
  const ceoGuided = guidedFrom(ceoHtml, 'function getGuidedAction(t) {', []);
  const NOW = '2026-11-21T00:00:00.000Z';
  const taskOf = (type) => {
    const fields = prestart.PRESTART_TASK_TYPES.indexOf(type) !== -1
      ? prestart.buildPrestartTask(type, { name: 'Dr Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', now: NOW })
      : prestart.buildEarlyTask(type, { name: 'Dr Test Auvr', applicationId: 'app-1', now: NOW });
    return Object.assign({ id: 'task-' + type }, fields);
  };

  it('every type: a title, a due date, an owner and a plain "what to do" line, on both dashboards', () => {
    for (const type of prestart.MANUAL_TASK_TYPES) {
      const task = taskOf(type);
      expect(task.title.length, type).toBeGreaterThan(10);
      expect(task.due_date, type).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const guided of [adminGuided(task), ceoGuided(task)]) {
        expect(guided.prompt, type).toContain(prestart.TASK_INFO[type].whatToDo);
        expect(guided.prompt, type).toMatch(/Owner: (Consultant|RSO|Consultant, then RSO)\.$/);
        expect(guided.action, type).toBeTruthy(); // a null action hides the prompt
        expect(guided.prompt).not.toMatch(/Email the practice|Supervisor CV|undefined/);
      }
      // the metadata survives being stored as text
      expect(adminGuided(Object.assign({}, task, { metadata: JSON.stringify(task.metadata) })).prompt, type).toContain(prestart.TASK_INFO[type].whatToDo);
    }
    expect(adminGuided(taskOf('start_date_tracking')).prompt).toMatch(/Owner: Consultant, then RSO\.$/);
  });

  it('the two tasks finished by recording a fact get their own button on the RSO dashboard, until the fact is recorded', () => {
    expect(adminGuided(taskOf('provider_number_new_location'))).toMatchObject({ label: 'Record number', action: 'auRecordProviderNumber' });
    expect(adminGuided(taskOf('start_date_tracking'))).toMatchObject({ label: 'Save start date', action: 'auSaveStartDate' });
    const recorded = taskOf('provider_number_new_location');
    recorded.metadata = Object.assign({}, recorded.metadata, { provider_number: '123456AB' });
    expect(adminGuided(recorded)).toMatchObject({ label: 'Mark Complete', action: 'completeTask' });
    // both actions are wired and post to the staff routes
    expect(adminHtml).toContain('else if(action==="auRecordProviderNumber"){auRecordProviderNumber(task);}');
    expect(adminHtml).toContain('else if(action==="auSaveStartDate"){auSaveStartDate(task);}');
    expect(fnSource(adminHtml, 'async function auRecordProviderNumber(task){')).toContain('"/api/admin/au/prestart/provider-number"');
    expect(fnSource(adminHtml, 'async function auSaveStartDate(task){')).toContain('"/api/admin/au/prestart/start-date"');
  });

  it('D8: a review task about an Australian doctor\'s own document is never offered "Email the practice requesting the Supervisor CV"', () => {
    for (const guided of [adminGuided, ceoGuided]) {
      for (const taskType of ['doc_review', 'review']) {
        const g = guided({ id: 't1', task_type: taskType, related_document_key: 'au_indemnity_certificate', status: 'open' });
        expect(g).toMatchObject({ label: 'Review Document', action: 'reviewFlaggedDoc' });
        expect(g.prompt).not.toMatch(/practice|Supervisor CV/i);
      }
    }
  });

  it('every other task is described exactly as before', () => {
    expect(adminGuided({ id: 't', task_type: 'verify' })).toEqual({ prompt: 'Review the evidence and verify', label: 'Review', action: 'completeTask', taskId: 't' });
    expect(adminGuided({ id: 't', task_type: 'manual' })).toEqual({ prompt: 'Complete this task', label: 'Complete', action: 'completeTask', taskId: 't' });
    expect(adminGuided({ id: 't', task_type: 'manual', metadata: { au: false, what_to_do: 'x' } }).prompt).toBe('Complete this task');
    expect(adminGuided({ id: 't', task_type: 'flagged_doc', related_document_key: 'primary_medical_degree' }).label).toBe('Review Document');
    // an overseas practice document still offers its email
    expect(adminGuided({ id: 't', task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', status: 'open' }))
      .toMatchObject({ prompt: 'Email the practice requesting the Supervisor CV', label: 'Email Practice', action: 'emailPractice' });
  });
});

describe('ADM-11: a card moved to Hired opens the placement form (CEO dashboard)', () => {
  it('the Jobs board: all three ways of moving a card hand a refusal to the placement form', () => {
    for (const signature of ['function moveCardCommit(id, stage, name, reason) {', 'function onDrawerStageChangeCommit(drawerCardId, stage, reason) {', 'function onDrawerSave() {']) {
      const src = fnSource(jobsJs, signature);
      const refused = src.indexOf('if (auHiredRefused(d)) return;');
      const moved = src.search(/applyStageMove\(|Could not save candidate/);
      expect(refused, signature).toBeGreaterThan(-1);
      expect(refused, signature).toBeLessThan(moved); // before the card is moved on screen
    }
  });

  it('auHiredRefused: takes over only for the Australian refusal; puts the card back, says why, opens the form', () => {
    const calls = [];
    const A = { toast: (m) => calls.push(['toast', m]), setOverlay: (v) => calls.push(['overlay', v]) };
    const windowStub = { atsOpenPlacementForm: (caseId, appId, d) => calls.push(['form', caseId, appId, d.placement_form]) };
    const run = new Function('A', 'window', 'renderBoard', fnSource(jobsJs, 'function auHiredRefused(d) {') + '\nreturn auHiredRefused;')(A, windowStub, () => calls.push(['renderBoard']));
    expect(run({ ok: true })).toBe(false);
    expect(run({ ok: false, message: 'Invalid stage.' })).toBe(false);
    expect(run(null)).toBe(false);
    expect(calls).toEqual([]);
    expect(run({ ok: false, code: 'au_placement_required', message: 'Record the placement.', case_id: 'case-1', application_id: 'app-1', placement_form: true })).toBe(true);
    expect(calls).toEqual([['toast', 'Record the placement.'], ['renderBoard'], ['overlay', ''], ['form', 'case-1', 'app-1', true]]);
  });

  it('the Candidates tab: its stage picker does the same, and the opener waits for the freshly loaded profile', () => {
    expect(candidatesJs).toContain("if (res && res.code === 'au_placement_required') { window.atsOpenPlacementForm(c.case_id, appId, res); return; }");
    const opener = candidatesJs.slice(candidatesJs.indexOf('window.atsOpenPlacementForm = function (caseId, appId, refusal) {'), candidatesJs.indexOf('function openOfferForm(appId) {'));
    expect(opener).toContain("window.ATS.setActiveTab('candidates', true)");
    expect(opener).toContain('window.atsOpenCandidate(caseId, { quiet: onProfile });');
    expect(opener).toContain('if (refusal && refusal.placement_form === false) return;'); // no offer yet: nothing to open
    expect(opener).toContain('currentCandidate !== before');
    expect(opener).toContain('openPlacementForm(appId, currentCandidate);');
  });

  it('the placement form: "Start date (required)" for a doctor on an Australian pathway, "Commencement date (optional)" for everyone else', () => {
    const needs = new Function('auOn', fnSource(candidatesJs, 'function auPlacementNeedsDate(c) {') + '\nreturn auPlacementNeedsDate;');
    const au = { au: { pathway: { isAu: true } } };
    expect(needs(true)(au)).toBe(true);
    expect(needs(true)({ au: { pathway: { isAu: false } } })).toBe(false);
    expect(needs(true)({})).toBe(false);
    expect(needs(true)(null)).toBe(false);
    expect(needs(false)(au)).toBe(false); // the dashboard has not been told the switch is on
    const form = fnSource(candidatesJs, 'function openPlacementForm(appId, c) {');
    expect(form).toContain("(needsDate ? 'Start date (required)' : 'Commencement date (optional)')");
    const confirm = fnSource(candidatesJs, 'function confirmPlacement(appId, c) {');
    const guard = confirm.indexOf('if (auPlacementNeedsDate(c) && !commencementDate) {');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(confirm.indexOf("window.confirm('Record this placement as secured?"));
    expect(guard).toBeLessThan(confirm.indexOf("ATS.api('/api/ats/placement'"));
    expect(candidatesJs).toContain("if (markPlBtn) { openPlacementForm(markPlBtn.getAttribute('data-app-id'), c); return; }");
  });
});

describe('cache-busters', () => {
  it('the changed scripts are re-versioned, the stylesheet is not older than the Candidates script, and the service worker moved', () => {
    const candidates = ceoHtml.match(/ceo-ats-candidates\.js\?v=(\w+)/)[1];
    const jobs = ceoHtml.match(/ceo-ats-jobs\.js\?v=(\w+)/)[1];
    const css = ceoHtml.match(/ceo-ats\.css\?v=(\w+)/)[1];
    expect(candidates).toBe('20261121c');
    expect(jobs).toBe('20261121c');
    expect(css >= candidates).toBe(true);
    expect(read('sw.js')).toContain('var VERSION = "20261121c"');
  });
});
