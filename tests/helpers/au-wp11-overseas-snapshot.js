'use strict';

/**
 * WP-11: what an OVERSEAS doctor's placement produces, through every entry
 * point: every task, timeline line, document, email (to the doctor, to the
 * practice, to staff), WhatsApp, bell item and Drive call.
 *
 * tests/fixtures/au-wp11-overseas-placement.snapshot.json was produced by this
 * file on the tree BEFORE WP-11 changed any placement code (its own commit,
 * ahead of the code). tests/au-wp11-overseas-parity.test.js recomputes it with
 * the switch on (nothing recorded) and with it off and demands equality.
 *
 * To (re)write the fixture, on a tree you trust:
 *   AU_WP11_WRITE_SNAPSHOT=1 npx vitest run tests/au-wp11-overseas-parity.test.js
 * Never regenerate it to make a failing parity test pass.
 */

const { buildAuDoctor } = require('./au-fixtures.js');
const { ENTRY_POINTS } = require('./au-wp11-placement-rig.js');

// An overseas doctor at the point they are placed today: EPIC and AMC done.
const EPIC_DONE = { stage: 'verification_issued', completed: { create_account: true, account_establishment: true, upload_qualifications: true, verification_issued: true } };
const AMC_DONE = { stage: 'qualifications_verified', completed: { create_portfolio: true, upload_credentials: true, qualifications_verified: true } };

let seq = 0;
function overseasDoctor(kind) {
  seq += 1;
  return buildAuDoctor(kind || 'overseas_null', {
    idSuffix: String(7000 + seq),
    profile: { phone: '+447700900' + String(100 + seq), phone_number: '7700900' + String(100 + seq), country_dial: '+44' },
    caseRow: { stage: 'career' },
    state: { gp_epic_progress: EPIC_DONE, gp_amc_progress: AMC_DONE, gp_career_state: { career_secured: false, applications: [] } }
  });
}

// The doctor's own identifiers differ from run to run (each run adds fresh
// doctors); everything else must be byte-identical.
function anonymise(value, d) {
  let text = JSON.stringify(value);
  const swaps = [
    [d.email, '<doctor-email>'],
    [d.profile.phone, '<doctor-phone>'],
    [String(d.profile.phone).replace(/^\+/, ''), '<doctor-phone>'],
    [d.profile.first_name + ' ' + d.profile.last_name, '<doctor-name>'],
    [d.profile.first_name, '<doctor-first>'],
    [d.profile.last_name, '<doctor-last>']
  ];
  swaps.forEach(function (pair) {
    if (!pair[0]) return;
    text = text.split(JSON.stringify(String(pair[0])).slice(1, -1)).join(pair[1]);
  });
  return JSON.parse(text);
}

/**
 * Place one fresh overseas doctor through each entry point and return the
 * normalised record of everything it produced, keyed by entry point. Then the
 * same call again (a double submit / replay), recorded as `<entry>#again`:
 * what a second identical call adds.
 */
async function computeOverseasPlacementSnapshot(rig, opts) {
  const o = opts || {};
  const out = {};
  // Warm-up: the first placement in a process also creates the shared Drive
  // lifecycle folders (cached afterwards). Do that once, unrecorded, so every
  // recorded placement sees the same world whichever pass it is in.
  if (!rig.__wp11Warm) {
    const warm = overseasDoctor(o.kind);
    rig.addDoctor(warm);
    await rig.place(warm, 'finalize');
    rig.__wp11Warm = true;
  }
  for (const entry of ENTRY_POINTS) {
    const d = overseasDoctor(o.kind);
    rig.addDoctor(d);
    rig.resetRecorders();
    const res = await rig.place(d, entry);
    out[entry] = anonymise(Object.assign({ httpStatus: res ? res.status : null }, rig.normalise(rig.capture(d))), d);

    rig.resetRecorders();
    const again = await rig.place(d, entry === 'finalize' ? 'ops_replay' : entry, { repeat: true });
    const after = rig.normalise(rig.capture(d));
    out[entry + '#again'] = anonymise({
      httpStatus: again ? again.status : null,
      caseStage: after.caseStage,
      tasks: after.tasks,
      timeline: after.timeline,
      documents: after.documents,
      emailsToDoctor: after.emailsToDoctor, emailsToPractice: after.emailsToPractice, emailsOther: after.emailsOther,
      whatsapps: after.whatsapps, bell: after.bell, drive: after.drive
    }, d);
  }
  return out;
}

module.exports = { computeOverseasPlacementSnapshot, overseasDoctor, anonymise, EPIC_DONE, AMC_DONE };
