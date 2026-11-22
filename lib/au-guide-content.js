'use strict';

/**
 * Australian GP build, WP-26: the staff guide for an Australian placement.
 *
 * The guide panel (js/guide-panel.js) shows folders of items; an item is a
 * title and an address shown in a frame (until now always a Scribe how-to).
 * These pages are the default Australian content. They are plain words kept in
 * THIS file and served by GET /api/admin/guide/au/<topic> (staff only, switch
 * on only). The CEO adds them to the guide with one click ("Add the Australian
 * guide"), after which each is an ordinary guide item: it can be renamed,
 * moved, deleted or replaced with a Scribe of their own.
 *
 * Nothing here is sent to a doctor or a practice. Pure: no I/O.
 *
 * Keep it true to the build: the rules are in docs/au-gp/CONVENTIONS.md
 * (sections 17, 23, 25, 26). The regulatory details are unconfirmed and say so.
 */

const FOLDER_NAME = 'Australian GP placements';
const PATH_PREFIX = '/api/admin/guide/au/';

const TOPICS = Object.freeze([
  {
    key: 'overview',
    title: 'Australian placements: the whole checklist',
    intro: 'A GP who is already registered and working in Australia does not go through MyIntealth, AMC, AHPRA registration or a visa. Their case has five stages: Placement, Pre-start, Commenced, Guarantee period, Complete.',
    sections: [
      { heading: 'Who does what', list: [
        'The placing consultant owns the doctor until a placement is recorded. No RSO is attached before pre-start.',
        'An RSO is assigned when the placement is recorded, for the pre-start checks.',
        'The CEO records the invoice and closes the case.'
      ] },
      { heading: 'The fifteen steps', ordered: true, list: [
        'Ahpra register check (consultant or CEO): Candidates, open the doctor, "Ahpra register check".',
        '19AB and DPA check, segments B and C only (consultant): the "Segment B" card, or the task under "Tasks on this case".',
        'Reference checks, two referees (consultant): "Tasks on this case".',
        'Restraint-of-trade check (consultant): "Tasks on this case".',
        'Contract signed: the CEO files the contract on the application card ("Upload contract") and releases it to the doctor on the Contracts tab. If the doctor signs on paper, "Mark placement secured" records the placement with the start date.',
        'Notice period and confirmed start date (consultant, then RSO): "Pre-start" panel, "Save start date".',
        'Indemnity certificate (RSO): approve the doctor\'s certificate under Documents.',
        'Medicare provider number for the new location (RSO): "Pre-start" panel, "Record number".',
        'Practice credentialing pack (RSO): mark complete once the pack has gone to the practice.',
        'Sponsorship transfer, segment B only: the "Segment B" card.',
        'Supervision or change of circumstances, segments B and C only: the "Segment B" card.',
        'Confirm commenced (consultant or CEO): the "Commencement and guarantee" card.',
        'Placement-fee invoice (CEO): "Mark invoice sent", then "Mark invoice paid".',
        'Guarantee check-ins at weeks 4, 8 and 12 (consultant): "Tasks on this case".',
        'Close the case, or record that the doctor left (CEO): the "Commencement and guarantee" card.'
      ] },
      { heading: 'Segments', list: [
        'Segment A (Australian VR): launched. Everything above applies.',
        'Segment B (restricted: section 19AB or a sponsor-tied visa) and segment C (non-VR, registrar): built but not launched. The doctor is held and flagged to staff; staff may put them forward by hand.'
      ] }
    ]
  },
  {
    key: 'ahpra-register-check',
    title: 'The Ahpra register check',
    intro: 'Nothing in the app looks at the Ahpra website. A person opens the public register, finds the doctor, and records what it shows.',
    sections: [
      { heading: 'How', ordered: true, list: [
        'CEO dashboard, Candidates, open the doctor. Find the "Ahpra register check" card.',
        'Press "Open the public Ahpra register" and search by the registration number and name.',
        'Record the registration type, the expiry date, whether the doctor is on the specialist register as a GP, and any conditions, undertakings or notations exactly as written.',
        'Press "Save as verified". If the number does not match the doctor, press "Number not matched": the doctor is asked to check it.'
      ] },
      { heading: 'What saving does', list: [
        'It confirms the doctor\'s pathway and closes the check task.',
        'A VR doctor with nothing flagged is told they are verified. A condition, undertaking or notation, or a segment B or C result, raises a "Segment decision" task instead and the doctor is told nothing until a person decides.',
        'The check comes round again each year, or when the registration is within 60 days of its expiry.'
      ] }
    ]
  },
  {
    key: '19ab',
    title: 'Section 19AB and DPA roles',
    intro: 'A doctor is limited to roles in a Distribution Priority Area until a staff member confirms that section 19AB does not apply to them. The doctor\'s own answer is never enough. This rule has not been confirmed with a regulator: if in doubt, leave the doctor limited.',
    sections: [
      { heading: 'How to confirm', ordered: true, list: [
        'Open the doctor on the Candidates tab. On the "Pathway" card choose "19AB does not apply" or "19AB applies" and press "Confirm 19AB".',
        'For a segment B or C doctor the "Segment B" card has the same question with an end date and a note, and closes the 19AB task for the role.',
        'An exemption letter is filed in the doctor\'s "Section 19AB exemption letter" document slot.'
      ] },
      { heading: 'Checking a role', list: [
        'On the doctor\'s profile, "Role eligibility" says for each open role whether the doctor fits and why not.',
        'A role whose DPA status is unknown is treated as closed to a limited doctor: ask the practice and set it on the job.'
      ] }
    ]
  },
  {
    key: 'prestart',
    title: 'Pre-start tasks: what each is and how to finish it',
    intro: 'When a placement is recorded the case moves to Pre-start and these tasks are raised. Some are finished by a fact, not a tick: the app will not let them be ticked off empty.',
    sections: [
      { heading: 'Before the placement (consultant)', list: [
        'Reference checks: the doctor gives two referees on their pre-start page; you see them on the "Pre-start" panel. Mark the task done once both are checked. With no referees on file it can only be closed with a written reason. Filing the completed checks in the "Reference checks" document slot closes it automatically.',
        'Restraint-of-trade check: record what the current contract says (no restraint, a restraint that does not cover this role, or one that applies) and a note.',
        '19AB and DPA check (segments B and C): see the 19AB guide.'
      ] },
      { heading: 'After the placement', list: [
        'Notice period and confirmed start date (consultant, then RSO): "Save start date". Saving the date closes the task and re-dates the other pre-start tasks.',
        'Indemnity certificate (RSO): closes by itself when the doctor\'s certificate of currency is approved under Documents. You can file it for the doctor.',
        'Medicare provider number for the new location (RSO): "Record number" (six digits and two characters, for example 123456AB). Recording it closes the task.',
        'Practice credentialing pack (RSO): raised once the Ahpra check is done and the indemnity certificate is approved. Mark it complete when the pack has gone to the practice.'
      ] },
      { heading: 'Asking for something', list: [
        '"Ask the doctor for these" on the Pre-start panel sends the doctor one email listing the documents still needed (at most once a day for the same list).'
      ] },
      { heading: 'Pre-start complete', list: [
        'Complete means the four pre-start tasks are done and every required document is approved. The doctor is then told they are cleared to start.'
      ] }
    ]
  },
  {
    key: 'commencement-invoice',
    title: 'Commencement and the invoice',
    intro: 'The placement fee is invoiced on commencement. Nothing commercial is ever shown or sent to the doctor.',
    sections: [
      { heading: 'Confirm commenced (consultant or CEO)', ordered: true, list: [
        'On the "Commencement and guarantee" card enter the day the doctor actually started and the sessions a week.',
        'The date cannot be in the future (on the practice\'s own clock) or before the placement was recorded.',
        'If the pre-start checklist is not complete you must tick the override and say why (at least 10 characters).',
        'Confirming creates the invoice task, the first-week check-in and the week 4, 8 and 12 check-ins, and moves the case to Commenced.'
      ] },
      { heading: 'The invoice (CEO)', list: [
        '"Mark invoice sent": the date and the invoice number. This closes the invoice task. A plain tick is refused.',
        '"Mark invoice paid": the date it was paid.',
        'The fee shown comes from the practice agreement and the sessions a week. If sessions are not on file the fee is not guessed.'
      ] },
      { heading: 'Mistakes (CEO)', list: [
        '"Correct" changes the date or the sessions and re-dates everything that follows.',
        '"Commencement recorded in error" undoes it and returns the case to Pre-start. It is refused once an invoice is recorded as sent.'
      ] }
    ]
  },
  {
    key: 'guarantee',
    title: 'Guarantee check-ins and closing the case',
    intro: 'The guarantee period is twelve weeks from commencement. The doctor never reads the word "guarantee": for them this period is "settling in".',
    sections: [
      { heading: 'Check-ins (consultant)', list: [
        'First week, then weeks 4, 8 and 12. Each is a task with a due date; they are listed in date order.',
        'Speak to the doctor and the practice, then mark the task done with a short note of what each said.',
        'A check-in is due on its day and overdue only from the day after.'
      ] },
      { heading: 'If the doctor leaves', list: [
        'During the period: "Doctor left during the guarantee" with the last working day and the reason. The credit is worked out from the agreement where it can be; where it cannot the CEO decides.',
        'After the period: "Placement ended" (no credit question).',
        'Either way the case is completed and the doctor can apply again.'
      ] },
      { heading: 'Closing', list: [
        'The case completes by itself the day after the period ends. The CEO can also press "Close case" once it has ended.'
      ] }
    ]
  },
  {
    key: 'not-done',
    title: 'What is NOT done for an Australian doctor',
    intro: 'These belong to the overseas journey. The app refuses them on an Australian case, and the buttons are not shown.',
    sections: [
      { heading: 'Never', list: [
        'MyIntealth, EPIC or AMC steps.',
        'An AHPRA registration application, or logging an AHPRA letter.',
        'A visa application (segment A).',
        'Supervisor CV, SPPA-00, Section G or position description requests to the practice (segment A).',
        'Reset GP, or re-opening an overseas stage.',
        'Hazel (the AI caller) never rings an Australian GP: follow up personally.'
      ] },
      { heading: 'Wording', list: [
        'Never tell a practice that an Australian GP is "internationally trained" or on the "Expedited Specialist Pathway".',
        'Never write to the doctor about relocating, a visa or "your move".',
        'Use the Australian email templates in the composer; they are offered automatically for an Australian doctor.'
      ] }
    ]
  }
]);

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function topic(key) {
  const k = String(key || '').toLowerCase();
  for (let i = 0; i < TOPICS.length; i++) if (TOPICS[i].key === k) return TOPICS[i];
  return null;
}

