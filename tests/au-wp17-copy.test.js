// WP-17: the words of every Australian lifecycle message (N04 to N22), for
// every segment group. A snapshot pins them; the scans below prove the rules
// (banned words with precise word boundaries, nothing commercial to a doctor,
// what a practice is never told, the confidentiality promise, "Ahpra",
// Australian dates, no role promised to an unlaunched segment). The
// owner-readable deck is generated from the same code and must match it.
//
// To change a word on purpose: change the builder, then regenerate with
//   WP17_WRITE_COPY=1 npx vitest run tests/au-wp17-copy.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const auMessages = require('../lib/au-messages.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const careerIntro = require('../lib/career-intro.js');
const auWhatsAppTemplates = require('../lib/au-whatsapp-templates.js');
const { bannedIn } = require('./helpers/au-banned-words.js');
const copy = require('./helpers/au-wp17-copy.js');

const SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp17-au-copy.snapshot.json');
const DECK = path.join(__dirname, '..', 'docs', 'au-gp', 'au-lifecycle-copy.md');

if (process.env.WP17_WRITE_COPY === '1') {
  fs.writeFileSync(SNAPSHOT, JSON.stringify(copy.copySnapshot(), null, 2) + '\n');
  fs.writeFileSync(DECK, copy.renderDeck());
}

const SAMPLES = copy.everySample();
const TO_DOCTOR = SAMPLES.filter((s) => s.to === 'doctor');
const TO_PRACTICE = SAMPLES.filter((s) => s.to === 'practice');

// Nothing commercial ever reaches a doctor.
const COMMERCIAL = /\$|%|\bfees?\b|\binvoic\w*|\bcredit(?:s|ed)?\b|\bguarantee\w*|\bcommission\b|\bplacement fee\b/i;

