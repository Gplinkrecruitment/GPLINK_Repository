// Why this file exists (2026-09-30): AHPRA's officer wrote on 29 Sep asking for a statement about
// the supervisor's HOURS at the practice. The AHPRA email route treated every
// "request_from_practice" as a conflict-of-interest follow-up, found the original conflict-letter
// task completed, and created a fresh one from the static template. The RSO sent it, and the
// practice replied that it had already sent that statement three weeks earlier. Meanwhile the
// hours statement AHPRA actually wanted had no task at all. These tests pin the gate, the follow-up
// letter, the practice-request wording and the server wiring so it cannot happen again.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import cl from '../lib/ahpra-conflict-letter.js';
import s80 from '../lib/ahpra-s80.js';
import triageLib from '../lib/email-triage.js';

const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

// The real 29 Sep officer email (abridged) and a faithful triage of it.
const HOURS_EMAIL = {
  subject: 'RE: Notice to provide further information under section 80(1)(b) of the National Law - 14805868',
  bodyText: 'Good morning,\n\nThank you for your email and for sending through the amended CV.\n\nIt is noted on Dr Ranatunga’s CV that he is currently also employed as a Medical student supervisor and OSCE examiner. Because of this, the Board will want to clarify how often Dr Ranatunga will be available at The Doctors Werribee to provide Indirect 2 level supervision to Dr Obanimoh.\n\nTherefore, could you please provide a statement from Dr Ranatunga clarifying if he is full-time at The Doctors Werribee, and if he is not, please provide his hours, and how he intends to provide Indirect level 2 supervision to Dr Obanimoh.\n\nPlease provide this information by 13 October 2026.'
};
const HOURS_TRIAGE = {
  category: 'information_request',
  response_type: 'request_from_practice',
  summary: 'AHPRA requests a signed statement from supervisor Dr Ranatunga clarifying his availability and hours at The Doctors Werribee, and how he will provide Indirect Level 2 supervision to Dr Obanimoh.'
};

describe('isConflictFollowupEmail — the words decide, not the category', () => {
  it('does NOT route the 29 Sep supervisor-hours request to the conflict letter, even as request_from_practice', () => {
    expect(cl.isConflictFollowupEmail(HOURS_TRIAGE, HOURS_EMAIL)).toBe(false);
  });

  it('still refuses when the AI mislabels it conflict_followup but the officer never mentions a conflict', () => {
    expect(cl.isConflictFollowupEmail(Object.assign({}, HOURS_TRIAGE, { category: 'conflict_followup' }), HOURS_EMAIL)).toBe(false);
  });

  it('routes a genuine follow-up whose ask is about the conflict of interest', () => {
    const t = { category: 'information_request', response_type: 'request_from_practice', summary: 'AHPRA still needs the conflict of interest management statement from the practice.' };
    expect(cl.isConflictFollowupEmail(t, { subject: 'RE: further information', bodyText: 'We have not received the statement.' })).toBe(true);
  });

  it('routes when the AI says conflict_followup and the officer body itself mentions a conflict-of-interest', () => {
    const t = { category: 'conflict_followup', response_type: 'request_from_practice', summary: 'Officer asks for a further statement.' };
    expect(cl.isConflictFollowupEmail(t, { subject: 'RE: application', bodyText: 'The conflict-of-interest statement provided does not say how supervision will be kept independent.' })).toBe(true);
  });

  it('never routes a status update that merely says the conflict statement was received', () => {
    const t = { category: 'application_update', response_type: 'status_update', summary: 'AHPRA confirms it received the conflict of interest statement.' };
    expect(cl.isConflictFollowupEmail(t, { subject: 'RE: application', bodyText: 'Thank you, the conflict of interest statement has been received.' })).toBe(false);
  });

  it('is false for empty input', () => {
    expect(cl.isConflictFollowupEmail(null, null)).toBe(false);
    expect(cl.isConflictFollowupEmail({}, {})).toBe(false);
  });
});

