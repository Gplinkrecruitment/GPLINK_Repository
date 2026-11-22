// Australian GP build, WP-20: the Australian branch of every prompt builder,
// the shared context paragraph, the net under a model's reply, and the triage
// and document-matching rules. Pure: nothing is booted and no model is called
// (the two tests that go through a fetch use a stub).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const cp = require('../lib/candidate-pathway.js');
const ctxLib = require('../lib/au-ai-context.js');
const auDoctorText = require('../lib/au-doctor-text.js');
const careerIntro = require('../lib/career-intro.js');
const ladders = require('../lib/journey-ladders.js');
const playbook = require('../lib/registration-playbook.js');
const suggestReply = require('../lib/suggest-reply-prompt.js');
const nudge = require('../lib/practice-nudge-draft.js');
const followup = require('../lib/practice-reply-followup.js');
const aiMatching = require('../lib/ai-matching.js');
const triage = require('../lib/email-triage.js');
const jobMatch = require('../lib/ai-candidate-job-match.js');
const auReview = require('../lib/au-document-review.js');
const docAiReview = require('../lib/doc-ai-review.js');
const migrationAgent = require('../lib/migration-agent-reply.js');

const NOW = '2026-11-01T00:00:00.000Z';
const STAFF = 'staff.test@gplink-test.local';
// Things that must never be in a prompt whose answer goes to a practice.
const SECRET = {
  condition: 'CONDITION-TEXT-SENTINEL must practise under supervision',
  undertaking: 'UNDERTAKING-TEXT-SENTINEL',
  ahpra: 'MED0001999999',
  provider: '246810AB',
  employer: 'CURRENT-EMPLOYER-SENTINEL Medical',
  suburb: 'SECRET-SUBURB'
};
const SECRET_CRED = { ahpra_number: SECRET.ahpra, has_conditions: true, conditions_text: SECRET.condition, has_undertakings: true, undertakings_text: SECRET.undertaking, visa_sponsor_name: SECRET.employer };

function resolve(d) {
  return cp.resolvePathwayFromRecords({ profile: d.profile, credentials: d.credentials, flagEnabled: true });
}
function ctxFor(kind, overrides, stageFacts) {
  const d = buildAuDoctor(kind, overrides);
  return { d, p: resolve(d), ctx: ctxLib.auPromptContext(resolve(d), d.credentials, stageFacts) };
}
const VERIFIED = { staff_verified_at: NOW, staff_verified_by: STAFF };
const A = () => ctxFor('au_vr', { credentials: VERIFIED });
const B_TIED = () => ctxFor('au_restricted', { credentials: Object.assign({ work_rights: 'visa', visa_sponsor_tied: true, ahpra_registration_type: 'general' }, VERIFIED) });
const B_CITIZEN = () => ctxFor('au_restricted', { credentials: { work_rights: 'citizen', visa_sponsor_tied: false } });

const OVERSEAS_SENTENCE = /overseas GPs register/;       // the premise the report quotes
const STATE = {
  stage: 'prestart',
  ahpraChecked: { at: NOW, verified: true },
  placement: { practiceName: 'Test Metro Practice (FAKE)', startDate: '2027-02-01', commencedAt: '', guaranteeEndsAt: '' },
  prestart: { complete: false, items: [
    { type: 'start_date_tracking', label: 'Notice period and confirmed start date', done: true },
    { type: 'indemnity_certificate', label: 'Collect indemnity certificate', done: false },
    { type: 'provider_number_new_location', label: 'Medicare provider number (new location)', done: false }
  ] }
};

afterEach(() => { process.env.AU_PATHWAY_ENABLED = 'true'; });