describe('WP-17: the copy is pinned', () => {
  it('matches the snapshot', () => {
    expect(copy.copySnapshot()).toEqual(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
  });
  it('the owner-readable deck is the code, word for word', () => {
    expect(fs.readFileSync(DECK, 'utf8')).toBe(copy.renderDeck());
  });
  it('there is something to scan for every message that sends words', () => {
    const ids = new Set(SAMPLES.map((s) => s.id));
    for (const id of auMessages.MESSAGE_IDS) {
      if (id === 'N07' || id === 'N09') continue; // a staff task; the existing match emails (scanned on the real server)
      expect(ids.has(id), id).toBe(true);
    }
    expect(TO_DOCTOR.length).toBeGreaterThan(20);
    expect(TO_PRACTICE.length).toBeGreaterThan(8);
  });
  it('the scans below cover exactly these messages', () => {
    expect(Array.from(new Set(SAMPLES.map((s) => s.id))).sort()).toEqual(
      ['N04', 'N05', 'N06', 'N08', 'N10', 'N11', 'N12', 'N13', 'N14', 'N15', 'N16', 'N17', 'N18', 'N19', 'N20', 'N21', 'N22']);
  });
});

describe('WP-17: what a doctor is never sent', () => {
  for (const s of TO_DOCTOR) {
    const parts = copy.stringsOf(s.message);
    it(s.id + ' ' + s.label + ': no banned word in any part (subject, heading, body, button, footer, bell, WhatsApp variables)', () => {
      for (const k of Object.keys(parts)) expect(bannedIn(parts[k]), s.id + ' ' + k + ': ' + parts[k].slice(0, 80)).toEqual([]);
    });
    it(s.id + ' ' + s.label + ': nothing commercial, no dollar figure, no percentage', () => {
      for (const k of Object.keys(parts)) expect(COMMERCIAL.test(parts[k]), s.id + ' ' + k + ': ' + parts[k]).toBe(false);
    });
    it(s.id + ' ' + s.label + ': no "Registration Support Officer", no "AHPRA", no dash used as punctuation, no raw date or clock time', () => {
      const all = copy.allText(s.message);
      expect(/registration support officer/i.test(all)).toBe(false);
      expect(/\bRSO\b/.test(all)).toBe(false);
      expect(/AHPRA/.test(all)).toBe(false);
      expect(/[—–]/.test(all)).toBe(false);
      expect(/\b20\d\d-\d\d-\d\d\b/.test(all)).toBe(false);
      expect(/\b\d{1,2}:\d{2}\b/.test(all)).toBe(false);
    });
  }

  it('the word boundaries are precise: real words that merely contain a banned one are not flagged', () => {
    expect(bannedIn('It is advisable to have your certificate removed from the old epicentre. We moved the meeting.')).toEqual([]);
    expect(bannedIn('your visa')).toContain('visa');
    expect(bannedIn('the MyIntealth step').length).toBeGreaterThan(0);
  });

  it('N21 is the one message that may say "visa", and only for a sponsor-tied segment B doctor', () => {
    const outcome = { moratorium: auMessages.N21_MORATORIUM.DPA_ONLY, supervision: auMessages.N21_SUPERVISION.NEEDED, visa: auMessages.N21_VISA.TRANSFER_IN_PROGRESS };
    const base = { appBaseUrl: 'https://app.mygplink.com.au', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'APP1' };
    const allowed = auMessages.buildSegmentBOutcomeGpMessage(Object.assign({ visaWordsAllowed: true }, base, outcome));
    const notAllowed = auMessages.buildSegmentBOutcomeGpMessage(Object.assign({ visaWordsAllowed: false }, base, outcome));
    expect(bannedIn(copy.allText(notAllowed))).toEqual([]);
    expect(bannedIn(copy.allText(allowed))).toEqual(['visa']);
    const sponsorTied = { pathway: 'au_restricted', credentials: { work_rights: 'visa', visa_sponsor_tied: true } };
    expect(auDoctorText.violationsFor(copy.allText(allowed), Object.assign({ context: 'n21' }, sponsorTied))).toEqual([]);
  });
});

describe('WP-17: what a practice is never told', () => {
  for (const s of TO_PRACTICE) {
    it(s.id + ' ' + s.label + ': no banned phrase, no dollar figure, no percentage', () => {
      const parts = copy.stringsOf(s.message);
      for (const k of Object.keys(parts)) {
        expect(careerIntro.auPracticeTextViolations(parts[k]), s.id + ' ' + k).toEqual([]);
        expect(/internationally trained|expedited specialist|AHPRA steps|ahpra steps/i.test(parts[k])).toBe(false);
        expect(/AHPRA/.test(parts[k])).toBe(false);
      }
    });
    it(s.id + ' ' + s.label + ': never names or hints at the doctor\'s current practice', () => {
      // N10's own confidentiality note tells the practice NOT to contact it (WP-09's agreed wording).
      const all = copy.allText(s.message).replace('do not contact their current practice', '');
      expect(/current (practice|employer|role at)/i.test(all) && !/current role\b/i.test(all)).toBe(false);
    });
  }
  it('the guarantee is described to a practice only as the agreement describes it (N12, N19): 12 weeks, clause 7, no figure', () => {
    const texts = TO_PRACTICE.filter((s) => /guarantee/i.test(copy.allText(s.message))).map((s) => copy.allText(s.message));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) { expect(/12-week guarantee period/.test(t)).toBe(true); expect(/clause 7/.test(t)).toBe(true); expect(/\$|%/.test(t)).toBe(false); }
  });
});

