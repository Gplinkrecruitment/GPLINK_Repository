'use strict';
/**
 * WP-14 overseas parity: what the code produced for an OVERSEAS doctor before
 * WP-14 changed anything.
 *
 * `capturePure(root)` runs the pure builders WP-14 touched (the migration
 * agent drafts and prompts, the registration-granted emails, the email
 * routing decision) with fixed, obviously fake inputs and returns everything
 * they produced. The snapshot in tests/fixtures/au-wp14-overseas-parity.snapshot.json
 * was written by running this against the tree at commit 4b08e987 (the commit
 * WP-14 started from), exported with `git archive`. The test runs it against
 * the working tree and compares every byte.
 *
 * To regenerate (only if an OVERSEAS behaviour is changed on purpose):
 *   git archive <base-commit> | tar -x -C /tmp/base
 *   node tests/helpers/au-wp14-parity.js /tmp/base > tests/fixtures/au-wp14-overseas-parity.snapshot.json
 */
const path = require('path');

const AGENT_PARAMS = Object.freeze({
  gpName: 'Test Overseas', gpEmail: 'overseas.test@gplink-test.local',
  practiceName: 'Test Regional Practice (FAKE)', contactName: 'Dr Fake Contact',
  contactEmail: 'contact@practice-test.local', commencementDate: '25 January 2027',
  practiceCoversVisaCosts: true, rsoName: 'Test Rso',
  replyText: 'Thanks. I have copied in Sam who looks after this for us.',
  replySender: 'Dr Fake Contact <contact@practice-test.local>',
  replyCc: 'Sam Agent <sam@agent-test.local>',
  replyTo: 'registration@gplink-test.local', originalTo: 'contact@practice-test.local',
  requestText: 'Subject: registration approved\n\nPlease engage a migration agent.',
  threadText: 'US: first email\n\nTHEM: reply',
  knownContacts: [{ email_address: 'sam@agent-test.local', display_name: 'Sam Agent', signature_name: 'Sam Agent' }],
  ownAddresses: ['overseas.test@gplink-test.local'],
  agentName: 'Sam Agent', agentEmail: 'sam@agent-test.local', registrationNumber: 'MED0000000001'
});

function captureMigrationAgent(lib) {
  const out = {};
  const variants = {
    full: AGENT_PARAMS,
    bare: { gpName: 'Test Overseas', replyText: 'ok' },
    // A value WP-14 must NOT react to: only 'nomination_transfer' switches the wording.
    other_case_type: Object.assign({}, AGENT_PARAMS, { caseType: 'new_application' }),
    no_copy: Object.assign({}, AGENT_PARAMS, { replyCc: '' })
  };
  Object.keys(variants).forEach(function (name) {
    const p = variants[name];
    const target = lib.nudgeTarget({
      outboundEmail: { to: 'contact@practice-test.local', cc: '', subject: 'Dr Test Overseas AHPRA registration approved, next step is the visa', sent_at: '2026-11-01T00:00:00.000Z' },
      followups: name === 'no_copy' ? [] : [{ to: 'sam@agent-test.local', cc: 'contact@practice-test.local', subject: 'Re: migration agent', sent_at: '2026-11-03T00:00:00.000Z' }],
      practiceReply: null, knownContacts: p.knownContacts || [], ownAddresses: p.ownAddresses || [], contactName: p.contactName || ''
    });
    out[name] = {
      replyMessages: lib.buildMigrationAgentReplyMessages(p),
      introDraft: lib.buildAgentIntroDraft(p),
      fallback: lib.buildMigrationAgentFallback(p),
      nudgeFallback: lib.buildMigrationAgentNudgeFallback(Object.assign({}, p, { target, daysSinceLastContact: 4 })),
      nudgeMessages: lib.buildMigrationAgentNudgeMessages(Object.assign({}, p, { target, daysSinceLastContact: 4, practiceEverReplied: true, lastSaid: 'They copied Sam in.' }))
    };
  });
  return out;
}

function captureRegistrationGrantedEmails(lib) {
  const ctx = {
    practiceName: 'Test Regional Practice (FAKE)', contactName: 'Dr Fake Contact', contactEmail: 'contact@practice-test.local',
    gpFirstName: 'Test', gpLastName: 'Overseas', registrationNumber: 'MED0000000001', registrationType: 'Specialist',
    effectiveDate: '2026-11-02', expiryDate: '2027-09-30', hasConditions: true, supervisionLevel: 'Indirect 2',
    supervisorName: 'Dr Fake Supervisor', commencementDate: '2027-01-25', practiceCoversVisaCosts: true, senderName: 'Test Rso',
    whoMoving: 'me_partner_children', childrenCount: '2', appBaseUrl: 'https://app.gplink-test.local'
  };
  return {
    practice: lib.buildPracticeRegistrationEmail(ctx),
    practiceBare: lib.buildPracticeRegistrationEmail({ gpName: 'Test Overseas' }),
    passports: lib.buildGpPassportRequest(ctx),
    reminder: lib.buildGpPassportReminder(Object.assign({}, ctx, { outstanding: ['Your passport', "Partner's passport"], received: [], requestedAt: '2026-11-03', reminderCount: 1 }))
  };
}

const ROUTING_SENDERS = Object.freeze([
  'College <exams@racgp.org.au>', 'training@acrrm.org.au', 'AMC <assess@amc.org.au>', 'notices@medicalboard.gov.au',
  'officer@ahpra.gov.au', 'no-reply@homeaffairs.gov.au', 'provider@servicesaustralia.gov.au',
  'Practice Manager <pm@practice-test.local>', 'overseas.test@gplink-test.local', ''
]);

function captureEmailRouting(lib) {
  const out = [];
  ROUTING_SENDERS.forEach(function (sender) {
    [true, false].forEach(function (matched) {
      [true, false].forEach(function (senderIsGp) {
        ['', 'visa', 'medicare_pbs', 'practice_enquiry', 'other'].forEach(function (category) {
          ['', 'urgent', 'high'].forEach(function (urgency) {
            const input = { sender, subject: 'Your application', bodySnippet: 'Please see the attached.', category, urgency, matched, gpStage: 'amc', senderIsGp };
            out.push({ input, result: lib.resolveEmailRouting(input) });
          });
        });
      });
    });
  });
  return out;
}

function capturePure(root) {
  const lib = function (name) { return require(path.join(root, 'lib', name)); };
  return {
    migrationAgent: captureMigrationAgent(lib('migration-agent-reply.js')),
    registrationGrantedEmails: captureRegistrationGrantedEmails(lib('registration-granted-emails.js')),
    emailRouting: captureEmailRouting(lib('email-triage.js'))
  };
}

module.exports = { capturePure, captureMigrationAgent, captureRegistrationGrantedEmails, captureEmailRouting, AGENT_PARAMS, ROUTING_SENDERS };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
  process.stdout.write(JSON.stringify(capturePure(root), null, 1) + '\n');
}
