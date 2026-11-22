'use strict';
/**
 * WP-20 (Australian GP build): THE INVENTORY of every place the app asks a
 * generative model for something, with a verdict for each.
 *
 * tests/au-wp20-model-call-inventory.test.js scans server.js and lib/ and
 * fails when a call exists that is not listed here, or a listed one is gone.
 * So: when you add a model call, add its row, and decide the verdict.
 *
 *   key       '<file>#<function or route the call sits in>'
 *   calls     how many provider requests that function / route makes
 *   purpose   what it is for, in plain words
 *   audience  who reads what the model writes
 *   verdict   one of VERDICT (below)
 *   note      why, and where the Australian branch / gate / net lives
 *
 * THE QUESTION TO ASK OF A NEW CALL: is the model told anything about where a
 * doctor is on their journey, or does what it writes reach a doctor or a
 * practice? If yes it needs an Australian branch built on
 * lib/au-ai-context.js (auPromptContext for the prompt, auOutputNet for the
 * reply) and a row in tests/au-wp20-overseas-prompt-parity.test.js. If no,
 * say why in `note`. CONVENTIONS section 33 has the rule in full.
 */

const VERDICT = Object.freeze({
  // The prompt has an Australian branch added by WP-20.
  AU_BRANCH: 'australian branch added (WP-20)',
  // An earlier package built the Australian branch or the gate; WP-20 confirmed it.
  AU_EARLIER: 'australian branch or gate from an earlier package, confirmed',
  // The prompt says nothing about a doctor's journey: it reads a document or
  // a message and answers a narrow question. Unchanged.
  NEUTRAL: 'not about a doctor\'s journey, no change',
  // Only reachable for a doctor on the overseas journey (the flow itself is
  // gated or does not exist for an Australian doctor). Unchanged.
  OVERSEAS_FLOW: 'overseas-only flow, no change',
  // Belongs to another package.
  OUT_OF_SCOPE: 'out of scope (another package)'
});

const A = VERDICT.AU_BRANCH, E = VERDICT.AU_EARLIER, N = VERDICT.NEUTRAL, O = VERDICT.OVERSEAS_FLOW, X = VERDICT.OUT_OF_SCOPE;