describe('WP-17: the promises the copy makes', () => {
  it('the confidentiality promise is in its agreed wording wherever a doctor is told about confidentiality', () => {
    expect(auMessages.CONFIDENTIALITY_LINE).toBe('We never contact your current practice without asking you first.');
    const must = ['N04', 'N05', 'N08'];
    for (const id of must) {
      for (const s of TO_DOCTOR.filter((x) => x.id === id)) expect(copy.allText(s.message).indexOf(auMessages.CONFIDENTIALITY_LINE) !== -1, id + ' ' + s.label).toBe(true);
    }
    for (const s of TO_DOCTOR.filter((x) => (x.id === 'N06' && /Verified/.test(x.label)) || x.id === 'N11')) {
      expect(copy.allText(s.message).indexOf(auMessages.CONFIDENTIALITY_LINE) !== -1, s.id + ' ' + s.label).toBe(true);
    }
    // Any other mention of the current practice to a doctor is this sentence or the agreed variant about referees.
    for (const s of TO_DOCTOR) {
      const all = copy.allText(s.message).split(auMessages.CONFIDENTIALITY_LINE).join('');
      expect(/we (will |may )?contact your current practice/i.test(all), s.id).toBe(false);
    }
  });

  it('a doctor in an unlaunched segment is promised no roles (the careful wording of N04 and N08)', () => {
    const careful = [
      auMessages.buildWelcomeMessage({ appBaseUrl: 'https://x', group: auMessages.GROUP.SAFE }),
      auMessages.buildProfileCompleteMessage({ appBaseUrl: 'https://x', group: auMessages.GROUP.SAFE })
    ];
    for (const m of careful) {
      const all = copy.allText(m);
      expect(/roles? that fit|lining up|line up|a match|matches|apply in/i.test(all), m.id + ': ' + all).toBe(false);
      expect(/what fits your registration/.test(all)).toBe(true);
    }
    expect(auMessages.groupForPathway('au_vr')).toBe('main');
    for (const p of ['au_restricted', 'au_non_vr', 'au_registrar']) expect(auMessages.groupForPathway(p)).toBe('safe');
    // The onboarding reminders say the same to everyone and promise nothing.
    for (let n = 0; n < 4; n++) {
      const all = copy.allText(auMessages.buildOnboardingNudgeMessage({ appBaseUrl: 'https://x', index: n, step: 1 }));
      expect(/roles? that fit|lining up|a match\b|matches/i.test(all)).toBe(false);
    }
  });

  it('the unlaunched-segment table: every message says what A, B and C get; N16 is never automatic for B or C', () => {
    for (const id of auMessages.MESSAGE_IDS) {
      const seg = auMessages.AU_MESSAGES[id].segments;
      for (const k of ['A', 'B', 'C']) expect(typeof seg[k] === 'string' && seg[k].length > 2, id + '.' + k).toBe(true);
    }
    expect(auMessages.AU_MESSAGES.N16.segments.B).toBe('not sent');
    expect(auMessages.AU_MESSAGES.N16.segments.C).toBe('not sent');
    expect(auMessages.AU_MESSAGES.N21.segments.A).toBe('not sent');
    expect(/not sent/.test(auMessages.AU_MESSAGES.N09.segments.B)).toBe(true);
  });

  it('dates are Australian calendar dates', () => {
    const n16 = auMessages.buildClearedToStartMessage({ appBaseUrl: 'https://x', practiceName: 'P', startDate: '2027-02-01', placementKey: 'K' });
    expect(n16.subject).toBe('You are cleared to start on 1 February 2027');
    expect(auMessages.buildClearedToStartMessage({ appBaseUrl: 'https://x', startDate: '', placementKey: 'K' })).toBe(null);
    expect(auMessages.buildClearedToStartMessage({ appBaseUrl: 'https://x', startDate: 'soon', placementKey: 'K' })).toBe(null);
  });
});

describe('WP-17: N05, the reminder schedule (shorter than the overseas one)', () => {
  const H = 3600000;
  it('1 hour, 24 hours, 3 days, 7 days, one per run, then done', () => {
    expect(auMessages.AU_ONBOARDING_NUDGE_SCHEDULE_MS.slice()).toEqual([H, 24 * H, 72 * H, 168 * H]);
    expect(auMessages.auOnboardingNextDue({ inactivityMs: 30 * 60000, stepsSent: [] })).toBe(null);
    expect(auMessages.auOnboardingNextDue({ inactivityMs: 2 * H, stepsSent: [] })).toBe(0);
    expect(auMessages.auOnboardingNextDue({ inactivityMs: 2 * H, stepsSent: [0] })).toBe(null);
    expect(auMessages.auOnboardingNextDue({ inactivityMs: 200 * H, stepsSent: [] })).toBe(0); // the earliest owed, never a burst
    expect(auMessages.auOnboardingNextDue({ inactivityMs: 200 * H, stepsSent: [0, 1, 2] })).toBe(3);
    expect(auMessages.auOnboardingNextDue({ inactivityMs: 900 * H, stepsSent: [0, 1, 2, 3] })).toBe(null);
    expect(auMessages.auOnboardingExhausted({ stepsSent: [0, 1, 2, 3] })).toBe(true);
    expect(auMessages.auOnboardingExhausted({ stepsSent: [0, 1] })).toBe(false);
  });
  it('names the Australian step the doctor stopped on, never the overseas wizard\'s', () => {
    expect(auMessages.AU_ONBOARDING_STEP_LABELS.length).toBe(6);
    expect(auMessages.auOnboardingStepOf({ auBranch: 'yes', au: { step: 2 } })).toBe(2);
    expect(auMessages.auOnboardingStepOf(JSON.stringify({ auBranch: 'yes', au: { step: 9 } }))).toBe(5);
    expect(auMessages.auOnboardingStepOf({})).toBe(0);
    const m = auMessages.buildOnboardingNudgeMessage({ appBaseUrl: 'https://x', index: 0, step: 2 });
    expect(m.body).toContain('You have 4 short steps left, starting with "Your Ahpra registration".');
    expect(/GMC|register number|plan your move/i.test(copy.allText(m))).toBe(false);
    // The link opens the wizard where they left it. A ?step= link would open the overseas wizard.
    expect(m.ctaUrl).toBe('https://x/pages/onboarding');
    expect(auMessages.buildOnboardingNudgeMessage({ appBaseUrl: 'https://x', index: 3, step: 5 }).body).toContain('You have 1 short step left');
  });
});