describe('buildConflictLetterEmail — follow-up mode when the practice already confirmed', () => {
  const base = { gpName: 'Mercy Obanimoh', supervisorName: 'Dr Chamira Ranatunga', practiceName: 'The Doctors Werribee', contactName: 'Dr Chamira Ranatunga', officerName: 'Paige Hooper', officerEmail: 'paige.hooper@ahpra.gov.au', ccEmail: 'hazel@mygplink.com.au', rsoSignoffName: 'Hazel' };

  it('says the confirmation was already sent, names the date, and quotes the officer instead of re-issuing the template', () => {
    const r = cl.buildConflictLetterEmail(Object.assign({}, base, { priorConfirmedAt: '2026-09-09T05:37:35.989Z', officerRequestText: 'Please also confirm how the conflict is reviewed each quarter.' }));
    expect(r.subject).toBe('Conflict-of-interest follow-up for Dr Mercy Obanimoh, AHPRA has asked again');
    expect(r.bodyHtml).toContain('already sent to AHPRA on 9 September 2026');
    expect(r.bodyHtml).toContain('In the officer’s own words: “Please also confirm how the conflict is reviewed each quarter.”');
    expect(r.bodyHtml).not.toContain('Suggested wording you can adapt');
    expect(r.bodyHtml).not.toContain('is also the owner/principal of');
    expect(r.bodyHtml).toContain('Paige Hooper (paige.hooper@ahpra.gov.au)');
    expect(r.bodyHtml).toContain('CC us (hazel@mygplink.com.au)');
  });

  it('HTML-escapes the quoted officer text', () => {
    const r = cl.buildConflictLetterEmail(Object.assign({}, base, { priorConfirmedAt: '2026-09-09T05:37:35.989Z', officerRequestText: 'Say <b>more</b> & "sign"' }));
    expect(r.bodyHtml).toContain('Say &lt;b&gt;more&lt;/b&gt; &amp; &quot;sign&quot;');
    expect(r.bodyHtml).not.toContain('<b>more</b>');
  });

  it('without a prior confirmation keeps the original letter and ignores any officer text', () => {
    const r = cl.buildConflictLetterEmail(Object.assign({}, base, { officerRequestText: 'ignored' }));
    expect(r.subject).toBe('Conflict-of-interest confirmation for Dr Mercy Obanimoh, please email AHPRA');
    expect(r.bodyHtml).toContain('is also the owner/principal of The Doctors Werribee');
    expect(r.bodyHtml).toContain('Suggested wording you can adapt');
    expect(r.bodyHtml).not.toContain('already sent to AHPRA');
    expect(r.bodyHtml).not.toContain('ignored');
  });

  it('formatLetterDate renders a Sydney calendar day and rejects junk', () => {
    expect(cl.formatLetterDate('2026-09-09T05:37:35.989Z')).toBe('9 September 2026');
    expect(cl.formatLetterDate('not a date')).toBe('');
    expect(cl.formatLetterDate('')).toBe('');
    expect(cl.formatLetterDate(null)).toBe('');
  });
});

