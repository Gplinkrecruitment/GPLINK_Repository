// Owner, 2026-09-30: "AHPRA did ask that the statement be emailed to the officer directly, so the
// AI should pick that up when using the suggested email and instruct the practice to do this
// with us CC'd." The officer had written "Dr Ranatunga can email a brief statement to me
// directly". These pins cover the detector, the item flag, the practice email wording, the
// recognition of a practice email that went to the officer with us copied, and the wiring.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import s80 from '../lib/ahpra-s80.js';

const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(process.cwd(), 'pages', 'admin.html'), 'utf8');

const OFFICER_SENTENCE = 'Dr Ranatunga can email a brief statement to me directly, or you can send a statement to me that has been signed by Dr Ranatunga.';

describe('detectDirectToOfficer — only when the officer says "directly"', () => {
  it('recognises the 29 Sep wording', () => {
    expect(s80.detectDirectToOfficer(OFFICER_SENTENCE)).toBe(true);
  });
  it('recognises "email me directly" and the rewritten "directly to your assigned AHPRA officer"', () => {
    expect(s80.detectDirectToOfficer('The practice can email me directly with the signed plan.')).toBe(true);
    expect(s80.detectDirectToOfficer('They may send a signed statement directly to your assigned AHPRA officer (Paige Hooper).')).toBe(true);
  });
  it('does NOT fire on the ordinary "please provide X to me" that every officer letter contains', () => {
    expect(s80.detectDirectToOfficer('Please provide the updated CV to me by 13 October 2026.')).toBe(false);
    expect(s80.detectDirectToOfficer('Send the document to my email address.')).toBe(false);
    expect(s80.detectDirectToOfficer('')).toBe(false);
    expect(s80.detectDirectToOfficer(null)).toBe(false);
  });
});

describe('normalizeItem carries direct_to_officer', () => {
  const base = { title: 'Supervisor availability statement (Dr Ranatunga)', owner: 'practice', mode: 'practice_upload', kind: 'practice_document', practice_instructions: 'Please send a short signed statement.' };
  it('from the officer\'s words even when the model said false', () => {
    const it1 = s80.normalizeItem(Object.assign({}, base, { detail: OFFICER_SENTENCE, direct_to_officer: false }), { country: 'uk' });
    expect(it1.direct_to_officer).toBe(true);
  });
  it('from the model when it said true', () => {
    const it2 = s80.normalizeItem(Object.assign({}, base, { detail: 'A statement about his hours.', direct_to_officer: true }), { country: 'uk' });
    expect(it2.direct_to_officer).toBe(true);
  });
  it('false for an ordinary practice item', () => {
    const it3 = s80.normalizeItem(Object.assign({}, base, { detail: 'Please provide an updated supervisor CV to me.' }), { country: 'uk' });
    expect(it3.direct_to_officer).toBe(false);
  });
  it('the extraction prompt asks the model for the flag', () => {
    const prompt = s80.buildExtractionPrompt({ subject: 'RE: s80', sender: 'Paige.Hooper@ahpra.gov.au', bodyText: OFFICER_SENTENCE }, {});
    expect(prompt).toContain('"direct_to_officer":false');
    expect(prompt).toMatch(/"direct_to_officer": true ONLY when the officer says the practice/);
  });
});

describe('officerCopiedOnEmail', () => {
  it('finds the officer in To, in a Cc array, or in the flattened recipient column', () => {
    expect(s80.officerCopiedOnEmail({ to: 'Paige Hooper <Paige.Hooper@ahpra.gov.au>', cc: 'hazel@mygplink.com.au' }, 'paige.hooper@ahpra.gov.au')).toBe(true);
    expect(s80.officerCopiedOnEmail({ to: 'hazel@mygplink.com.au', cc: ['pm@thefamilydoctors.com.au', 'paige.hooper@ahpra.gov.au'] }, 'Paige.Hooper@ahpra.gov.au')).toBe(true);
    expect(s80.officerCopiedOnEmail({ recipient: '"registration@mygplink.com.au" <registration@mygplink.com.au>, paige.hooper@ahpra.gov.au' }, 'paige.hooper@ahpra.gov.au')).toBe(true);
  });
  it('is false when the officer is absent or unknown', () => {
    expect(s80.officerCopiedOnEmail({ to: 'registration@mygplink.com.au', cc: '' }, 'paige.hooper@ahpra.gov.au')).toBe(false);
    expect(s80.officerCopiedOnEmail({ to: 'paige.hooper@ahpra.gov.au' }, '')).toBe(false);
    expect(s80.officerCopiedOnEmail(null, 'paige.hooper@ahpra.gov.au')).toBe(false);
  });
});