function pathFor(key) { return PATH_PREFIX + key; }
function isGuidePath(value) { return /^\/api\/admin\/guide\/au\/[a-z0-9-]{1,40}$/.test(String(value || '')); }

/** The items the one-click seed creates, in order. */
function seedItems() {
  return TOPICS.map(function (t) { return { title: t.title, scribe_url: pathFor(t.key) }; });
}

/** One topic as a self-contained page (no script). null for an unknown topic. */
function renderPage(key) {
  const t = topic(key);
  if (!t) return null;
  const body = t.sections.map(function (s) {
    const tag = s.ordered ? 'ol' : 'ul';
    return '<h2>' + esc(s.heading) + '</h2><' + tag + '>' + s.list.map(function (li) { return '<li>' + esc(li) + '</li>'; }).join('') + '</' + tag + '>';
  }).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + esc(t.title) + '</title><style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#fff;margin:0;padding:22px 26px;line-height:1.55;font-size:14px}' +
    'h1{font-size:19px;margin:0 0 8px}h2{font-size:14px;margin:20px 0 6px;color:#1e3a8a}p{margin:0 0 10px;color:#334155}' +
    'li{margin:0 0 6px}ol,ul{margin:0;padding-left:20px}.note{margin-top:22px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:10px}' +
    '</style></head><body><h1>' + esc(t.title) + '</h1><p>' + esc(t.intro) + '</p>' + body +
    '<p class="note">Staff guide. Not for doctors or practices.</p></body></html>';
}

module.exports = { FOLDER_NAME, PATH_PREFIX, TOPICS, topic, pathFor, isGuidePath, seedItems, renderPage };
