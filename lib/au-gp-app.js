'use strict';
/**
 * WP-12 (Australian GP build): what the GP app shows a doctor on an
 * Australian pathway after sign-in. Pure, no I/O, no switch read.
 *
 * Three things live here and nowhere else:
 *
 *   1. THE DOCTOR-FACING STEPS (APP-08). The server's ladder
 *      (lib/journey-ladders.js: placement, prestart, commenced, guarantee,
 *      complete) is what a CASE is on. A doctor is shown four steps:
 *
 *        Secure placement -> Pre-start checks -> Medicare provider number -> Start date
 *
 *      `doctorSteps(stage, facts)` maps one onto the other. The browser's
 *      copy of this mapping is in js/au-doctor.js (`stepsFor`); the server
 *      also sends the result on `auJourney.steps`, and
 *      tests/au-wp12-stage-list.test.js keeps the two in step.
 *
 *   2. THE ENTRY ROUTE (APP-09): where "what do I do next" leads. For an
 *      Australian doctor it is the pre-start page once a placement is
 *      recorded and Careers before that; never the first overseas step.
 *
 *   3. THE PRE-START CHECKLIST (APP-13): `buildPrestartChecklist` turns the
 *      rows server.js read (tasks, documents, credentials, what the doctor
 *      recorded) into the lines the doctor reads. It never copies a staff
 *      field: a task's what_to_do / done_when / title, a document's staff
 *      label and any staff note stay on the server.
 *
 * Every string a doctor can read from this file is scanned for the
 * AGENT-RULES section 4 words (tests/au-wp12-banned-words.test.js).
 */

const journeyLadders = require('./journey-ladders.js');

const ROUTES = Object.freeze({
  CAREERS: '/pages/career',
  PRESTART: '/pages/prestart',
  PROVIDER_NUMBER: '/pages/pbs',
  DOCUMENTS: '/pages/my-documents',
  HOME: '/pages/index'
});

// The four steps, in order. `key` is stable (the browser and the tests use it).
const DOCTOR_STEPS = Object.freeze([
  Object.freeze({ key: 'placement', title: 'Secure placement', href: ROUTES.CAREERS,
    description: 'Find the practice that suits you, interview and sign.' }),
  Object.freeze({ key: 'prestart', title: 'Pre-start checks', href: ROUTES.PRESTART,
    description: 'The short list to finish before your first day.' }),
  Object.freeze({ key: 'provider_number', title: 'Medicare provider number', href: ROUTES.PROVIDER_NUMBER,
    description: 'Your new practice location needs its own provider number.' }),
  Object.freeze({ key: 'start', title: 'Start date', href: ROUTES.PRESTART + '#start-date',
    description: 'Your start date, agreed with you and the practice.' })
]);

const WAITING_ON_PLACEMENT = 'Opens once your placement is secured';

function isStarted(stage) {
  return stage === 'commenced' || stage === 'guarantee' || stage === 'complete';
}

/**
 * The four steps with their state for one doctor.
 *
 * @param {string} stage  the case stage on the Australian ladder. Anything
 *   that is not on it reads as `placement` (the first rung), never an
 *   overseas stage.
 * @param {{ prestartDone?: boolean, providerNumberRecorded?: boolean, startDateConfirmed?: boolean }} [facts]
 *   optional detail, known only where the pre-start rows were read. Without
 *   it a doctor in pre-start has step 2 current and steps 3 and 4 open.
 * @returns {Array<{ key, title, description, href, num, state: 'done'|'current'|'open'|'locked', done, locked, lockReason }>}
 */
function doctorSteps(stage, facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const onLadder = journeyLadders.AU_STAGES.indexOf(String(stage || '')) !== -1;
  const s = onLadder ? String(stage) : 'placement';
  const started = isStarted(s);
  const placed = s !== 'placement';
  const states = {
    placement: placed ? 'done' : 'current',
    prestart: !placed ? 'locked' : (started || f.prestartDone === true ? 'done' : 'current'),
    provider_number: !placed ? 'locked' : (started || f.providerNumberRecorded === true ? 'done' : 'open'),
    start: !placed ? 'locked' : (started ? 'done' : (f.startDateConfirmed === true ? 'current' : 'open'))
  };
  // Exactly one "current" where possible: the first step that is not done.
  if (placed && !started && states.prestart === 'done') {
    if (states.provider_number !== 'done') states.provider_number = 'current';
  }
  return DOCTOR_STEPS.map(function (step, index) {
    const state = states[step.key];
    return {
      key: step.key, title: step.title, description: step.description, href: step.href, num: index + 1,
      state, done: state === 'done', locked: state === 'locked',
      lockReason: state === 'locked' ? WAITING_ON_PLACEMENT : null
    };
  });
}