describe('practice request drafts acknowledge a conflict statement already on file', () => {
  const opts = { gpName: 'Mercy Obanimoh', contactName: 'Dr Chamira Ranatunga', practiceName: 'The Doctors Werribee', itemTitle: 'Supervisor availability statement (Dr Ranatunga)', practiceInstructions: 'Please send a short signed statement from Dr Ranatunga on his hours.', reference: '14805868', deadline: '13 October 2026', senderName: 'Hazel, GP Link Registration Team' };

  it('the fail-open template adds the sentence only when priorConflictConfirmedAt is set', () => {
    const withNote = s80.buildPracticeRequestDraft(Object.assign({}, opts, { priorConflictConfirmedAt: '9 September 2026' }));
    expect(withNote.body).toContain('conflict-of-interest confirmation was already sent to AHPRA on 9 September 2026');
    expect(withNote.body).toContain('This is a separate request.');
    expect(withNote.body).not.toMatch(/—/);
    const without = s80.buildPracticeRequestDraft(opts);
    expect(without.body).not.toContain('conflict-of-interest');
  });

  it('the AI prompt instructs the model to say so in one sentence', () => {
    const m = s80.buildPracticeRequestMessages(Object.assign({}, opts, { priorConflictConfirmedAt: '9 September 2026' }));
    expect(m.userText).toContain('sent AHPRA its conflict-of-interest confirmation on 9 September 2026');
    expect(m.userText).toContain('separate request');
    expect(s80.buildPracticeRequestMessages(opts).userText).not.toContain('conflict-of-interest');
  });

  it('the s80 extraction prompt classes a supervisor hours/availability statement as a practice item, not a conflict item', () => {
    const prompt = s80.buildExtractionPrompt({ subject: HOURS_EMAIL.subject, sender: 'Paige.Hooper@ahpra.gov.au', bodyText: HOURS_EMAIL.bodyText }, { officer: { name: 'Paige Hooper', email: 'paige.hooper@ahpra.gov.au' } });
    expect(prompt).toMatch(/hours or availability at the practice/);
    expect(prompt).toMatch(/owner "practice", mode "practice_upload", kind "practice_document", with practice_instructions saying exactly/);
    expect(prompt).toMatch(/NOT a conflict-of-interest item/);
  });

  it('the AHPRA triage prompt reserves conflict_followup for a real conflict of interest', () => {
    expect(triageLib.AHPRA_TRIAGE_SYSTEM_PROMPT).toMatch(/CATEGORY RULE: use conflict_followup ONLY when/);
    expect(triageLib.AHPRA_TRIAGE_SYSTEM_PROMPT).toMatch(/hours or availability at the practice[\s\S]*NOT conflict_followup/);
    expect(triageLib.AHPRA_TRIAGE_SYSTEM_PROMPT).toMatch(/category MUST then be conflict_followup/);
  });
});

describe('server.js wiring', () => {
  it('Task 5 gates the conflict-letter route on isConflictFollowupEmail, not on response_type alone', () => {
    expect(src).toMatch(/var isConflictFollowup = isConflictFollowupEmail\(triage, emailMeta\);/);
    expect(src).not.toMatch(/var isConflictFollowup = triage\.category === 'conflict_followup' \|\| triage\.response_type === 'request_from_practice';/);
  });

  it('hands the officer\'s own words to the ensure helper', () => {
    expect(src).toMatch(/officerRequestText: emailMeta\.bodyText \|\| ''/);
  });

  it('a non-conflict request_from_practice goes to the s80 Who/How tray, where the AI names the document', () => {
    expect(src).toMatch(/\(triage\.response_type === 'request_from_gp' \|\| triage\.response_type === 'request_from_practice'\)\) \{/);
  });

  it('a confirmed conflict letter is never re-created from the template: no officer text means no new task', () => {
    expect(src).toMatch(/if \(priorConfirmed && !officerRequestText\) \{[\s\S]{0,300}return null;/);
    expect(src).toMatch(/priorConfirmedAt: priorConfirmedAt, officerRequestText: priorConfirmed \? officerRequestText : ''/);
    expect(src).toMatch(/title: priorConfirmed \? 'Conflict of interest follow-up — AHPRA has asked again' : 'Conflict of interest — ask practice to email AHPRA officer'/);
  });

  it('the letter never prints the supervisor as the practice', () => {
    expect(src).not.toMatch(/cRow\.practice_name \|\| sMeta\.practice_owner_name/);
    expect(src).toMatch(/var placedProf = await resolvePlacedPracticeProfile\(userId\);\s*\n\s*if \(placedProf && placedProf\.practiceName\) practiceName = String\(placedProf\.practiceName\)\.trim\(\);/);
  });

  it('the practice-request draft tells the practice its conflict confirmation is already on file', () => {
    expect(src).toMatch(/priorConflictConfirmedAt: pdPriorConflict/);
    expect(src).toMatch(/task_type=eq\.ahpra_conflict_letter&status=eq\.completed&order=created_at\.asc/);
  });
});
