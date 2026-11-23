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
 *      recorded and Careers before that; never a step of the other journey.
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
 *   stage of the other journey.
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

// ── the one state every screen draws from (FB-2b) ───────────────────────────

/**
 * FB-2b (W3-D12, W3-D13, W3-D14, A1, A5): the ONE value that says where a
 * doctor on an Australian pathway is, worked out on the server and sent on
 * `GET /api/gp/au-prestart` as `viewState`. Home, Careers and the pre-start
 * page each draw from it; none of them works it out again from dates, stages
 * or statuses.
 *
 *   looking       no current placement (before the first one, or looking
 *                 again): roles
 *   prestart      placed, pre-start in progress
 *   cleared       placed, pre-start complete (cleared to start)
 *   first_week    started, in the first week
 *   settling_in   started, after the first week, the settling-in period
 *                 still running (no pre-start counter any more)
 *   settled       that period has finished and the doctor is still there
 *   ended         the placement has ended
 *
 * The word for the period after the first week, to a doctor, is "settling
 * in": the commercial term never reaches them (section 25).
 */
const VIEW_STATE = Object.freeze({
  LOOKING: 'looking', PRESTART: 'prestart', CLEARED: 'cleared',
  FIRST_WEEK: 'first_week', SETTLING_IN: 'settling_in', SETTLED: 'settled', ENDED: 'ended'
});
const STARTED_VIEW_STATES = Object.freeze([VIEW_STATE.FIRST_WEEK, VIEW_STATE.SETTLING_IN, VIEW_STATE.SETTLED]);

/**
 * @param {{ placed?: boolean, placementEnded?: boolean, phase?: string, prestartComplete?: boolean }} input
 *   `phase` is lib/au-lifecycle.js placementPhase() of the doctor's current
 *   placement row ('' when there is none, or it has no row yet).
 * @returns {string} one of VIEW_STATE
 */
function doctorViewState(input) {
  const i = input && typeof input === 'object' ? input : {};
  if (i.placementEnded === true) return VIEW_STATE.ENDED;
  if (i.placed !== true) return VIEW_STATE.LOOKING;
  const phase = String(i.phase || '');
  if (phase === 'settled') return VIEW_STATE.SETTLED;
  if (phase === 'settling_in') return VIEW_STATE.SETTLING_IN;
  if (phase === 'first_week') return VIEW_STATE.FIRST_WEEK;
  if (phase === 'ended' || phase === 'cancelled') return VIEW_STATE.ENDED;
  return i.prestartComplete === true ? VIEW_STATE.CLEARED : VIEW_STATE.PRESTART;
}

// ── My Documents: the sentence above the list, per state (FB-2b, W3-D17) ────

/**
 * W3-D17 (R7). The line above "You provide" used to say the same thing to
 * everyone: "Only your CV is needed to apply for roles; the rest we ask for
 * once you have accepted a position." That is untrue for a doctor who cannot
 * apply yet (held: segments B and C), out of date for one who has accepted a
 * position, and beside the point for one who has started.
 *
 * @param {'held'|'looking'|'placed'|'started'} state
 * @param {{ practiceName?: string }} [facts]
 * @returns {{ state: string, lead: string }}
 */
const DOCUMENTS_STATE = Object.freeze({ HELD: 'held', LOOKING: 'looking', PLACED: 'placed', STARTED: 'started' });
function documentsLead(state, facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const practice = String(f.practiceName || '').trim();
  const st = [DOCUMENTS_STATE.HELD, DOCUMENTS_STATE.PLACED, DOCUMENTS_STATE.STARTED].indexOf(String(state)) !== -1 ? String(state) : DOCUMENTS_STATE.LOOKING;
  if (st === DOCUMENTS_STATE.HELD) {
    return { state: st, lead: 'You do not need to upload anything yet. Our team is confirming a few details with you first, and we will tell you which documents we need and when. Anything you add here in the meantime is kept safely on your file.' };
  }
  if (st === DOCUMENTS_STATE.PLACED) {
    return { state: st, lead: 'These are the documents we need before your first day' + (practice ? ' at ' + practice : '') + '. The ones marked "Needed before you start" are on your pre-start checklist too: upload each one once, in either place.' };
  }
  if (st === DOCUMENTS_STATE.STARTED) {
    return { state: st, lead: 'This is what we hold on file for you. Where a document has an end date it is shown on the card, and we will remind you before it runs out so you can upload the new one.' };
  }
  return { state: st, lead: 'Upload these when you have them. Only your CV is needed to apply for roles; the rest we ask for once you have accepted a position.' };
}