/** Where "start / continue" leads for a doctor on an Australian pathway. */
function entryRouteForStage(stage) {
  return journeyLadders.AU_STAGES.indexOf(String(stage || '')) > 0 ? ROUTES.PRESTART : ROUTES.CAREERS;
}

/**
 * The neutral name for the people at GP Link (D19): a consultant looks after
 * an Australian GP until placement, a small team after it. No job title that
 * belongs to the registration journey.
 */
function teamLabel(placed) {
  return placed ? 'your GP Link team' : 'your GP Link consultant';
}

// ── the pre-start checklist ──────────────────────────────────────────────────

const WHO = Object.freeze({ YOU: 'you', GP_LINK: 'gp_link', PRACTICE: 'practice', GP_LINK_AND_PRACTICE: 'gp_link_and_practice' });
const WHO_LABEL = Object.freeze({
  you: 'You',
  gp_link: 'GP Link',
  practice: 'The practice',
  gp_link_and_practice: 'GP Link and the practice'
});
const STATUS = Object.freeze({ DONE: 'done', TODO: 'todo', WAITING: 'waiting', ATTENTION: 'attention' });
const STATUS_LABEL = Object.freeze({ done: 'Done', todo: 'To do', waiting: 'In progress', attention: 'Needs another look' });

function taskOf(tasks, type) {
  const list = (Array.isArray(tasks) ? tasks : []).filter(function (t) { return t && t.task_type === type; });
  if (!list.length) return null;
  const open = list.filter(function (t) { return t.status !== 'completed' && t.status !== 'cancelled'; });
  return { any: true, done: open.length === 0 && list.some(function (t) { return t.status === 'completed'; }), row: open[0] || list[0] };
}

function docOf(documents, key) {
  return (Array.isArray(documents) ? documents : []).filter(function (d) { return d && d.key === key; })[0] || null;
}

function item(key, title, status, who, whatToDo, extra) {
  return Object.assign({
    key, title, status, statusLabel: STATUS_LABEL[status], who, whoLabel: WHO_LABEL[who], whatToDo, action: null
  }, extra || {});
}

function documentItem(doc) {
  const st = String(doc.status || 'pending');
  if (st === 'approved') return item('doc_' + doc.key, doc.label, STATUS.DONE, WHO.YOU, 'On file and checked. Nothing more to do.', { documentKey: doc.key });
  if (st === 'rejected') {
    return item('doc_' + doc.key, doc.label, STATUS.ATTENTION, WHO.YOU,
      'We could not accept the file you sent. Please upload it again.',
      { documentKey: doc.key, note: String(doc.note || '').slice(0, 400), action: { kind: 'upload', documentKey: doc.key, label: 'Upload again' } });
  }
  if (st === 'uploaded' || st === 'under_review') {
    return item('doc_' + doc.key, doc.label, STATUS.WAITING, WHO.GP_LINK, 'You have uploaded this. We are checking it.', { documentKey: doc.key });
  }
  return item('doc_' + doc.key, doc.label, STATUS.TODO, WHO.YOU, String(doc.short || 'Please upload this.'),
    { documentKey: doc.key, action: { kind: 'upload', documentKey: doc.key, label: 'Upload' } });
}

/**
 * The checklist a placed doctor reads.
 *
 * @param {object} input
 *   placement      { key, practiceName, startDate } | null
 *   tasks          rows { task_type, status, metadata } for this placement
 *                  (pre-start types) plus reference_check for the case
 *   documents      the doctor's own items from buildAuDocumentsView (phase
 *                  'prestart', provider 'you')
 *   registerChecked  boolean: staff have checked the public register
 *   registerCheckOpen boolean: a register-check task is still open
 *   details        lib/au-doctor-details.js doctorView(...)
 *   providerNumber { recorded, number, locationName } for the new location
 * @returns {{ items: Array<object>, complete: boolean, counts: { done, total },
 *   startDate: string|null, startDateConfirmed: boolean, facts: object }}
 */
