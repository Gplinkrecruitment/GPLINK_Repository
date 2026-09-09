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
  // Release merge 2026-09-10: main's own implementation of these sends
  // (sendInterviewWhatsappTemplate, bb1beb3) is the one that ships; the
  // branch's duplicate was removed so nobody is messaged twice. Main's helper
  // now also goes through the test allowlist and reads DoubleTick's per-message
  // FAILED rows as failures.
  it('booking sends the GP + practice confirmations after the emails — once each, via main\'s helper', () => {
    const gpEmail = s.indexOf("subject: 'Your interview is confirmed 🎉'");
    const wa = s.indexOf("sendInterviewWhatsappTemplate(appCtx.gpPhone, 'confirmed_gp'");
    expect(gpEmail).toBeGreaterThan(0);
    expect(wa).toBeGreaterThan(gpEmail);
    expect(s.slice(wa, wa + 600)).toContain("'confirmed_practice'");
    expect(s).not.toContain('INTERVIEW_WA_TEMPLATES.confirmedGp');
    expect(s.split("'confirmed_gp'").length - 1).toBe(1);
  });
  it("main's WhatsApp helper is guarded by the test allowlist and treats a FAILED row as a failure", () => {
    const h = s.slice(s.indexOf('async function sendInterviewWhatsappTemplate('), s.indexOf('async function sendInterviewWhatsappTemplate(') + 3000);
    expect(h).toContain("guardedNotifyFetch('whatsapp', DOUBLETICK_BASE_URL + '/whatsapp/message/template'");
    expect(h).toContain('const dtOutcome = doubleTickBatchOutcome(resp.ok, raw);');
    expect(h).not.toContain("await fetch(DOUBLETICK_BASE_URL + '/whatsapp/message/template'");
  });
  it('the times-ready nudge uses the template with its Choose-your-time button, from both places it fires', () => {
    const inv = s.indexOf('async function maybeSendInterviewBookingInvite(');
    const invBlock = s.slice(inv, s.indexOf('async function notifyGpOfSelfAcceptedPlacement('));
    expect(invBlock).toContain("'times_ready'");
    expect(invBlock).not.toContain("'/whatsapp/message/text'");
    expect(invBlock).not.toContain('doubleTickTextRequest(');
    expect(s).toContain("sendInterviewWhatsappTemplate(dtPhone, 'times_ready', [gpFirstName, String(row.practice_name || '').trim() || 'the practice'], gpAppId)");
    expect(s).not.toContain('your interview times are ready to choose — pick a slot here');
    expect(s).not.toContain('INTERVIEW_WA_TEMPLATES.timesReady');
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

describe('booking + admin re-send (owner 2026-09-08)', () => {
  it('interviews are 30 minutes everywhere: the row\'s own length (main 54b6946) with a 30-minute default, never a literal 45', () => {
    // Release merge 2026-09-10: main reads each interview's stored length via
    // interviewDurationMinutes(row); the branch's single constant was dropped.
    const lib = read('lib/interview-meetings.js');
    expect(lib).toContain('var INTERVIEW_DEFAULT_DURATION_MINUTES = 30;');
    expect(lib).toContain('function interviewDurationMinutes(row) {');
    expect(s).toContain('var bookDurationMin = interviewMeetings.interviewDurationMinutes(meetingRow);');
    expect(s).toContain('duration_minutes: bookDurationMin,');
    expect(s).not.toContain('INTERVIEW_DURATION_MIN');
    expect(s).not.toMatch(/durationMin: 45|45 \* 60000|duration_minutes: 45|\? 45 : 30/);
  });
  it('POST /api/ats/interview/resend-invite clears the one-shot stamp and re-sends, refusing a booked interview', () => {
    const a = s.indexOf("if (pathname === '/api/ats/interview/resend-invite' && req.method === 'POST') {");
    expect(a).toBeGreaterThan(0);
    const b = s.slice(a, a + 1600);
    expect(b).toContain('requireAtsSession(req, res)');
    expect(b).toContain("if (String(riRef.status || '') === 'booked') { sendJson(res, 409");
    expect(b).toContain('await patchApplicationDecisionFields(riAppId, { booking_invite_sent_at: null });');
    expect(b).toContain('await maybeSendInterviewBookingInvite(riAppId);');
  });
});