describe('auPromptContext: what a model is told about an Australian doctor', () => {
  it('is null for anyone who is not on an Australian pathway (they get today\'s prompt)', () => {
    for (const kind of ['overseas_null', 'overseas_explicit']) {
      const d = buildAuDoctor(kind);
      expect(ctxLib.auPromptContext(resolve(d), d.credentials, STATE), kind).toBe(null);
    }
    // the switch off: the resolver answers "overseas" whatever is stored
    const vr = buildAuDoctor('au_vr');
    expect(ctxLib.auPromptContext(cp.resolvePathwayFromRecords({ profile: vr.profile, credentials: vr.credentials, flagEnabled: false }), vr.credentials)).toBe(null);
    expect(ctxLib.auPromptContext(null)).toBe(null);
    expect(ctxLib.auPromptContext({ isAu: true, pathway: 'made_up' })).toBe(null);
    expect(ctxLib.auPromptBlock(null, 'staff')).toBe('');
  });

  it('segment A: already here, registered, changing practice, no visa or registration journey', () => {
    const { ctx } = A();
    expect(ctx.segment).toBe('A');
    expect(ctx.paragraph).toBe('This doctor is already in Australia, registered with Ahpra and working as a GP. They are changing practice within Australia. '
      + 'GP Link staff have confirmed they are a vocationally registered GP (FRACGP). They have no visa step and no registration step with GP Link.');
    expect(ctx.paragraph).not.toMatch(/19AB|sponsor|supervis/i);
    expect(ctx.forbidden.join(' ')).toMatch(/Do not mention a visa/);
  });

  it('a self-declared segment A doctor is not stated as fact', () => {
    const { ctx } = ctxFor('au_vr', { selfDeclared: true });
    expect(ctx.confirmed).toBe(false);
    expect(ctx.paragraph).toMatch(/told us they are a vocationally registered GP; GP Link staff have not confirmed this yet/);
    expect(ctx.paragraph).not.toMatch(/staff have confirmed they are/);
  });

  it('segment B: only what staff have recorded, each labelled with who said it', () => {
    const { ctx } = B_TIED();
    expect(ctx.segment).toBe('B');
    expect(ctx.sponsorTied).toBe(true);
    expect(ctx.paragraph).toMatch(/Section 19AB: staff have confirmed it applies \(Distribution Priority Area locations only\)\./);
    expect(ctx.paragraph).toMatch(/Right to work on file: a visa tied to a sponsoring employer\./);
    expect(ctx.paragraph).toMatch(/Ahpra registration type on file: general\./);
    expect(ctx.paragraph).toMatch(/has not launched its service for this group yet: staff handle this doctor by hand/);
    // the visa may be mentioned only as that recorded fact
    expect(ctx.forbidden.join(' ')).toMatch(/A visa may be mentioned only as the recorded fact above/);
    expect(ctx.forbidden.join(' ')).not.toMatch(/Do not mention a visa, sponsorship/);

    const citizen = B_CITIZEN().ctx;
    expect(citizen.sponsorTied).toBe(false);
    expect(citizen.paragraph).toMatch(/Australian citizen or permanent resident\. There is no visa step\./);
    expect(citizen.forbidden.join(' ')).toMatch(/Do not mention a visa, sponsorship/);

    // nothing recorded: said as not known, and the restrictive reading
    const unknown = ctxFor('au_restricted', { credentials: { moratorium_19ab_status: 'unsure', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_at: null, moratorium_19ab_confirmed_by: null, work_rights: null, visa_sponsor_tied: null } }).ctx;
    expect(unknown.paragraph).toMatch(/Section 19AB: not known yet; they are treated as limited to Distribution Priority Area locations/);
    expect(unknown.paragraph).toMatch(/Right to work: not recorded\./);
  });

  it('segment C: said as recorded, and as not launched', () => {
    expect(ctxFor('au_non_vr').ctx.paragraph).toMatch(/recorded as not vocationally registered/);
    expect(ctxFor('au_registrar').ctx.paragraph).toMatch(/recorded as a GP registrar/);
    expect(ctxFor('au_registrar').ctx.segment).toBe('C');
  });

  it('a registration flag is told as a flag; its wording never reaches any prompt block', () => {
    for (const make of [() => ctxFor('au_vr', { credentials: Object.assign({}, VERIFIED, SECRET_CRED) }), () => ctxFor('au_restricted', { credentials: SECRET_CRED })]) {
      const { ctx } = make();
      expect(ctx.paragraph).toMatch(/A registration condition, undertaking or notation is flagged on file/);
      for (const audience of ['staff', 'doctor', 'practice']) {
        const block = ctxLib.auPromptBlock(ctx, audience, { practiceIntro: 'Dr Test is a GP.' });
        for (const s of [SECRET.condition, SECRET.undertaking, SECRET.ahpra, SECRET.employer]) expect(block, audience).not.toContain(s);
      }
    }
  });

  it('STATE facts are told to staff, in the app\'s own words', () => {
    const { ctx } = ctxFor('au_vr', { credentials: VERIFIED }, STATE);
    expect(ctx.stateFacts).toEqual([
      'Stage: Pre-start (Australian ladder: Placement, Pre-start, Commenced, Guarantee period, Complete).',
      'Ahpra register check: done by staff on 2026-11-01, registration confirmed on the public register.',
      'Placement: recorded at Test Metro Practice (FAKE).',
      'Planned start date: 2027-02-01 (not yet confirmed as started).',
      'Pre-start items still open: Collect indemnity certificate; Medicare provider number (new location).',
      'Pre-start items complete: Notice period and confirmed start date.'
    ]);
    const staff = ctxLib.auPromptBlock(ctx, 'staff');
    expect(staff.indexOf('ABOUT THIS DOCTOR')).toBe(0);
    expect(staff).toMatch(/STATE FACTS \(read from the app's own records; authoritative\):/);
    // commenced and the guarantee period
    const after = ctxLib.auStateFactLines({ stage: 'guarantee', placement: { practiceName: 'P', startDate: '2027-02-01', commencedAt: '2027-02-03', guaranteeEndsAt: '2027-04-28' }, prestart: { complete: true, items: [{ type: 'credentialing_pack', label: 'Practice credentialing pack', done: true }] } });
    expect(after).toContain('Commenced: staff confirmed the doctor started on 2027-02-03.');
    expect(after).toContain('Guarantee period ends: 2027-04-28.');
    expect(after).toContain('Pre-start: every item is complete (Practice credentialing pack).');
    expect(ctxLib.auStateFactLines({ placement: null })).toEqual(['Placement: none recorded yet.']);
    // no commercial fact is ever a STATE fact
    expect(JSON.stringify(ctxLib.auStateFactLines(Object.assign({}, STATE, { placement: Object.assign({ fee_amount_ex_gst: 21000, invoice_sent_at: '2027-02-04', credit_pct: 50 }, STATE.placement) })))).not.toMatch(/21000|invoice|credit|fee/i);
  });

  it('a practice-facing block carries nothing from the doctor\'s records but the cleared introduction', () => {
    const { ctx } = ctxFor('au_restricted', { credentials: Object.assign({ work_rights: 'visa', visa_sponsor_tied: true }, SECRET_CRED) }, STATE);
    const block = ctxLib.auPromptBlock(ctx, 'practice', { practiceIntro: 'Dr Test is a GP based in New South Wales.', practiceStateFacts: ctxLib.auPracticeStateFactLines(STATE) });
    expect(block).toMatch(/Dr Test is a GP based in New South Wales\./);
    // (what it is told ABOUT the doctor is everything above the list of things never to write)
    const told = block.slice(0, block.indexOf('NEVER, for this doctor:'));
    expect(told).not.toMatch(/19AB|sponsor|visa|flagged|supervision level|not launched|restrict/i);
    expect(block).toMatch(/WHAT GP LINK NEEDS FROM A PRACTICE/);
    expect(block).toMatch(/Planned start date at the practice: 2027-02-01\./);
    // the doctor's indemnity certificate is their own business: not told to a practice
    expect(block).toMatch(/Still open before the start, where the practice has a part: Medicare provider number \(new location\)\./);
    expect(block).not.toMatch(/indemnity certificate;|Collect indemnity/);
    // with nothing cleared, it says so
    expect(ctxLib.auPromptBlock(ctx, 'practice')).toMatch(/Nothing else about them has been cleared for this practice\./);
  });
});

describe('the net under a model\'s reply', () => {
  const clean = 'Hi Sam, thanks for your note. We will confirm your start date with the practice this week.';
  it('a clean reply passes through unchanged', () => {
    expect(ctxLib.auOutputNet(clean, { audience: 'doctor' })).toEqual({ ok: true, text: clean, violations: [] });
    expect(ctxLib.auOutputNet(clean, { audience: 'practice' })).toEqual({ ok: true, text: clean, violations: [] });
  });
  it('every word of AGENT-RULES section 4 trips it, for a doctor and for a practice', () => {
    const samples = ['your MyIntealth account', 'the AMC portfolio', 'your EPIC verification', 'your visa', 'when you relocate', 'relocation support',
      'planning your move', 'overseas doctors', 'internationally trained', 'your GMC number', 'the SPPA-00', 'Section G', 'the supervisor CV', 'Not yet eligible'];
    for (const s of samples) {
      const r = ctxLib.auOutputNet('Hello, about ' + s + '.', { audience: 'doctor' });
      expect(r.ok, s).toBe(false);
      expect(r.text, s).toBe('');
      expect(r.violations.length, s).toBeGreaterThan(0);
      expect(ctxLib.auOutputNet('Hello, about ' + s + '.', { audience: 'practice' }).ok, s).toBe(false);
    }
    // word boundaries: these are not banned words
    for (const ok of ['It is advisable to confirm.', 'We moved the meeting.', 'The epicentre of town.']) expect(ctxLib.auOutputNet(ok, { audience: 'doctor' }).ok, ok).toBe(true);
  });
  it('a practice is additionally never sent money, "registration process" or the Expedited Specialist label', () => {
    for (const s of ['The fee is $21,000.', 'A 70% split.', 'We are managing the registration process.', 'On the Expedited Specialist Pathway.']) {
      expect(ctxLib.auOutputNet(s, { audience: 'practice' }).ok, s).toBe(false);
    }
  });
  it('a registration number or a provider number never travels in AI text', () => {
    expect(ctxLib.auOutputNet('Their number is ' + SECRET.ahpra + '.', { audience: 'doctor' }).violations).toContain('ahpra number');
    expect(ctxLib.auOutputNet('Provider number ' + SECRET.provider + ' is issued.', { audience: 'practice' }).violations).toContain('provider number');
  });
  it('the sponsor-tied exception is not opened by a reply draft: no context here is N21 or the transfer page', () => {
    const who = { pathway: 'au_restricted', credentials: { work_rights: 'visa', visa_sponsor_tied: true } };
    expect(ctxLib.auOutputNet('About your visa.', { audience: 'doctor', who }).ok).toBe(false);
    expect(ctxLib.auOutputNet('About their visa.', { audience: 'practice', who }).ok).toBe(false);
    // only the two named contexts (WP-14) open it, and only for "visa"
    expect(ctxLib.auOutputNet('About your visa.', { audience: 'doctor', who: Object.assign({ context: 'n21' }, who) }).ok).toBe(true);
    expect(ctxLib.auOutputNet('About your visa and relocation.', { audience: 'doctor', who: Object.assign({ context: 'n21' }, who) }).ok).toBe(false);
  });
});

describe('redactForPractice: what a practice-facing prompt is never given', () => {
  it('takes out the recorded secrets and anything shaped like a registration or provider number', () => {
    const secrets = ctxLib.practiceSecretsFrom({ credentials: SECRET_CRED, profile: { current_suburb: SECRET.suburb, register_number: SECRET.ahpra }, providerNumbers: [SECRET.provider] });
    const text = 'Conditions: ' + SECRET.condition + '. Ahpra ' + SECRET.ahpra + ', provider ' + SECRET.provider + ' and 135790XY, works at ' + SECRET.employer + ' in ' + SECRET.suburb + '. Undertaking: ' + SECRET.undertaking;
    const out = ctxLib.redactForPractice(text, secrets);
    for (const s of Object.keys(SECRET)) expect(out, s).not.toContain(SECRET[s]);
    expect(out).not.toContain('135790XY');
    expect(out).toContain(ctxLib.WITHHELD);
    // ordinary text is untouched
    expect(ctxLib.redactForPractice('Interview on 12 January 2027 at 10:30, phone 0412 345 678.', secrets)).toBe('Interview on 12 January 2027 at 10:30, phone 0412 345 678.');
  });
});

describe('the playbook: an entry for every Australian stage', () => {
  it('exists for every stage of the Australian ladder and for no overseas stage', () => {
    for (const stage of ladders.AU_STAGES) expect(playbook.playbookForStage(stage, { au: true }).length, stage).toBeGreaterThan(80);
    expect(Object.keys(playbook.AU_STAGE_PLAYBOOK).sort()).toEqual(ladders.AU_STAGES.slice().sort());
    for (const stage of ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement']) expect(playbook.playbookForStage(stage, { au: true }), stage).toBe('');
  });
  it('an overseas case still gets the overseas text, including the "placement" alias', () => {
    expect(playbook.playbookForStage('placement')).toBe(playbook.STAGE_PLAYBOOK.career);
    expect(playbook.playbookForStage('placement', { au: false })).toBe(playbook.STAGE_PLAYBOOK.career);
    expect(playbook.playbookForStage('prestart')).toBe('');
    expect(playbook.playbookForStage('placement', { au: true })).not.toBe(playbook.STAGE_PLAYBOOK.career);
  });
  it('is grounded in what the app does, marks its assumptions, and uses none of the banned words', () => {
    const all = playbook.AU_STAGE_PLAYBOOK;
    for (const stage of Object.keys(all)) expect(auDoctorText.violations(all[stage]), stage).toEqual([]);
    expect(all.prestart).toMatch(/indemnity certificate of currency/);
    expect(all.prestart).toMatch(/Medicare provider number for the new practice location/);
    expect(all.prestart).toMatch(/credentialing pack/);
    expect(all.prestart).toMatch(/notice/i);
    // each regulatory-sounding statement is marked as an assumption and not to be asserted
    expect(all.prestart.match(/\(assumption: /g).length).toBe(2);
    expect(all.guarantee).toMatch(/never use the word "guarantee"/);
    expect(all.commenced).toMatch(/Never mention GP Link's fee or invoice to the doctor/);
    for (const stage of Object.keys(all)) expect(all[stage], stage).not.toMatch(/\$|%|\b\d{2},\d{3}\b/);
  });
});

describe('staff reply drafts', () => {
  const base = {
    handoverSummary: 'STAFF-SUMMARY-SENTINEL: condition reviewed.',
    facts: { stage: 'Pre-start', note: 'Ahpra ' + SECRET.ahpra + ' provider ' + SECRET.provider },
    threadText: 'earlier email mentioning ' + SECRET.employer,
    currentEmail: 'From: x\n\nWhat do you still need? ' + SECRET.condition,
    rsoName: 'Test Rso'
  };
  const auFor = (made) => ({
    ctx: made.ctx, practiceIntro: 'Dr Test is a GP based in New South Wales.', practiceStateFacts: [],
    secrets: ctxLib.practiceSecretsFrom({ credentials: SECRET_CRED, providerNumbers: [SECRET.provider] })
  });

  it('the overseas sentence is present for an overseas doctor and absent for every Australian pathway', () => {
    const overseas = suggestReply.buildSuggestReplyMessages(Object.assign({ playbookText: playbook.playbookForStage('ahpra'), senderIsGp: true }, base));
    expect(overseas.system[0].text).toMatch(/helping overseas GPs register to work in Australia/);
    for (const kind of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']) {
      const made = ctxFor(kind);
      for (const senderIsGp of [true, false]) {
        const m = suggestReply.buildSuggestReplyMessages(Object.assign({ playbookText: playbook.playbookForStage('prestart', { au: true }), senderIsGp, au: auFor(made) }, base));
        const all = m.system[0].text + '\n' + m.userText;
        expect(all, kind).not.toMatch(/helping overseas GPs register|You are a Registration Support Officer|GP Link Registration team|\(Registration Support Officer, GP Link\)/);
        expect(m.system[0].text, kind).toMatch(/already registered with Ahpra and working as a GP in Australia/);
        expect(m.system[0].text, kind).toContain(suggestReply.GROUNDING_RULES);
        expect(m.userText.indexOf('ABOUT THIS DOCTOR'), kind).toBe(0);
        expect(m.userText, kind).toMatch(/Sign the reply off as Test Rso \(GP Link\)\./);
      }
    }
  });

  it('a reply to the doctor may use the staff summary; a reply to anyone else is never given it, or a secret', () => {
    const made = ctxFor('au_vr', { credentials: Object.assign({}, VERIFIED, SECRET_CRED) });
    const toDoctor = suggestReply.buildSuggestReplyMessages(Object.assign({ senderIsGp: true, au: auFor(made) }, base));
    expect(toDoctor.userText).toMatch(/STAFF-SUMMARY-SENTINEL/);
    expect(toDoctor.userText).toMatch(/Write a reply addressed directly to the doctor\./);

    const toPractice = suggestReply.buildSuggestReplyMessages(Object.assign({ senderIsGp: false, au: auFor(made) }, base));
    const sent = toPractice.system[0].text + '\n' + toPractice.userText;
    expect(sent).not.toMatch(/STAFF-SUMMARY-SENTINEL/);
    for (const s of [SECRET.condition, SECRET.undertaking, SECRET.ahpra, SECRET.provider, SECRET.employer]) expect(sent, s).not.toContain(s);
    expect(sent).toMatch(/Dr Test is a GP based in New South Wales\./);
    expect(sent).toMatch(/refer to the doctor in the third person/);
  });
});

describe('practice chase drafts', () => {
  const made = () => ctxFor('au_vr', { credentials: Object.assign({}, VERIFIED, SECRET_CRED) }, STATE);
  const auOpts = (m) => ({ ctx: m.ctx, practiceIntro: 'Dr Test is a GP based in New South Wales.', practiceStateFacts: ctxLib.auPracticeStateFactLines(STATE), secrets: ctxLib.practiceSecretsFrom({ credentials: SECRET_CRED, providerNumbers: [SECRET.provider] }) });
  const nudgeArgs = { docTitle: 'Employment contract', gpName: 'Test Auvr', contactName: 'Pat', rsoName: 'Test Rso', threadText: 'us: please send the contract. ' + SECRET.ahpra + ' ' + SECRET.provider + ' ' + SECRET.condition, daysSinceLastContact: 4, practiceEverReplied: false };
  const followArgs = { docTitle: 'Employment contract', gpName: 'Test Auvr', contactName: 'Pat', rsoName: 'Test Rso', replyText: 'Sending Friday. Is their number ' + SECRET.ahpra + '?', requestText: 'Please send. ' + SECRET.condition, replySender: 'pm@practice.test' };

  it('the nudge: overseas sentence present for overseas, absent for Australian; what GP Link needs is said; no secret is sent', () => {
    const overseas = nudge.buildPracticeNudgeMessages(nudgeArgs);
    expect(overseas.system[0].text).toMatch(/which helps overseas GPs register to work in Australia/);
    const m = made();
    const au = nudge.buildPracticeNudgeMessages(Object.assign({ au: auOpts(m) }, nudgeArgs));
    const sent = au.system[0].text + '\n' + au.userText;
    expect(sent).not.toMatch(/helps overseas GPs register|Registration Support Officer|Registration Team/);
    expect(au.system[0].text).toMatch(/writing to a medical practice/);
    expect(au.userText).toMatch(/interview times, an offer, the employment contract, the practice's own credentialing requirements, and the provider-number paperwork/);
    expect(au.userText).toMatch(/Never say something is needed "for registration"/);
    for (const s of [SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer]) expect(sent, s).not.toContain(s);
    // the rest of the drafting rules are the same ones
    expect(au.system[0].text).toMatch(/THEY HAVE NOT REPLIED to our last email/);
    expect(au.userText).toMatch(/Sign the draft off as Test Rso — GP Link\./);
  });

  it('the reply follow-up: the same', () => {
    const overseas = followup.buildPracticeReplyMessages(followArgs);
    expect(overseas.system[0].text).toMatch(/which helps overseas GPs register to work in Australia/);
    expect(overseas.system[0].text).toMatch(/because the regulator requires the document/);
    const au = followup.buildPracticeReplyMessages(Object.assign({ au: auOpts(made()) }, followArgs));
    const sent = au.system[0].text + '\n' + au.userText;
    expect(sent).not.toMatch(/helps overseas GPs register|the regulator requires|Registration Team/);
    for (const s of [SECRET.condition, SECRET.ahpra, SECRET.provider, SECRET.employer]) expect(sent, s).not.toContain(s);
    expect(au.userText).toMatch(/WHAT GP LINK NEEDS FROM A PRACTICE/);
  });

  it('the fixed fallbacks for an Australian doctor never say "their registration", and pass the practice net', () => {
    expect(nudge.buildFallbackNudge(nudgeArgs).suggested_reply).toMatch(/to proceed with their registration/);
    const auNudge = nudge.buildFallbackNudge(Object.assign({ au: true }, nudgeArgs));
    expect(auNudge.suggested_reply).not.toMatch(/registration/i);
    expect(auNudge.suggested_reply).toMatch(/ready to start with you/);
    expect(auNudge.source).toBe('fallback');
    for (const formOnFile of [true, false]) {
      const f = followup.buildFallbackFollowup(Object.assign({ au: true, formOnFile }, followArgs));
      expect(f.suggested_reply).not.toMatch(/Registration/);
      expect(ctxLib.auOutputNet(f.suggested_subject + '\n' + f.suggested_reply, { audience: 'practice' }).ok).toBe(true);
    }
    expect(ctxLib.auOutputNet(auNudge.suggested_subject + '\n' + auNudge.suggested_reply, { audience: 'practice' }).ok).toBe(true);
  });
});

describe('the email document matcher (DAT-27)', () => {
  const overseasTask = { task_id: 't-o', document_type: 'offer_contract', gp_name: 'Dr Test Overseas', practice_name: 'P' };
  const auIndemnity = { task_id: 't-ind', document_type: 'au_indemnity_certificate', gp_name: 'Dr Test Auvr', pathway: 'australian_gp' };
  const auProvider = { task_id: 't-prov', document_type: 'au_provider_number_letter', gp_name: 'Dr Test Auvr', pathway: 'australian_gp' };

  it('the overseas prompt is used unless an Australian doctor\'s task is in the list', () => {
    expect(aiMatching.matchSystemPromptFor([overseasTask])).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT);
    expect(aiMatching.matchSystemPromptFor([])).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT);
    expect(aiMatching.matchSystemPromptFor(null)).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT);
    expect(aiMatching.AI_MATCH_SYSTEM_PROMPT).toMatch(/helps overseas GPs register in Australia/);
    const au = aiMatching.matchSystemPromptFor([overseasTask, auIndemnity]);
    expect(au).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT_AU);
    expect(au).not.toMatch(/helps overseas GPs register/);
    expect(au).toMatch(/au_indemnity_certificate/);
    expect(au).toMatch(/au_provider_number_letter/);
    expect(au).toMatch(/certificate of currency/);
  });
  it('the document types are WP-07\'s own keys', () => {
    const reqs = require('../lib/document-requirements.js');
    for (const key of aiMatching.AU_MATCH_DOCUMENT_TYPES) expect(reqs.isAuRegDocumentKey(key), key).toBe(true);
  });
  it('a match is kept only when the document type is the task\'s own; an overseas task is judged as before', () => {
    const tasks = [overseasTask, auIndemnity, auProvider];
    const parsed = { is_relevant: true, summary: 's', matches: [
      { attachment_index: 0, task_id: 't-ind', document_type: 'au_indemnity_certificate', confidence: 0.9 },   // right slot
      { attachment_index: 1, task_id: 't-ind', document_type: 'au_provider_number_letter', confidence: 0.9 },  // wrong Australian slot
      { attachment_index: 2, task_id: 't-ind', document_type: 'offer_contract', confidence: 0.9 },             // a contract on an Australian task
      { attachment_index: 3, task_id: 't-o', document_type: 'au_indemnity_certificate', confidence: 0.9 },     // an Australian type on an overseas task
      { attachment_index: 4, task_id: 't-o', document_type: 'supervisor_cv', confidence: 0.9 },                // overseas, as before (type is not checked)
      { attachment_index: 5, task_id: 't-prov', document_type: 'au_provider_number_letter', confidence: 0.8 },
      { attachment_index: 6, task_id: null, document_type: 'offer_contract', confidence: 0.2 }
    ] };
    const out = aiMatching.enforceMatchDocumentTypes(parsed, tasks);
    expect(out.matches.map((m) => m.task_id)).toEqual(['t-ind', null, null, null, 't-o', 't-prov', null]);
    expect(out.matches[1].rejected_reason).toBe('document_type_mismatch');
    expect(out.is_relevant).toBe(true);
  });
  it('end to end through a stubbed model: the right prompt goes out, and a wrong-slot answer is refused', async () => {
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ is_relevant: true, summary: 'cert', matches: [
        { attachment_index: 0, task_id: 't-ind', document_type: 'au_indemnity_certificate', confidence: 0.92, reasoning: 'insurer' },
        { attachment_index: 1, task_id: 't-o', document_type: 'au_provider_number_letter', confidence: 0.9, reasoning: 'wrong' }
      ] }) }], usage: {} }), { status: 200 });
    };
    try {
      const email = { sender: 'certificates@avant.org.au', subject: 'Certificate of currency', body: 'Attached', attachments: [{ index: 0, filename: 'certificate-of-currency.pdf' }, { index: 1, filename: 'letter.pdf' }] };
      const mixed = await aiMatching.aiMatchEmail(email, [overseasTask, auIndemnity], { apiKey: 'test-key-not-real' });
      expect(sent[0].system[0].text).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT_AU);
      expect(mixed.matches.map((m) => m.task_id)).toEqual(['t-ind', null]);
      // an overseas-only list: today's prompt, and the reply is not second-guessed
      const overseasOnly = await aiMatching.aiMatchEmail(email, [overseasTask], { apiKey: 'test-key-not-real' });
      expect(sent[1].system[0].text).toBe(aiMatching.AI_MATCH_SYSTEM_PROMPT);
      expect(overseasOnly.matches.map((m) => m.task_id)).toEqual(['t-ind', 't-o']);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('inbound email triage', () => {
  const overseasGp = { user_id: 'u-o', gp_name: 'Dr Test Overseas', practice_name: 'P', contact_emails: ['o@x.test'] };
  const auGp = { user_id: 'u-a', gp_name: 'Dr Test Auvr', practice_name: 'Test Metro Practice (FAKE)', contact_emails: ['a@x.test'], pathway: 'australian_gp' };

  it('the model is offered the Australian categories only when an Australian doctor is in its list', () => {
    expect(triage.triageSystemPromptFor([overseasGp])).toBe(triage.TRIAGE_SYSTEM_PROMPT);
    expect(triage.triageSystemPromptFor([])).toBe(triage.TRIAGE_SYSTEM_PROMPT);
    const au = triage.triageSystemPromptFor([overseasGp, auGp]);
    expect(au).toBe(triage.TRIAGE_SYSTEM_PROMPT_AU);
    expect(au.indexOf(triage.TRIAGE_SYSTEM_PROMPT)).toBe(0);
    for (const c of ['provider_number', 'indemnity', 'credentialing', 'college']) expect(au, c).toMatch(new RegExp('  ' + c + ' — '));
    expect(triage.TRIAGE_SYSTEM_PROMPT).not.toMatch(/provider_number|credentialing/);
  });
  it('the parser lets an Australian category through only when told the Australian prompt was used', () => {
    const reply = (category) => JSON.stringify({ matched_gp_user_id: 'u-a', confidence: 0.9, category, urgency: 'normal', summary: 's', needs_triage: false });
    for (const c of triage.AU_TRIAGE_CATEGORIES) {
      expect(triage.parseTriageResponse(reply(c)).category, c).toBe('other');
      expect(triage.parseTriageResponse(reply(c), { au: true }).category, c).toBe(c);
    }
    expect(triage.parseTriageResponse(reply('visa'), { au: true }).category).toBe('visa');
  });
  it('through a stubbed model: an Australian category given for an overseas doctor is not accepted', async () => {
    const realFetch = globalThis.fetch;
    let reply = '';
    const sent = [];
    globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ content: [{ type: 'text', text: reply }], usage: {} }), { status: 200 }); };
    const answer = (userId, category) => JSON.stringify({ matched_gp_user_id: userId, confidence: 0.95, category, urgency: 'normal', summary: 's', needs_triage: false });
    try {
      const email = { sender: 'pm@practice.test', subject: 'Provider number', bodyText: 'x' };
      reply = answer('u-a', 'provider_number');
      expect((await triage.triageEmailWithSonnet(email, [overseasGp, auGp], { apiKey: 'test-key-not-real' })).category).toBe('provider_number');
      expect(sent[0].system[0].text).toBe(triage.TRIAGE_SYSTEM_PROMPT_AU);
      reply = answer('u-o', 'provider_number');
      expect((await triage.triageEmailWithSonnet(email, [overseasGp, auGp], { apiKey: 'test-key-not-real' })).category).toBe('other');
      // no Australian doctor in the list: today's prompt, today's parser
      reply = answer('u-o', 'provider_number');
      expect((await triage.triageEmailWithSonnet(email, [overseasGp], { apiKey: 'test-key-not-real' })).category).toBe('other');
      expect(sent[2].system[0].text).toBe(triage.TRIAGE_SYSTEM_PROMPT);
    } finally { globalThis.fetch = realFetch; }
  });

  // The routing table: one fixture set of senders and subjects, both pathways.
  // [sender, subject, body, AI category, { au: [category, stage], overseas: [category, stage] }]
  const AU = { isAu: true, stage: 'prestart' };
  const TABLE = [
    ['Services Australia <provider@servicesaustralia.gov.au>', 'Your Medicare provider number', 'Your provider number for the new location has been issued.', 'medicare_pbs', ['provider_number', 'prestart'], ['medicare_pbs', 'pbs']],
    ['Pat <pm@practice.test>', 'Provider number form for Dr Test', 'Please sign the provider number application.', 'other', ['provider_number', 'prestart'], ['medicare_pbs', 'pbs']],
    ['Avant <certificates@avant.org.au>', 'Your certificate', 'Attached is your certificate.', 'other', ['indemnity', 'prestart'], ['other', 'practice_contact']],
    ['MDA National <noreply@mdanational.com.au>', 'Policy renewal', 'Your policy renews soon.', 'other', ['indemnity', 'prestart'], ['other', 'practice_contact']],
    ['Pat <pm@practice.test>', 'Indemnity certificate of currency', 'Can you send it through?', 'document_request', ['indemnity', 'prestart'], ['document_request', 'practice_contact']],
    ['Pat <pm@practice.test>', 'Credentialing pack for Dr Test', 'We need the credentialing documents before the start.', 'practice_enquiry', ['credentialing', 'prestart'], ['practice_enquiry', 'practice_contact']],
    ['Pat <pm@practice.test>', 'Scope of practice form', 'Our credentials committee meets Tuesday.', 'other', ['credentialing', 'prestart'], ['other', 'practice_contact']],
    ['RACGP <exams@racgp.org.au>', 'CPD statement', 'Your CPD statement is ready.', 'regulator', ['college', 'prestart'], ['regulator', 'amc']],
    ['ACRRM <members@acrrm.org.au>', 'Fellowship', 'Membership renewal.', 'other', ['college', 'prestart'], ['regulator', 'amc']],
    ['Pat <pm@practice.test>', 'RACGP membership question', 'Does Dr Test hold RACGP fellowship?', 'other', ['college', 'prestart'], ['other', 'practice_contact']],
    ['Pat <pm@practice.test>', 'Start date', 'Can we move the start date?', 'schedule_query', ['schedule_query', 'practice_contact'], ['schedule_query', 'practice_contact']],
    ['Pat <pm@practice.test>', 'Hello', 'A general question.', 'credentialing', ['credentialing', 'prestart'], ['other', 'practice_contact']],   // the model's own Australian category, nothing deterministic
    ['Home Affairs <no-reply@homeaffairs.gov.au>', 'Notification', 'About your application.', 'visa', ['visa', 'prestart'], ['visa', 'visa']]
  ];
  it('routes a fixture set of senders and subjects, for an Australian doctor and for an overseas one', () => {
    for (const [sender, subject, bodySnippet, category, au, overseas] of TABLE) {
      const input = { sender, subject, bodySnippet, category, urgency: 'normal', matched: true, gpStage: 'ahpra', senderIsGp: false };
      const a = triage.resolveEmailRouting(Object.assign({ auPathway: AU }, input));
      expect([a.category, a.related_stage], 'AU: ' + subject).toEqual(au);
      // never an overseas stage for an Australian doctor
      expect(['amc', 'ahpra', 'visa', 'pbs', 'myintealth'], 'AU: ' + subject).not.toContain(a.related_stage);
      const o = triage.resolveEmailRouting(input);
      expect([o.category, o.related_stage], 'overseas: ' + subject).toEqual(overseas);
      // and an overseas result never carries an Australian category
      expect(triage.AU_TRIAGE_CATEGORIES, 'overseas: ' + subject).not.toContain(o.category);
    }
  });
  it('an Australian category on an overseas doctor\'s input changes nothing (the pre-WP-20 answer)', () => {
    for (const c of triage.AU_TRIAGE_CATEGORIES) {
      const base = { sender: 'Pat <pm@practice.test>', subject: 'Hello', bodySnippet: 'Hi', urgency: 'normal', matched: true, gpStage: 'ahpra', senderIsGp: false };
      expect(triage.resolveEmailRouting(Object.assign({ category: c }, base))).toEqual(triage.resolveEmailRouting(Object.assign({ category: 'other' }, base)));
    }
  });
  it('each Australian topic has a card title', () => {
    for (const c of triage.AU_TRIAGE_CATEGORIES) expect(triage.AU_TOPIC_TITLES[c], c).toBeTruthy();
  });
});