describe('WP-17: N17, only what the doctor can do', () => {
  it('no message at all when nothing is waiting on the doctor', () => {
    expect(auMessages.buildStalledReminderMessage({ appBaseUrl: 'https://x', stage: 'prestart', actions: [], mark: 'd14', placementKey: 'K' })).toBe(null);
    expect(auMessages.buildStalledReminderMessage({ appBaseUrl: 'https://x', stage: 'match', actions: [{ label: '' }], mark: 'd14' })).toBe(null);
  });
  it('never says "you haven\'t made progress"', () => {
    for (const s of TO_DOCTOR.filter((x) => x.id === 'N17')) expect(/haven.t made progress|no progress|stalled|inactive/i.test(copy.allText(s.message))).toBe(false);
  });
  it('goes at day 14 and day 28 after the milestone, and not long after either', () => {
    expect(auMessages.stalledMarkFor(13)).toBe(null);
    expect(auMessages.stalledMarkFor(14)).toEqual({ mark: 'd14', days: 14 });
    expect(auMessages.stalledMarkFor(24)).toEqual({ mark: 'd14', days: 14 });
    expect(auMessages.stalledMarkFor(25)).toBe(null);
    expect(auMessages.stalledMarkFor(28)).toEqual({ mark: 'd28', days: 28 });
    expect(auMessages.stalledMarkFor(39)).toBe(null);
    expect(auMessages.stalledMarkFor(null)).toBe(null);
  });
  it('one key per stage, placement and mark', () => {
    const a = auMessages.buildStalledReminderMessage({ appBaseUrl: 'https://x', stage: 'prestart', actions: [{ label: 'Two referees' }], mark: 'd14', placementKey: 'APP1' });
    const b = auMessages.buildStalledReminderMessage({ appBaseUrl: 'https://x', stage: 'prestart', actions: [{ label: 'Two referees' }], mark: 'd28', placementKey: 'APP1' });
    const c = auMessages.buildStalledReminderMessage({ appBaseUrl: 'https://x', stage: 'match', actions: [auMessages.matchAction(2)], mark: 'd14' });
    expect(a.key).toBe('au_n17_stalled:prestart:APP1:d14');
    expect(b.key).toBe('au_n17_stalled:prestart:APP1:d28');
    expect(c.key).toBe('au_n17_stalled:match:d14');
    expect(c.body).toContain('2 roles we matched you to are waiting for your answer');
  });
});

describe('WP-17: N15, once per date, and the correction', () => {
  const base = { appBaseUrl: 'https://x', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'APP1' };
  it('the key carries the date, so a changed date is a new message and the same date is not', () => {
    const a = auMessages.buildNoticeStartGpMessage(Object.assign({ kind: 'start_date', startDate: '2027-02-01' }, base));
    const b = auMessages.buildNoticeStartGpMessage(Object.assign({ kind: 'start_date', startDate: '2027-02-15', correction: true }, base));
    expect(a.key).toBe('au_n15_start_gp:APP1:2027-02-01');
    expect(b.key).toBe('au_n15_start_gp:APP1:2027-02-15');
    expect(b.subject).toBe('Your start date has changed: 15 February 2027');
    expect(a.subject).toBe('Your start date is confirmed: 1 February 2027');
  });
  it('nothing is built without the fact it confirms', () => {
    expect(auMessages.buildNoticeStartGpMessage(Object.assign({ kind: 'notice' }, base))).toBe(null);
    expect(auMessages.buildNoticeStartGpMessage(Object.assign({ kind: 'start_date' }, base))).toBe(null);
    expect(auMessages.buildNoticeStartPracticeMessage({ kind: 'notice', gpName: 'Dr Test Auvr', placementKey: 'APP1' })).toBe(null);
  });
  it('an unconfirmed start date is called "expected", never "confirmed"', () => {
    const m = auMessages.buildNoticeStartGpMessage(Object.assign({ kind: 'notice', noticeDate: '2026-12-07', startDate: '2027-02-01', startDateConfirmed: false }, base));
    expect(m.body).toContain('Your expected start date');
    expect(/is confirmed/.test(m.body)).toBe(false);
  });
});