// ── the pre-start checklist ──────────────────────────────────────────────────

const WHO = Object.freeze({ YOU: 'you', GP_LINK: 'gp_link', PRACTICE: 'practice', GP_LINK_AND_PRACTICE: 'gp_link_and_practice' });
const WHO_LABEL = Object.freeze({
  you: 'You',
  gp_link: 'GP Link',
  practice: 'The practice',
  gp_link_and_practice: 'GP Link and the practice'
});
const auPrestart = require('./au-prestart.js');
const STATUS = Object.freeze({ DONE: 'done', TODO: 'todo', WAITING: 'waiting', ATTENTION: 'attention' });
const STATUS_LABEL = Object.freeze({ done: 'Done', todo: 'To do', waiting: 'In progress', attention: 'Needs another look' });
// FB-2b (A3): what a card that is shown but NOT counted towards "pre-start
// complete" says beside its title. Something the doctor may do: "Optional".
// Something GP Link does that the doctor only watches: "For your information".
const NOT_COUNTED_LABEL = Object.freeze({ you: 'Optional', other: 'For your information' });
// FB-2b (W3-D14): after the doctor has started, a counted item that is still
// open is no longer "To do before your first day". It is "Still needed", with
// the reason.
const STILL_NEEDED_LABEL = 'Still needed';

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

  // WP-13: the day staff confirmed the doctor actually started ('' until then).
  const commencedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(i.commencedAt || '').slice(0, 10)) ? String(i.commencedAt).slice(0, 10) : '';

  // 2. Notice given (the doctor).
  if (commencedAt && details.noticeGiven !== true) {
    // The doctor has started: asking them to "tell us once you have given
    // notice" would no longer be true. The item stays (same list, same
    // place), closed, with nothing to do.
    items.push(item('notice', 'Notice to your current practice', STATUS.DONE, WHO.YOU,
      'You have started at ' + practice + ', so there is nothing more to do here.'));
  } else if (details.noticeGiven === true) {
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
  const startDate = commencedAt || confirmedStart || String((i.placement && i.placement.startDate) || '').slice(0, 10) || null;
  if (commencedAt) {
    // The truthful state after commencement: not "start date confirmed" for a
    // day that has passed, but "you have started".
    items.push(item('start_date', 'You have started', STATUS.DONE, WHO.GP_LINK_AND_PRACTICE,
      'You started at ' + practice + ' on ' + commencedAt + '. We will check in with you over your first weeks.',
      { startDate: commencedAt, started: true }));
  } else if (startDateConfirmed) {
    items.push(item('start_date', 'Start date confirmed', STATUS.DONE, WHO.GP_LINK_AND_PRACTICE,
      'Your start date at ' + practice + ' is confirmed: ' + confirmedStart + '.', { startDate: confirmedStart }));
  } else {
    items.push(item('start_date', 'Start date confirmed', STATUS.WAITING, WHO.GP_LINK_AND_PRACTICE,
      startDate
        ? 'Your expected start date is ' + startDate + '. We confirm it with you and ' + practice + ' once your notice period is known.'
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
  } else if (provider.pending === true) {
    // FR-1 (R-03): the doctor entered a number; it is theirs until our team
    // confirms it. Never shown as done, never counted.
    items.push(item('provider_number', 'Medicare provider number for ' + practice, STATUS.WAITING, WHO.GP_LINK,
      'Thanks, we have the number you entered. We are confirming it; there is nothing more for you to do here.',
      { action: { kind: 'link', href: ROUTES.PROVIDER_NUMBER, label: 'View' } }));
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

  // FB-2a (W3-D21): "complete" and the count come from THE definition
  // (lib/au-prestart.js prestartCompletion), the same one staff, "Confirm
  // commenced" and N16 use: the four pre-start tasks and the required
  // pre-start documents. Every card says whether it is part of that
  // (`required`); the others (the register check, notice, referees) are shown
  // and never counted.
  const completion = auPrestart.prestartCompletion({
    tasks: tasks.filter(function (t) { return t && auPrestart.PRESTART_TASK_TYPES.indexOf(t.task_type) !== -1; }),
    requiredDocumentKeys: auPrestart.requiredPrestartDocumentKeys(documents.map(function (d) { return Object.assign({ phase: 'prestart', provider: 'you' }, d); })),
    approvedDocumentKeys: documents.filter(function (d) { return d && String(d.status || '').toLowerCase() === 'approved'; }).map(function (d) { return d.key; })
  });
  const REQUIRED_ITEM_KEYS = { start_date: true, indemnity: true, provider_number: true, credentialing: true };
  items.forEach(function (x) {
    x.required = REQUIRED_ITEM_KEYS[x.key] === true || (x.documentKey && completion.required.documents.indexOf(x.documentKey) !== -1 && x.key.indexOf('doc_') === 0);
    x.required = x.required === true;
    // FB-2b (A3): a card that is not counted says so on screen.
    x.optional = !x.required;
    x.countLabel = x.required ? '' : (x.who === WHO.YOU ? NOT_COUNTED_LABEL.you : NOT_COUNTED_LABEL.other);
  });
  // FB-2b (W3-D14, R3): once the doctor has started, the list is a record of
  // what was finished plus what is genuinely still needed. A counted item
  // that is still open says "Still needed" and why; an uncounted one that
  // the doctor never did is closed off (nobody is asked for referees or a
  // notice date for a job they have already started).
  if (commencedAt) {
    items.forEach(function (x) {
      if (x.status === STATUS.DONE) return;
      if (x.required) {
        x.stillNeeded = true;
        x.statusLabel = x.status === STATUS.WAITING ? STATUS_LABEL.waiting : STILL_NEEDED_LABEL;
        x.why = x.key === 'credentialing'
          ? 'We are finishing this with ' + practice + '. Nothing for you to do.'
          : (x.key === 'provider_number'
            ? (x.status === STATUS.WAITING
              ? 'We have the number you entered and are confirming it.'
              : 'Your new practice location needs its own provider number, so we still need this from you.')
            : (x.status === STATUS.WAITING
              ? 'We have this from you and are checking it.'
              : 'We still need this on file for your placement at ' + practice + '.'));
      } else if (x.key === 'referees' && x.status === STATUS.TODO) {
        x.status = STATUS.DONE;
        x.statusLabel = 'Not needed now';
        x.whatToDo = 'You have started at ' + practice + ', so we no longer need referees from you here. If that changes we will ask you.';
        x.action = null;
        x.closedByStart = true;
      }
    });
  }
  const prestartKeys = items.filter(function (x) { return x.key !== 'provider_number' && x.key !== 'start_date'; });
  return {
    items,
    complete: completion.complete,
    counts: completion.counts,
    // What is still outstanding, in the same terms staff are shown.
    outstanding: { tasks: completion.missing.concat(completion.open), documents: completion.documentsOutstanding },
    startDate,
    // FB-2b: split in two for the screens. `startDateConfirmed` (below) also
    // turns true at commencement; this one is only ever "staff confirmed the
    // date with the practice", and `startDateSource` says where the date
    // shown came from: 'started' | 'confirmed' | 'expected' | ''.
    startDateSource: commencedAt ? 'started' : (startDateConfirmed ? 'confirmed' : (startDate ? 'expected' : '')),
    stillNeeded: items.filter(function (x) { return x.stillNeeded === true; }).map(function (x) { return x.key; }),
    startDateConfirmed: startDateConfirmed || !!commencedAt,
    // WP-13: true once staff have confirmed the doctor started work.
    started: !!commencedAt,
    startedOn: commencedAt || null,
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
const PROVIDER_VARIANTS = Object.freeze(['provider_number_new_location', 'provider_number_plus_19ab_check', 'provider_number_plus_program_approval']);
function providerNumberStep(variant, input) {
  const i = input && typeof input === 'object' ? input : {};
  const practice = String(i.practiceName || '').trim() || 'your new practice';
  const out = {
    // only the three Australian variants are ever passed on; anything else
    // (including the other journey's own value) reads as the plain case
    variant: PROVIDER_VARIANTS.indexOf(String(variant)) !== -1 ? String(variant) : PROVIDER_VARIANTS[0],
    providerNumberOnly: true,
    heading: 'Medicare provider number',
    intro: 'Your new practice location needs its own provider number. You apply to Services Australia; we keep track with you and record the number once it is issued.',
    steps: [
      'Tell us the provider and prescriber numbers you already hold, so we have them on file.',
      'Apply to Services Australia for a provider number for ' + practice + '.',
      'When the number arrives, enter it here so we have it on file.'
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
  NOT_COUNTED_LABEL, STILL_NEEDED_LABEL, VIEW_STATE, STARTED_VIEW_STATES, doctorViewState,
  DOCUMENTS_STATE, documentsLead,
  doctorSteps, entryRouteForStage, teamLabel, isStarted,
  buildPrestartChecklist, providerNumberStep
};