function buildPrestartChecklist(input) {
  const i = input && typeof input === 'object' ? input : {};
  const tasks = Array.isArray(i.tasks) ? i.tasks : [];
  const documents = Array.isArray(i.documents) ? i.documents : [];
  const details = i.details && typeof i.details === 'object' ? i.details : {};
  const provider = i.providerNumber && typeof i.providerNumber === 'object' ? i.providerNumber : {};
  const practice = String((i.placement && i.placement.practiceName) || '').trim() || 'your new practice';
  const items = [];

  // 1. Ahpra register check (GP Link).
  if (i.registerChecked === true && i.registerCheckOpen !== true) {
    items.push(item('register_check', 'Ahpra register check', STATUS.DONE, WHO.GP_LINK,
      'We have checked your registration on the public Ahpra register. Nothing for you to do.'));
  } else {
    items.push(item('register_check', 'Ahpra register check', STATUS.WAITING, WHO.GP_LINK,
      'We check your registration on the public Ahpra register. Nothing for you to do.'));
  }

  // 2. Notice given (the doctor).
  if (details.noticeGiven === true) {
    items.push(item('notice', 'Notice to your current practice', STATUS.DONE, WHO.YOU,
      'You told us you gave notice' + (details.noticeGivenDate ? ' on ' + details.noticeGivenDate : '') + '.',
      { noticeGivenDate: details.noticeGivenDate || null, action: { kind: 'notice', label: 'Change the date' } }));
  } else {
    items.push(item('notice', 'Notice to your current practice', STATUS.TODO, WHO.YOU,
      'Once you have given notice, tell us the date. We never contact your current practice without asking you first.',
      { action: { kind: 'notice', label: 'I have given notice' } }));
  }

  // 3. Start date (GP Link and the practice).
  const startTask = taskOf(tasks, 'start_date_tracking');
  const startMeta = (startTask && startTask.row && startTask.row.metadata) || {};
  const confirmedStart = String(startMeta.confirmed_start_date || '').slice(0, 10);
  const startDateConfirmed = !!(startTask && startTask.done && confirmedStart);
  const startDate = confirmedStart || String((i.placement && i.placement.startDate) || '').slice(0, 10) || null;
  if (startDateConfirmed) {
    items.push(item('start_date', 'Start date confirmed', STATUS.DONE, WHO.GP_LINK_AND_PRACTICE,
      'Your start date at ' + practice + ' is confirmed: ' + confirmedStart + '.', { startDate: confirmedStart }));
  } else {
    items.push(item('start_date', 'Start date confirmed', STATUS.WAITING, WHO.GP_LINK_AND_PRACTICE,
      startDate
        ? 'The date in your offer is ' + startDate + '. We confirm it with you and ' + practice + ' once your notice period is known.'
        : 'We agree a start date with you and ' + practice + ' once your notice period is known.',
      { startDate }));
  }

  // 4. Indemnity certificate (the doctor uploads; WP-07's card).
  const indemnity = docOf(documents, 'au_indemnity_certificate');
  if (indemnity) {
    const d = documentItem(indemnity);
    d.key = 'indemnity';
    d.title = 'Indemnity certificate of currency';
    if (d.status === STATUS.TODO) d.whatToDo = 'Upload your current certificate of currency from your indemnity insurer.';
    items.push(d);
  }

  // 5. Provider number for the new location (the doctor applies; we help).
  if (provider.recorded === true) {
    items.push(item('provider_number', 'Medicare provider number for ' + practice, STATUS.DONE, WHO.YOU,
      'Your provider number for this location is on file.', { action: { kind: 'link', href: ROUTES.PROVIDER_NUMBER, label: 'View' } }));
  } else {
    items.push(item('provider_number', 'Medicare provider number for ' + practice, STATUS.TODO, WHO.YOU,
      'Your new practice location needs its own provider number. Apply through Services Australia, then tell us the number.',
      { action: { kind: 'link', href: ROUTES.PROVIDER_NUMBER, label: 'Open this step' } }));
  }

  // 6. Referees (the doctor gives the details; we take the references).
  const refTask = taskOf(tasks, 'reference_check');
  const refsDoc = docOf(i.allDocuments, 'au_references');
  const refsFiled = !!(refTask && refTask.done) || !!(refsDoc && refsDoc.status === 'approved');
  const refsGiven = Array.isArray(details.referees) && details.referees.length === 2;
  if (refsFiled) {
    items.push(item('referees', 'Reference checks', STATUS.DONE, WHO.GP_LINK, 'Your reference checks are complete.'));
  } else if (refsGiven) {
    items.push(item('referees', 'Reference checks', STATUS.WAITING, WHO.GP_LINK,
      'Thank you. We have your two referees and will contact them. We never contact your current practice without asking you first.',
      { action: { kind: 'referees', label: 'Change referees' } }));
  } else {
    items.push(item('referees', 'Reference checks', STATUS.TODO, WHO.YOU,
      'Give us two referees who have agreed to be contacted. Tell us if either is at your current practice, and we will ask you before we call them.',
      { action: { kind: 'referees', label: 'Add two referees' } }));
  }

  // 7. Practice credentialing (GP Link and the practice).
  const packTask = taskOf(tasks, 'credentialing_pack');
  if (packTask && packTask.done) {
    items.push(item('credentialing', 'Practice credentialing', STATUS.DONE, WHO.GP_LINK_AND_PRACTICE,
      'Your credentialing pack has gone to ' + practice + '.'));
  } else {
    items.push(item('credentialing', 'Practice credentialing', STATUS.WAITING, WHO.GP_LINK_AND_PRACTICE,
      'Once your registration check and indemnity certificate are in, we send your credentialing pack to ' + practice + '. Nothing for you to do.'));
  }

  // 8. The other required pre-start documents.
  documents.forEach(function (doc) {
    if (!doc || doc.key === 'au_indemnity_certificate' || doc.required !== true) return;
    items.push(documentItem(doc));
  });

  const done = items.filter(function (x) { return x.status === STATUS.DONE; }).length;
  const prestartKeys = items.filter(function (x) { return x.key !== 'provider_number' && x.key !== 'start_date'; });
  return {
    items,
    complete: done === items.length,
    counts: { done, total: items.length },
    startDate,
    startDateConfirmed,
    facts: {
      prestartDone: prestartKeys.every(function (x) { return x.status === STATUS.DONE; }),
      providerNumberRecorded: provider.recorded === true,
      startDateConfirmed
    }
  };
}