describe('confirmed from earlier packages', () => {
  it('WP-08: the Australian match prompt never mentions who is moving, a visa pathway, country of training or relocation; the overseas one still does', () => {
    expect(jobMatch.AI_MATCH_SYSTEM_PROMPT).toMatch(/who is moving with them/);
    expect(jobMatch.AI_MATCH_SYSTEM_PROMPT).toMatch(/visa pathway/);
    expect(jobMatch.AI_MATCH_SYSTEM_PROMPT).toMatch(/country of training/);
    const au = jobMatch.AI_MATCH_SYSTEM_PROMPT_AU;
    expect(au).not.toMatch(/moving|visa|country of training|relocat|overseas|arrival/i);
    expect(au).toMatch(/already registered with Ahpra and working in Australia/);
    // owner decision 9: the billing model yes, figures never
    expect(au).toMatch(/You MAY name the billing model/);
    expect(jobMatch.sanitiseAuMatchReasons(['Mixed billing suits you.', 'You keep 70% of billings.', 'Earn $300k.', 'Good for your visa.', 'Conditions on your registration are fine here.']))
      .toEqual(['Mixed billing suits you.']);
  });
  it('WP-07: an Australian document is never judged by the overseas rules, or an overseas one by the Australian rules', () => {
    const isQual = (key) => ['primary_medical_degree', 'mrcgp_certified', 'cct_certified'].indexOf(key) !== -1;
    for (const key of Object.keys(auReview.AU_REVIEW_RULES)) {
      expect(auReview.reviewRulesFor({ document_key: key, country_code: 'au_reg' }, isQual), key).toBe('au');
      for (const cc of ['GB', 'IE', 'NZ', 'AU', '']) expect(auReview.reviewRulesFor({ document_key: key, country_code: cc }, isQual), key + '/' + cc).not.toBe('overseas');
      const prompt = auReview.buildAuReviewPrompt(key, { today: '2026-11-01' });
      expect(prompt.system + prompt.user, key).not.toMatch(/August 2007|MRCGP|CCT|United Kingdom|Ireland|New Zealand|overseas/i);
    }
    for (const key of ['primary_medical_degree', 'mrcgp_certified', 'cct_certified']) {
      for (const cc of ['GB', 'IE', 'NZ']) expect(auReview.reviewRulesFor({ document_key: key, country_code: cc }, isQual), key).toBe('overseas');
      expect(auReview.reviewRulesFor({ document_key: key, country_code: 'au_reg' }, isQual), key).toBe('none');
      expect(auReview.buildAuReviewPrompt(key, { today: '2026-11-01' }), key).toBe(null);
    }
    expect(typeof docAiReview).toBe('object');
  });
  it('WP-14: the migration-agent transfer wording is used only for a nomination-transfer card', () => {
    for (const caseType of [undefined, null, '', 'new_application', 'transfer', 'NOMINATION_TRANSFER']) expect(migrationAgent.isTransferCase({ caseType }), String(caseType)).toBe(false);
    expect(migrationAgent.isTransferCase({ caseType: 'nomination_transfer' })).toBe(true);
    // and that card type can only be opened for a sponsor-tied segment B doctor
    const segB = require('../lib/au-segment-b.js');
    const stage = (pathway, credentials) => segB.visaStageFor({ isAu: true, flagEnabled: true, pathway, segment: cp.segmentOf(pathway) }, credentials);
    const tied = { work_rights: 'visa', visa_sponsor_tied: true };
    expect(stage('au_restricted', tied).mode).toBe(segB.VISA_MODE.TRANSFER);
    expect(segB.visaCaseAllowed(stage('au_restricted', tied))).toBe(true);
    for (const [pathway, cred] of [['au_vr', tied], ['au_non_vr', tied], ['au_registrar', tied],
      ['au_restricted', { work_rights: 'citizen', visa_sponsor_tied: true }], ['au_restricted', { work_rights: 'pr', visa_sponsor_tied: true }],
      ['au_restricted', { work_rights: 'visa', visa_sponsor_tied: false }], ['au_restricted', { work_rights: 'visa' }], ['au_restricted', null]]) {
      const v = stage(pathway, cred);
      expect(v.mode, pathway + '/' + JSON.stringify(cred)).not.toBe(segB.VISA_MODE.TRANSFER);
      expect(segB.visaCaseAllowed(v), pathway + '/' + JSON.stringify(cred)).toBe(false);
    }
  });
  it('WP-12: the render-time filter takes an overseas-only line out of stored role copy for an Australian doctor', () => {
    const stored = {
      id: 'internal_ats:role-1', title: 'General Practitioner',
      intro: 'A friendly family practice with a strong nursing team. Ideal for doctors relocating to Australia.',
      benefits: ['Visa and PR pathway support', 'Flexible sessions', 'Relocation support for overseas doctors', 'Mixed billing'],
      support: 'Full onboarding support from day one.'
    };
    const seen = auDoctorText.scrubRolePayload(stored);
    expect(seen.benefits).toEqual(['Flexible sessions', 'Mixed billing']);
    expect(seen.intro).toBe('A friendly family practice with a strong nursing team.');
    expect(seen.support).toBe(stored.support);
    expect(auDoctorText.violations(JSON.stringify(seen))).toEqual([]);
    // the stored copy itself is not changed
    expect(stored.benefits.length).toBe(4);
  });
  it('WP-09: the net under the recommendation blurb still drops a banned blurb and keeps a clean one', () => {
    expect(careerIntro.auSafeRecommendation('Dr Test is an internationally trained GP with ten years of experience.')).toBe('');
    const ok = 'Dr Test has ten years of general practice experience, with strengths in chronic disease and teaching.';
    expect(careerIntro.auSafeRecommendation(ok)).toBe(ok);
  });
});