const INVENTORY = Object.freeze([
  // ── the report's "AI prompts needing an Australian branch" table ──────────
  { key: 'lib/ai-candidate-job-match.js#_callAnthropicRanking', calls: 1, purpose: 'Match reasons (which roles suit a GP, which GPs suit a role)', audience: 'doctor, staff', verdict: E,
    note: 'WP-08: AI_MATCH_SYSTEM_PROMPT_AU + sanitiseAuMatchReasons (billing model allowed, never a figure, never a registration flag). WP-20 confirmed and pinned the wording.' },
  { key: 'server.js#createCareerRoleAiProfile', calls: 1, purpose: 'Job-board practice profile (public copy stored on the role)', audience: 'public: every doctor', verdict: A,
    note: 'OpenAI. Switch on: audience-neutral premise for NEW profiles, overseas-only sentences cut from the shared fields (auNeutralisePublicProfile). Stored copy is not regenerated. An Australian doctor\'s view is filtered at render time (WP-12 scrubRolePayload).' },
  { key: 'server.js#/api/admin/email-triage/suggest-reply', calls: 1, purpose: 'Staff reply draft to a doctor, a practice or a third party', audience: 'doctor or practice, after a person sends it', verdict: A,
    note: 'lib/suggest-reply-prompt.js (opts.au) + the Australian playbook (lib/registration-playbook.js AU_STAGE_PLAYBOOK). Net: auOutputNet; fallback: an empty draft and a note to write it by hand.' },
  { key: 'server.js#/api/admin/candidate-summary', calls: 1, purpose: 'AI case summary (ADM-15); also the background for matching', audience: 'staff only', verdict: A,
    note: 'auCaseSummarySystemPrompt + STATE facts first (auAiContext.auPromptBlock, staff audience). Not netted: staff may read true regulatory terms. The hourly refresher now includes Australian cases.' },
  { key: 'server.js#/api/admin/calls/suggest-reason', calls: 1, purpose: 'Zoom "reason for the meeting" sentence', audience: 'doctor', verdict: A,
    note: 'Australian identity line + stage in the doctor\'s words. Net: auOutputNet; fallback: AU_ZOOM_REASON_FALLBACK.' },
  { key: 'server.js#verifyQualificationDocument', calls: 1, purpose: 'Document verification, overseas qualification rules (UK / IE / NZ, August 2007)', audience: 'doctor (verdict), staff', verdict: E,
    note: 'WP-07: routed by auDocumentReview.reviewRulesFor; a row under au_reg never reaches this prompt and an overseas row never reaches the Australian one (tests/au-wp07-documents-lib.test.js, tests/au-wp20-prompts-lib.test.js).' },
  { key: 'server.js#verifyAuDocument', calls: 1, purpose: 'Document verification, Australian rules (indemnity, Ahpra certificate, WWCC, ...)', audience: 'doctor (verdict), staff', verdict: E,
    note: 'WP-07: lib/au-document-review.js. The model\'s own description of a file is never repeated to the doctor.' },
  { key: 'server.js#/api/admin/practice-nudge/draft', calls: 1, purpose: 'Chase draft to a practice that has not replied', audience: 'practice, after a person sends it', verdict: A,
    note: 'lib/practice-nudge-draft.js (params.au). Net: auOutputNet (practice); fallback: the fixed Australian nudge.' },
  { key: 'server.js#_buildPracticeReplyDraft', calls: 1, purpose: 'Follow-up draft when a practice replied without the document', audience: 'practice, after a person sends it', verdict: A,
    note: 'lib/practice-reply-followup.js (params.au). Net: auOutputNet (practice); fallback: the fixed follow-up.' },
  { key: 'lib/ai-matching.js#aiMatchEmail', calls: 1, purpose: 'Match an emailed attachment to the open task waiting for it (DAT-27)', audience: 'staff (files the attachment on a task)', verdict: A,
    note: 'AI_MATCH_SYSTEM_PROMPT_AU when an Australian doctor\'s pre-start task is in the list (WP-07 keys). Net: enforceMatchDocumentTypes.' },
  { key: 'server.js#_buildMigrationAgentReplyDraft', calls: 1, purpose: 'Reply draft to a migration agent', audience: 'migration agent / practice, after a person sends it', verdict: E,
    note: 'WP-14: the transfer variant, only for a card whose metadata says nomination_transfer (written only by auDecideVisaTransfer, which refuses segments A and C and a citizen / permanent resident).' },
  { key: 'server.js#_draftMigrationAgentNudge', calls: 1, purpose: 'Chase draft to a migration agent', audience: 'migration agent, after a person sends it', verdict: E, note: 'WP-14, as above.' },
  { key: 'lib/email-triage.js#triageEmailWithSonnet', calls: 1, purpose: 'Classify an inbound email and match it to a placed GP', audience: 'staff (a task card)', verdict: A,
    note: 'TRIAGE_SYSTEM_PROMPT_AU when an Australian doctor is in the list: provider_number, indemnity, credentialing, college. Deterministic check first (detectAuTopic); an Australian category is refused for anyone else.' },
  { key: 'lib/email-triage.js#triageAhpraEmail', calls: 1, purpose: 'Classify an email from an AHPRA officer (six modes)', audience: 'staff', verdict: E,
    note: 'WP-14: auAhpraMailRouteForCase sends an Australian doctor\'s AHPRA mail to one staff card with no AI call.' },
  { key: 'lib/ads-review.js#callClaude', calls: 1, purpose: 'Daily Meta ads review and new ad copy', audience: 'owner; the public (ads)', verdict: X,
    note: 'WP-24 (ads hub with an Australian house context). Not changed here. Draft text for WP-24: docs/au-gp/ads-au-house-context.md.' },

  // ── the generator WP-09 left to this package ─────────────────────────────
  { key: 'server.js#generateCandidateRecommendation', calls: 1, purpose: '"Why we recommend" blurb in the introduction sent to a practice', audience: 'practice', verdict: A,
    note: 'auRecommendationPrompt, built from the introduction a practice is already sent (WP-09 facts) and the CV. Net: careerIntro.auSafeRecommendation (WP-09); fallback: no blurb.' },

  // ── everything else that calls a model ───────────────────────────────────
  { key: 'server.js#_disambiguatePracticeEmail', calls: 2, purpose: 'Which of a practice\'s GPs is this email about', audience: 'staff (routing)', verdict: N, note: 'Names and thread text only; no journey.' },
  { key: 'server.js#diffContracts', calls: 1, purpose: 'Summarise what changed between two contract versions', audience: 'staff', verdict: N, note: 'Two documents compared.' },
  { key: 'server.js#aiReviewCareerContract', calls: 1, purpose: 'Check a contract against the interview and the advertised terms', audience: 'doctor (offer review), staff', verdict: N,
    note: 'Compares documents; no pathway premise. The doctor\'s view of the result goes through the WP-12 payload filter and FB-2b offer review.' },
  { key: 'server.js#extractCareerContractTermsWithAi', calls: 1, purpose: 'Extract the split, package and length from a contract', audience: 'doctor (placement tiles), staff', verdict: N,
    note: 'Extraction only. The "Relocation package" tile is relabelled or dropped for an Australian doctor by WP-12 (auDoctorText.relabel).' },
  { key: 'server.js#extractAhpraActionItems', calls: 1, purpose: 'Read an AHPRA section 80 letter into action items', audience: 'staff', verdict: O, note: 'Part of the overseas AHPRA application pipeline (WP-14 routes Australian doctors\' AHPRA mail away from it).' },
  { key: 'server.js#runUploadCheck', calls: 1, purpose: 'Does this upload answer the AHPRA request it was sent for', audience: 'staff', verdict: O, note: 'AHPRA request tray, overseas pipeline only.' },
  { key: 'server.js#aiMatchResponseToTask', calls: 1, purpose: 'Which open task does this message answer', audience: 'staff (routing)', verdict: N, note: 'Task titles and the message; no journey premise ("received for a GP").' },
  { key: 'server.js#analyseErrorForFix', calls: 1, purpose: 'Triage a production error', audience: 'owner', verdict: N, note: 'About code, not doctors.' },
  { key: 'server.js#requestFixPatch', calls: 1, purpose: 'Propose a code fix', audience: 'owner', verdict: N, note: 'About code, not doctors.' },
  { key: 'server.js#classifyDoubleTickMessage', calls: 1, purpose: 'Is this WhatsApp message a question (YES / NO)', audience: 'nobody (a flag)', verdict: N, note: 'One-word answer.' },
  { key: 'server.js#parseAhpraFinalNotice', calls: 1, purpose: 'Read an AHPRA final notice of registration', audience: 'staff', verdict: O, note: 'Registration-granted flow; an Australian case never enters it (WP-06 / WP-14 guards).' },
  { key: 'server.js#verifyCareerCvWithAI', calls: 1, purpose: 'Is this file a CV, and whose name is on it', audience: 'doctor (accept / reject), staff', verdict: N, note: 'Document check; no pathway premise.' },
  { key: 'server.js#classifyPracticeDocumentWithAI', calls: 1, purpose: 'Which practice-pack document is this file', audience: 'staff', verdict: N, note: 'Document classification.' },
  { key: 'server.js#classifyDocumentWithAI', calls: 1, purpose: 'Does this upload match the slot it was uploaded to', audience: 'doctor (accept / reject), staff', verdict: N, note: 'Document classification.' },
  { key: 'server.js#generateJobWriteup', calls: 1, purpose: 'Public job write-up from a practice\'s intake form', audience: 'public: every doctor', verdict: N,
    note: 'lib/job-writeup.js: "a recruitment copywriter for a medical-jobs board", no overseas premise. An Australian doctor\'s view is filtered at render time (WP-12).' },
  { key: 'server.js#/api/cron/reconcile-followups', calls: 1, purpose: 'Has this follow-up task been done', audience: 'staff', verdict: N, note: 'Task text and activity.' },
  { key: 'server.js#/api/ai/verify-certification', calls: 1, purpose: 'Is this copy certified', audience: 'doctor (verdict)', verdict: O, note: 'Certified copies are asked of overseas qualification documents only.' },
  { key: 'server.js#/api/ai/verify-ichc', calls: 1, purpose: 'Is this a Fit2Work ICHC reference page', audience: 'doctor (verdict)', verdict: O, note: 'International criminal history check: an overseas AHPRA application document.' },
  { key: 'server.js#/api/ai/classify-document', calls: 1, purpose: 'What kind of document is this upload', audience: 'doctor (verdict)', verdict: N, note: 'Document classification.' },
  { key: 'server.js#/api/ai/document-crop', calls: 1, purpose: 'Find the page inside a photograph', audience: 'nobody (crop box)', verdict: N, note: 'Geometry only.' },
  { key: 'server.js#/api/ai/verify-identity', calls: 1, purpose: 'Read the name on a passport or driver\'s licence', audience: 'doctor (verdict)', verdict: N,
    note: 'No overseas premise: "passport or driver\'s licence", any country, expiry never a reason to reject. An Australian licence or passport is judged the same way.' },
  { key: 'server.js#/api/admin/va/note/parse-followup', calls: 1, purpose: 'Pull a follow-up date out of a staff note', audience: 'staff', verdict: N, note: 'Note text only.' },
  { key: 'server.js#/api/admin/ahpra/item/practice-request-draft', calls: 1, purpose: 'Draft a request to a practice for an AHPRA item', audience: 'practice, after a person sends it', verdict: O, note: 'AHPRA request tray, overseas pipeline only.' },
  { key: 'server.js#/api/admin/ahpra/item/officer-reply-draft', calls: 1, purpose: 'Draft a reply to an AHPRA officer', audience: 'AHPRA officer, after a person sends it', verdict: O, note: 'AHPRA request tray, overseas pipeline only.' },
  { key: 'server.js#/api/admin/va/task/generate-position-description', calls: 1, purpose: 'Draft a position description for supervised practice paperwork', audience: 'practice, staff', verdict: O, note: 'Practice pack; the prompt names the practice and role only.' },
  { key: 'server.js#/api/ceo/candidate/comms-scan', calls: 1, purpose: 'How engaged is this candidate (score and tone)', audience: 'staff (CEO dashboard)', verdict: N, note: 'Message threads only; "a doctor candidate in a medical recruitment pipeline".' },
  { key: 'server.js#_parseAvailabilityViaAI', calls: 1, purpose: 'Read interview times out of a practice\'s reply', audience: 'staff, then the interview scheduler', verdict: N, note: 'Dates and times only.' },
  { key: 'lib/alt-supervisor-cv-match.js#matchCvToAltSupervisor', calls: 1, purpose: 'Which alternate supervisor is this CV for', audience: 'staff', verdict: O, note: 'Supervised practice paperwork.' },
  { key: 'lib/sppa-completeness-check.js#checkSppaCompleteness', calls: 1, purpose: 'Is the SPPA-00 form complete', audience: 'staff', verdict: O, note: 'Reads a form. Reachable for a supervised segment B doctor (WP-14), where it still only reads the form.' },
  { key: 'lib/sppa-completeness-check.js#identifySppaDocuments', calls: 1, purpose: 'Is this file the SPPA-00', audience: 'staff', verdict: O, note: 'As above.' },
  { key: 'lib/sppa-conflict-scan.js#scanForConflict', calls: 1, purpose: 'Does the supervisor also own the practice', audience: 'staff', verdict: O, note: 'As above.' },
  { key: 'lib/sppa-gp-section-scan.js#scanGpSections', calls: 1, purpose: 'Did the GP fill in their sections of the SPPA-00', audience: 'staff', verdict: O, note: 'As above.' },
  { key: 'lib/sppa-pdf-fill.js#extractAltSupervisorNames', calls: 1, purpose: 'Read alternate supervisors\' names from a form', audience: 'staff', verdict: O, note: 'As above.' }
]);

// Things a reader might expect to find above that are NOT model calls made by
// this app's code (so the scan does not see them). Listed so the answer to
// "what about X?" is written down.
const NOT_MODEL_CALLS_HERE = Object.freeze([
  { what: 'Hazel, the AI phone agent (config/retell/*.md, lib/lead-calls.js)', verdict: X, note: 'Retell holds the prompt; out of scope for WP-20 (WP-19). Hazel never rings an Australian lead.' },
  { what: 'Ad photographs (lib/higgsfield.js)', verdict: X, note: 'An image API for the ads hub: WP-24.' },
  { what: 'Zoom interview and call summaries (scheduled_calls.meeting_summary)', verdict: N, note: 'Written by Zoom AI Companion, not by this app; this app only stores and shows them.' },
  { what: 'The CEO Overview brief (lib/ceo-overview.js)', verdict: N, note: 'Deterministic: no model call (handover 2026-11-05; the file makes no provider request).' },
  { what: 'The CEO review queue (lib/ceo-review-queue.js)', verdict: N, note: 'Deterministic: no model call.' }
]);

module.exports = { INVENTORY, VERDICT, NOT_MODEL_CALLS_HERE };