/**
 * The provider-number step (APP-12). For a GP already practising in
 * Australia the usual case is a provider number for the new location only;
 * a prescriber number is something they already hold. Regulatory detail is
 * NOT confirmed: the wording asserts nothing beyond "your new practice
 * location needs its own provider number". Correct it here.
 *
 * @param {string} variant  hooks.medicarePbsVariant from lib/placement-hooks.js
 */
function providerNumberStep(variant, input) {
  const i = input && typeof input === 'object' ? input : {};
  const practice = String(i.practiceName || '').trim() || 'your new practice';
  const out = {
    variant: String(variant || 'provider_number_new_location'),
    providerNumberOnly: true,
    heading: 'Medicare provider number',
    intro: 'Your new practice location needs its own provider number. You apply to Services Australia; we keep track with you and record the number once it is issued.',
    steps: [
      'Tell us the provider and prescriber numbers you already hold, so we have them on file.',
      'Apply to Services Australia for a provider number for ' + practice + '.',
      'When the number arrives, enter it here. We let ' + practice + ' know.'
    ],
    prescriberNote: 'If you already hold a prescriber number, add it below so we have it on file. This step does not ask you to apply for one.',
    extraNote: ''
  };
  if (out.variant === 'provider_number_plus_19ab_check' || out.variant === 'provider_number_plus_program_approval') {
    out.extraNote = 'Your GP Link team will confirm whether anything else is needed for your situation before you apply. Please wait to hear from us.';
  }
  return out;
}

module.exports = {
  ROUTES, DOCTOR_STEPS, WAITING_ON_PLACEMENT, WHO, WHO_LABEL, STATUS, STATUS_LABEL,
  doctorSteps, entryRouteForStage, teamLabel, isStarted,
  buildPrestartChecklist, providerNumberStep
};
