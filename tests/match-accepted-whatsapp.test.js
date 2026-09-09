// Owner 2026-09-07: "no whatsapp message was sent to the dr when they accepted
// the match for an interview" + "once the gp accepts the match then it becomes
// an application for the GP view".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('server: WhatsApp confirmation when a match is accepted', () => {
  const server = read('server.js');
  it('fires right after the accept response, alongside the existing email + in-app', () => {
    const idx = server.indexOf("sendJson(res, 200, { ok: true, action: 'accept'");
    expect(idx).toBeGreaterThan(0);
    const after = server.slice(idx, idx + 900);
    expect(after).toContain('notifyGpApplicationSubmitted(mrUserId, mrEmail, mrAccept.job || {}, mrAccept.caseId, mrGpDisplayName, { matched: true });');
    expect(after).toContain('sendMatchAcceptedWhatsAppToGp(mrAccept.updatedRow).catch(');
  });
  it('sends the approved template first, then plain text inside the 24h window; never throws', () => {
    const start = server.indexOf('async function sendMatchAcceptedWhatsAppToGp(appRow) {');
    expect(start).toBeGreaterThan(0);
    const fn = server.slice(start, server.indexOf('function matchNotifySummary(ann) {'));
    expect(server).toContain("var MATCH_ACCEPTED_WA_TEMPLATE = { templateName: 'gp_link_app_match_accepted', language: 'en' };");
    expect(fn).toContain("await send('/whatsapp/message/template', {");
    expect(fn).toContain("templateData: { body: { placeholders: [firstName, practiceName || 'the practice'] } }");
    expect(fn).toContain("await send('/whatsapp/message/text', doubleTickTextRequest(toPhone, buildMatchAcceptedWhatsAppText(firstName, practiceName), AbortSignal.timeout(15000)));");
    expect(fn).toContain('if (txt.status === 422) {'); // window closed → clear instruction, not a bare failure
    expect(fn).toContain("guardedNotifyFetch('whatsapp', DOUBLETICK_BASE_URL + path, init)"); // allowlist-guarded
    expect(fn).toContain("if (!DOUBLETICK_API_KEY) return { ok: false, skipped: 'no_api_key' };");
    expect(fn).toContain("if (!toPhone) return { ok: false, skipped: 'no_phone' };");
    expect(fn).toContain("console.error('[match-accepted-whatsapp] error:'");
  });
  it('reads DoubleTick\'s per-message status instead of trusting HTTP 200', () => {
    const start = server.indexOf('function doubleTickBatchOutcome(httpOk, bodyText) {');
    expect(start).toBeGreaterThan(0);
    const body = server.slice(start, server.indexOf('\n}\n', start) + 3);
    const fn = new Function(body + '; return doubleTickBatchOutcome;')();
    expect(fn(true, '{"messages":[{"status":"FAILED","errorMessage":"Template with given name and language not found"}]}')).toEqual({ ok: false, error: 'Template with given name and language not found' });
    expect(fn(true, '{"messages":[{"status":"SENT"}]}').ok).toBe(true);
    expect(fn(true, 'not json').ok).toBe(true);
    expect(fn(false, 'Unauthorized').ok).toBe(false);
    // both senders use it
    expect(fn(true, '{"messages":[{"status":"FAILED"},{"status":"SENT"}]}').ok).toBe(true); // partial batch still counts as sent
    expect(server.split('doubleTickBatchOutcome(resp.ok, ').length - 1).toBe(4); // match invitation, match accepted, interview templates, main's sendInterviewWhatsappTemplate (release merge 2026-09-10)
  });
  it('the plain-text wording names the practice and sets the interview expectation', () => {
    const start = server.indexOf('function buildMatchAcceptedWhatsAppText(firstName, practiceName) {');
    const body = server.slice(start, start + 600);
    const fn = new Function(body.slice(0, body.indexOf('\n}\n') + 3) + '; return buildMatchAcceptedWhatsAppText;')();
    const t = fn('Smith', 'Sandbox Coastal Medical Centre');
    expect(t).toContain('thanks for accepting your match with Sandbox Coastal Medical Centre');
    expect(t).toContain('arranging your interview');
    expect(fn('', '')).toContain('Hi there, thanks for accepting your match with the practice');
  });
});

describe('careers page: an accepted match reads as an application', () => {
  it('has its own FAST-TRACKED card state with the accept wording', () => {
    const career = read('pages/career.html');
    expect(career).toContain('if (key === "fast_tracked") {');
    expect(career).toContain('label: "Fast-tracked", ribbon: "FAST-TRACKED", tone: "blue", rowTone: "applied",');
    expect(career).toContain('blurb: "You accepted this match. Your Registration Support Officer is putting you forward now');
  });
  it('bumps the strip/home-card busters with the service worker', () => {
    expect(read('pages/career.html')).toContain('career-step-strip.js?v=20260907c');
    expect(read('pages/index.html')).toContain('career-home-card.js?v=20260907b');
    const sw = read('sw.js');
    expect(sw).toContain('"/js/career-step-strip.js?v=20260907c"');
    expect(sw).toContain('"/js/career-home-card.js?v=20260907b"');
  });
});

// Verified against the live DoubleTick API 2026-09-07: the text endpoint takes
// { to, from, content: { text } } with the raw key; every other shape is a 400.
describe('DoubleTick plain-text requests use the one shape the API accepts', () => {
  const server = read('server.js');
  it('doubleTickTextRequest builds the flat body with the raw key', () => {
    const start = server.indexOf('function doubleTickTextRequest(toPhone, text, signal) {');
    expect(start).toBeGreaterThan(0);
    const body = server.slice(start, server.indexOf('\n}\n', start) + 3);
    const fn = new Function('DOUBLETICK_API_KEY', 'HAZEL_WHATSAPP_NUMBER', body + '; return doubleTickTextRequest;')('rawkey', '+61 494 391 968');
    const req = fn('+61400000000', 'hello', 'sig');
    expect(req.method).toBe('POST');
    expect(req.signal).toBe('sig');
    expect(req.headers.Authorization).toBe('rawkey');
    expect(JSON.parse(req.body)).toEqual({ to: '+61400000000', from: '+61494391968', content: { text: 'hello' } });
  });
  it('every plain-text send site goes through it — no { to, body } or batch-shaped text bodies remain', () => {
    expect(server.split("DOUBLETICK_BASE_URL + '/whatsapp/message/text', doubleTickTextRequest(").length - 1).toBe(5);
    expect(server).not.toMatch(/JSON\.stringify\(\{ to: [A-Za-z]+, body: /);
    expect(server).not.toMatch(/'Bearer ' \+ process\.env\.DOUBLETICK_API_KEY/);
  });
});
