// Owner 2026-09-08: "interview time was picked by gp and they received the
// email but no zoom joining link… same thing with the email to the practice.
// what about whatsapp, no templates were sent to the practice or gp".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const s = read('server.js');

describe('interview WhatsApp templates', () => {
  it('names the three approved templates and sends through the guarded template endpoint', () => {
    expect(s).toContain("confirmedGp: 'gp_link_interview_confirmed_gp'");
    expect(s).toContain("confirmedPractice: 'gp_link_interview_confirmed_practice'");
    expect(s).toContain("timesReady: 'gp_link_interview_times_ready'");
    const start = s.indexOf('async function sendDoubleTickTemplateTo(toPhone, templateName, placeholders, buttonParams) {');
    expect(start).toBeGreaterThan(0);
    const fn = s.slice(start, start + 2600);
    expect(fn).toContain("guardedNotifyFetch('whatsapp', DOUBLETICK_BASE_URL + '/whatsapp/message/template', {");
    expect(fn).toContain("content.templateData.buttons = buttonParams.map(function (p) { return { type: 'URL', parameter: String(p == null ? '' : p) }; });");
    expect(fn).toContain('doubleTickBatchOutcome(resp.ok, text)'); // never trusts a bare 200
  });
  it('booking sends the GP + practice confirmations after the emails, with the join link or a promise of it', () => {
    const gpEmail = s.indexOf("subject: 'Your interview is confirmed 🎉'");
    const wa = s.indexOf('var waGp = await lookupGpPhoneAndFirstName(appCtx.userId);');
    expect(gpEmail).toBeGreaterThan(0);
    expect(wa).toBeGreaterThan(gpEmail);
    const block = s.slice(wa, wa + 1200);
    expect(block).toContain("sendDoubleTickTemplateTo(waGp.phone, INTERVIEW_WA_TEMPLATES.confirmedGp,\n            [waGp.firstName || 'Doctor', appCtx.practiceName || 'the practice', gpWhen, waLink]);");
    expect(block).toContain("sendDoubleTickTemplateTo(appCtx.practicePhone, INTERVIEW_WA_TEMPLATES.confirmedPractice,");
    expect(s).toContain("var waLink = joinUrl || 'We will send the video link before the interview.';");
    expect(s).toContain("practice has no contact_phone — practice WhatsApp skipped");
  });
  it('the times-ready nudge uses the template with its Choose-your-time button', () => {
    expect(s).toContain("await sendDoubleTickTemplateTo(dtPhone, INTERVIEW_WA_TEMPLATES.timesReady, [waFirst, practiceName || 'the practice'], [String(id)]);");
    // the booking-invite block itself no longer sends plain text
    const inv = s.indexOf('async function maybeSendInterviewBookingInvite(');
    const invBlock = s.slice(inv, s.indexOf('async function notifyGpOfSelfAcceptedPlacement('));
    expect(invBlock).not.toContain("'/whatsapp/message/text'");
    expect(invBlock).not.toContain('doubleTickTextRequest(');
    // …and so does the practice-reply ingest (the other place the nudge fired)
    expect(s).toContain("sendDoubleTickTemplateTo(dtPhone, INTERVIEW_WA_TEMPLATES.timesReady, [gpFirstName, String(row.practice_name || '').trim() || 'the practice'], [gpAppId])");
    expect(s).not.toContain('your interview times are ready to choose — pick a slot here');
  });
  it('the booking context carries the practice contact name + phone', () => {
    expect(s).toContain("'select=contact_email,contact_name,contact_phone,location_state,location_city&id=eq.'");
    expect(s).toContain('practiceContactName: practiceContactName,\n      practicePhone: practicePhone');
  });
});

describe('email recipients must be addresses', () => {
  it('sendEmail drops a non-address recipient instead of filing a delivery failure', () => {
    const start = s.indexOf('async function sendEmail({ to, subject');
    const head = s.slice(start, start + 1400);
    expect(head).toContain("const droppedRecipients = recipients.filter((r) => !looksLikeEmailAddress(r));");
    expect(head).toContain("if (!recipients.length) return { ok: false, skipped: true, error: 'no_valid_recipient' };");
    // the regex accepts "Name <addr>" and rejects a bare label
    const re = new Function('return ' + head.match(/const looksLikeEmailAddress = (\(v\) => [^\n]+);/)[1])();
    expect(re('practice_decision')).toBe(false);
    expect(re('hello@mygplink.com.au')).toBe(true);
    expect(re('GP Link <hello@mygplink.com.au>')).toBe(true);
  });
  it('the offer-sender notice skips a system label such as practice_decision', () => {
    expect(s).toContain("if (!to || to.indexOf('@') === -1 || !isEmailConfigured()) return;");
  });
});