describe('WP-17 (COM-23): the one role label', () => {
  it('before a placement "your GP Link consultant", after it "your GP Link team"; everyone else unchanged', () => {
    expect(auMessages.roleLabelFor({ isAu: true, placed: false }).label).toBe('your GP Link consultant');
    expect(auMessages.roleLabelFor({ isAu: true, placed: true }).label).toBe('your GP Link team');
    expect(auMessages.roleLabelFor(null).label).toBe('your Registration Support Officer');
    expect(auMessages.roleLabelFor({ isAu: false }).sentenceStart).toBe('Your Registration Support Officer');
  });
  it('rewrites every spelling the server uses, in text and in HTML, keeping the capital', () => {
    const au = { isAu: true, placed: false };
    expect(auMessages.applyRoleLabel('Your Registration Support Officer is now arranging your interview.', au)).toBe('Your GP Link consultant is now arranging your interview.');
    expect(auMessages.applyRoleLabel('talk to your Registration Support Officer.', au)).toBe('talk to your GP Link consultant.');
    expect(auMessages.applyRoleLabel('your GP Link registration support officer has scheduled a call', { isAu: true, placed: true })).toBe('your GP Link team has scheduled a call');
    expect(auMessages.applyRoleLabel('<b>Your Registration Support Officer</b> preps you', au)).toBe('<b>Your GP Link consultant</b> preps you');
    expect(auMessages.applyRoleLabel('A message from your Registration Support Officer', { isAu: true, placed: true })).toBe('A message from your GP Link team');
  });
  it('an overseas doctor\'s text is returned untouched (the same string)', () => {
    const t = 'Your Registration Support Officer will join you.';
    expect(auMessages.applyRoleLabel(t, null)).toBe(t);
    expect(auMessages.applyRoleLabel(t, { isAu: false })).toBe(t);
    const obj = { title: t, n: 3 };
    expect(auMessages.applyRoleLabelDeep(obj, null)).toBe(obj);
    expect(auMessages.applyRoleLabelDeep(obj, { isAu: true, placed: true })).toEqual({ title: 'Your GP Link team will join you.', n: 3 });
    expect(auMessages.containsRoleLabel({ title: 'hello', body: t })).toBe(true);
    expect(auMessages.containsRoleLabel('nothing here')).toBe(false);
  });
});