describe('the practice request tells the practice to email the officer and copy us', () => {
  const opts = { gpName: 'Mercy Obanimoh', contactName: 'Dr Chamira Ranatunga', practiceName: 'The Doctors Werribee', itemTitle: 'Supervisor availability statement (Dr Ranatunga)', practiceInstructions: 'Please confirm whether he is full-time at the practice.', reference: '14805868', deadline: '13 October 2026', senderName: 'Hazel, GP Link Registration Team', directToOfficer: true, officerName: 'Paige Hooper', officerEmail: 'paige.hooper@ahpra.gov.au', ccEmail: 'hazel@mygplink.com.au' };

  it('template: direct instruction with the officer, our CC, the deadline, and the reply-to-us fallback', () => {
    const d = s80.buildPracticeRequestDraft(opts);
    expect(d.body).toContain('AHPRA has asked that this go to the officer directly.');
    expect(d.body).toContain('Please email it to Paige Hooper (paige.hooper@ahpra.gov.au) and copy us in (hazel@mygplink.com.au) so we have it on file, by 13 October 2026.');
    expect(d.body).toContain('If you would rather send it to us first, just reply to this email with it attached');
    expect(d.body).not.toContain('Could you please reply to this email with the document attached');
    expect(d.body).not.toMatch(/—/);
  });
  it('template: without an officer address it falls back to the reply-to-us wording', () => {
    const d = s80.buildPracticeRequestDraft(Object.assign({}, opts, { officerEmail: '' }));
    expect(d.body).toContain('Could you please reply to this email with the document attached by 13 October 2026?');
    expect(d.body).not.toContain('go to the officer directly');
  });
  it('AI prompt: instructs the model to say email the officer directly and CC us, with the fallback', () => {
    const m = s80.buildPracticeRequestMessages(opts);
    expect(m.system).toContain('emailing it straight to the AHPRA officer named below with our mailbox copied in');
    expect(m.userText).toContain('email it directly to Paige Hooper at paige.hooper@ahpra.gov.au and to CC hazel@mygplink.com.au so we have it on file');
    expect(m.userText).toContain('reply to this email with it attached and we will forward it');
    const plain = s80.buildPracticeRequestMessages(Object.assign({}, opts, { directToOfficer: false }));
    expect(plain.system).toContain('replying with it attached.');
    expect(plain.userText).toContain('Ask them to reply to this email with the document attached');
  });
});

describe('server.js + admin.html wiring', () => {
  it('the s80 bundle stores the flag on the item', () => {
    expect(src).toMatch(/direct_to_officer: item\.direct_to_officer === true,/);
  });
  it('the practice-request draft resolves the officer and our mailbox and passes them to the builders', () => {
    expect(src).toMatch(/var pdDirect = pdMeta\.direct_to_officer === true \|\| ahpraS80\.detectDirectToOfficer\(pdMeta\.detail \|\| ''\);/);
    // "Copy us" = the hub the email goes out from (registration@), never the RSO's own mailbox.
    expect(src).toMatch(/if \(pdDirect\) \{ try \{ pdCcEmail = String\(\(\(await resolveCaseSenderInfo\(pdTask\.case_id\)\) \|\| \{\}\)\.from \|\| ''\)\.trim\(\); \}/);
    expect(src).not.toMatch(/pdCcEmail = await resolveCaseSenderEmail\(/);
    expect(src).toMatch(/ccEmail = String\(\(\(await resolveCaseSenderInfo\(caseId\)\) \|\| \{\}\)\.from \|\| ''\)\.trim\(\);/);
    expect(src).toMatch(/directToOfficer: pdDirect, officerName: pdOfficerName, officerEmail: pdOfficerEmail, ccEmail: pdCcEmail \}/);
    expect(src).toMatch(/direct_to_officer: pdDirect, officer_email: pdOfficerEmail, officer_name: pdOfficerName, cc_email: pdCcEmail,/);
  });
  it('both inbound filing paths recognise a practice email that went to the officer with us copied', () => {
    const hits = src.match(/delivered_to_officer = true;/g) || [];
    expect(hits.length).toBe(2);
    expect(src).toMatch(/ahpraS80\.officerCopiedOnEmail\(\{ to: emailMeta\.to, cc: emailMeta\.cc \}, _dpOfficerEmail\)/);
    expect(src).toMatch(/ahpraS80\.officerCopiedOnEmail\(\{ recipient: _afMsg\.recipient, cc: _afMsg\.cc \}, _afOfficerEmail\)/);
    expect(src).toMatch(/Practice sent the AHPRA document straight to the officer and copied us/);
  });
  it('the card accepts an already-delivered file without emailing AHPRA again, and explains the direct route on the composer', () => {
    expect(admin).toMatch(/var upDirect=!!\(isPr&&up\.delivered_to_officer\);/);
    expect(admin).toMatch(/data-s80-review="'\+esc\(t\.id\)\+'" data-s80-decision="approve"[^>]*>Accept \(already with AHPRA\)<\/button>/);
    expect(admin).toContain('It is already with AHPRA, so accept it here without forwarding it again.');
    expect(admin).toContain('AHPRA said the practice can send this straight to the officer. The draft asks them to email ');
  });
});