describe('WP-17 (COM-18): staff nudge defaults and composer templates for an Australian case', () => {
  it('no Australian nudge default mentions MyIntealth, AMC, EPIC or any banned word', () => {
    for (const k of Object.keys(auMessages.AU_NUDGE_TEMPLATES)) {
      const t = auMessages.AU_NUDGE_TEMPLATES[k];
      expect(bannedIn(t.title + '\n' + t.body), k).toEqual([]);
      expect(/registration support officer/i.test(t.title + t.body)).toBe(false);
    }
    expect(bannedIn(auMessages.AU_NUDGE_EMAIL_FOOTER)).toEqual([]);
  });
  it('an overseas stage typed for an Australian doctor falls to the neutral default', () => {
    expect(auMessages.resolveAuNudgeTemplate('myintealth')).toBe(auMessages.AU_NUDGE_TEMPLATES._default);
    expect(auMessages.resolveAuNudgeTemplate('amc')).toBe(auMessages.AU_NUDGE_TEMPLATES._default);
    expect(auMessages.resolveAuNudgeTemplate('_default')).toBe(auMessages.AU_NUDGE_TEMPLATES._default);
    expect(auMessages.resolveAuNudgeTemplate('prestart')).toBe(auMessages.AU_NUDGE_TEMPLATES.prestart);
    expect(auMessages.resolveAuNudgeTemplate('PRESTART ')).toBe(auMessages.AU_NUDGE_TEMPLATES.prestart);
  });
  it('the composer list for an Australian case drops the overseas defaults and adds the Australian ones; any other audience gets the same list back', () => {
    const emailTemplates = require('../lib/email-templates.js');
    const merged = emailTemplates.mergeEmailTemplates(emailTemplates.DEFAULT_EMAIL_TEMPLATES, []);
    expect(auMessages.composerTemplatesFor(merged, '')).toBe(merged);
    expect(auMessages.composerTemplatesFor(merged, 'overseas')).toBe(merged);
    const au = auMessages.composerTemplatesFor(merged, 'au');
    const keys = au.map((t) => t.key);
    for (const k of auMessages.OVERSEAS_ONLY_COMPOSER_KEYS) expect(keys).not.toContain(k);
    for (const t of auMessages.AU_COMPOSER_TEMPLATES) expect(keys).toContain(t.key);
    expect(keys).toContain('interview_confirmation');
    for (const t of au) {
      expect(bannedIn(t.subject + '\n' + t.body), t.key).toEqual([]);
      expect(/your move|MyIntealth|AMC\b|SPPA/i.test(t.subject + t.body), t.key).toBe(false);
    }
    // A default the CEO has rewritten themselves is theirs: it is kept.
    const custom = emailTemplates.mergeEmailTemplates(emailTemplates.DEFAULT_EMAIL_TEMPLATES, [{ id: 'x1', template_key: 'welcome_next_steps', name: 'Mine', subject: 'S', body: 'B', active: true }]);
    expect(auMessages.composerTemplatesFor(custom, 'au').map((t) => t.key)).toContain('welcome_next_steps');
  });
});

describe('WP-17 (COM-20): the practice intake invite', () => {
  it('without the line the letter is byte-identical to the letter with no option at all', () => {
    const practicePipeline = require('../lib/practice-pipeline.js');
    const plain = practicePipeline.buildIntakeEmailCopy({ practiceName: 'Test Metro Practice (FAKE)', contactName: 'Pat Manager', intakeUrl: 'https://app.gplink-test.local/intake/TESTTOKEN' });
    expect(copy.intakeCopy(false)).toEqual(plain);
  });
  it('with the switch on it adds the Australian-registered line, right after the paragraph about UK, Irish and NZ doctors', () => {
    const on = copy.intakeCopy(true);
    const off = copy.intakeCopy(false);
    expect(on.bodyHtml.length).toBeGreaterThan(off.bodyHtml.length);
    expect(on.bodyHtml).toContain('already registered and working in Australia');
    expect(on.bodyHtml.indexOf('UK, Ireland, and New Zealand')).toBeLessThan(on.bodyHtml.indexOf('already registered and working in Australia'));
    expect(on.bodyHtml.replace('<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155">' + auMessages.INTAKE_AU_LINE + '</p>', '')).toBe(off.bodyHtml);
    expect(careerIntro.auPracticeTextViolations(auMessages.INTAKE_AU_LINE)).toEqual([]);
    expect(on.subject).toBe(off.subject);
  });
});

describe('WP-17 (N22): the owner digest block', () => {
  it('counts each Australian doctor once, by stage and by segment', () => {
    const counts = auMessages.auPipelineCounts({
      doctors: [
        { user_id: 'a', candidate_pathway: 'au_vr', onboarding_completed_at: null },
        { user_id: 'b', candidate_pathway: 'au_vr', onboarding_completed_at: '2026-11-01' },
        { user_id: 'c', candidate_pathway: 'au_vr', onboarding_completed_at: '2026-11-01' },
        { user_id: 'd', candidate_pathway: 'au_restricted', onboarding_completed_at: '2026-11-01' },
        { user_id: 'e', candidate_pathway: 'au_registrar', onboarding_completed_at: '2026-11-01' },
        { user_id: 'f', candidate_pathway: 'overseas_esp', onboarding_completed_at: '2026-11-01' },
        { user_id: 'g', candidate_pathway: null, onboarding_completed_at: '2026-11-01' }
      ],
      cases: [
        { user_id: 'b', stage: 'placement' }, { user_id: 'c', stage: 'prestart' }, { user_id: 'd', stage: 'guarantee' },
        { user_id: 'e', stage: 'myintealth' }, { user_id: 'f', stage: 'amc' }
      ]
    });
    expect(counts.total).toBe(5);
    expect(counts.stages).toEqual({ onboarding: 1, placement: 2, prestart: 1, commenced: 0, guarantee: 1, complete: 0 });
    expect(counts.segments).toEqual({ A: 3, B: 1, C: 1 });
    expect(counts.needsReview).toBe(2);
  });
  it('no Australian doctor: an empty block, so the digest is unchanged', () => {
    expect(auMessages.buildOwnerDigestBlock(auMessages.auPipelineCounts({ doctors: [], cases: [] }))).toEqual({ html: '', text: '', rows: [] });
    expect(auMessages.buildOwnerDigestBlock(null).html).toBe('');
  });
  it('the block names every stage and carries no doctor\'s details', () => {
    const block = auMessages.buildOwnerDigestBlock({ total: 3, stages: { onboarding: 1, placement: 1, prestart: 1, commenced: 0, guarantee: 0, complete: 0 }, segments: { A: 2, B: 1, C: 0 }, needsReview: 1 });
    for (const s of auMessages.PIPELINE_STAGES) expect(block.html).toContain(s.label);
    expect(block.html).toContain('Australian GPs');
    expect(/@|MED\d/.test(block.html)).toBe(false);
  });
});

describe('WP-17 (E): what staff read on the timeline', () => {
  it('"Message N16 sent", with the channels, and the WhatsApp skip by name', () => {
    const line = auMessages.describeOutcome('N16', auMessages.outcomeFromSendResult({ email: { sent: true }, bell: { sent: true }, whatsapp: { sent: false, reason: 'au_template_not_approved' } }));
    expect(line.title).toBe('Message N16 sent: Cleared to start (email, bell)');
    expect(line.detail).toBe('WhatsApp skipped: no approved Australian template');
  });
  it('a repeat that sent nothing writes nothing', () => {
    expect(auMessages.describeOutcome('N16', auMessages.outcomeFromSendResult({ email: { sent: false, reason: 'already_sent' }, bell: { sent: false, reason: 'already_sent' }, whatsapp: { sent: false, reason: 'already_sent' } }))).toBe(null);
  });
  it('a message held back for an unlaunched segment says so', () => {
    const line = auMessages.describeOutcome('N16', auMessages.outcomeFromSendResult({ email: { sent: false, reason: 'au_segment_not_launched' } }));
    expect(line.title).toBe('Message N16 not sent: Cleared to start');
    expect(line.detail).toBe('Email skipped: the doctor\'s segment is not launched');
  });
});

describe('WP-17: WhatsApp, skipped by name', () => {
  it('every template a lifecycle message names exists, is Australian, and is not approved', () => {
    for (const t of auMessages.LIFECYCLE_WHATSAPP_TEMPLATES) {
      const row = auWhatsAppTemplates.auWhatsAppTemplate(t.key, {});
      expect(row, t.key).toBeTruthy();
      expect(row.templateName).toBe(t.templateName);
      expect(row.approved).toBe(false);
      expect(/^gp_link_au_/.test(row.templateName)).toBe(true);
      expect(auWhatsAppTemplates.auDoctorWhatsAppPlan(t.key, {})).toEqual({ send: false, reason: 'au_template_not_approved', templateName: t.templateName });
      expect(bannedIn(t.body), t.key).toEqual([]);
      expect(/registration support officer/i.test(t.body)).toBe(false);
    }
    for (const id of auMessages.MESSAGE_IDS) {
      const key = auMessages.AU_MESSAGES[id].channels.whatsapp;
      if (key) expect(auWhatsAppTemplates.auWhatsAppTemplate(key, {}), id + ' ' + key).toBeTruthy();
    }
  });
  it('approving a row (by key, in the environment) turns its leg on and nothing else', () => {
    const plan = auWhatsAppTemplates.auDoctorWhatsAppPlan('cleared_to_start', { AU_WHATSAPP_APPROVED_TEMPLATES: 'cleared_to_start' });
    expect(plan.send).toBe(true);
    expect(plan.templateName).toBe('gp_link_au_cleared_to_start');
    expect(auWhatsAppTemplates.auDoctorWhatsAppPlan('welcome', { AU_WHATSAPP_APPROVED_TEMPLATES: 'cleared_to_start' }).send).toBe(false);
  });
});
