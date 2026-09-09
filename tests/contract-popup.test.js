// Owner 2026-09-10: "the practice extended an offer and the admin submitted
// the contract to the gp, the email was sent but no whatsapp message with CTA
// or in app congratulatory page with complete agreement cta is in place".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const P = require(path.join(process.cwd(), 'js', 'contract-popup.js'));

describe('contract popup — pure rules', () => {
  const NOW = Date.parse('2026-09-10T10:00:00Z');
  const c = (over) => Object.assign({ applicationId: 'a1', practiceName: 'Sandbox Coastal Medical Centre', sentAt: '2026-09-09T17:38:00Z', dismissedAt: null }, over);

  it('shows the newest contract awaiting signature and nothing for a locked / empty / failed response', () => {
    expect(P.pickPendingContract(null, NOW)).toBeNull();
    expect(P.pickPendingContract({ ok: true, locked: true, contracts: [c()] }, NOW)).toBeNull();
    expect(P.pickPendingContract({ ok: true, contracts: [] }, NOW)).toBeNull();
    const picked = P.pickPendingContract({ ok: true, contracts: [c({ applicationId: 'old', sentAt: '2026-09-01T00:00:00Z' }), c({ applicationId: 'new', sentAt: '2026-09-09T17:38:00Z' })] }, NOW);
    expect(picked.applicationId).toBe('new');
  });

  it('"I\'ll do it later" hides it for 24 hours, then it comes back while unsigned', () => {
    expect(P.DISMISS_HOURS).toBe(24);
    expect(P.pickPendingContract({ ok: true, contracts: [c({ dismissedAt: '2026-09-10T09:00:00Z' })] }, NOW)).toBeNull();
    expect(P.pickPendingContract({ ok: true, contracts: [c({ dismissedAt: '2026-09-08T09:00:00Z' })] }, NOW)).not.toBeNull();
    const r = P.pickPendingContract({ ok: true, contracts: [c({ applicationId: 'd', dismissedAt: '2026-09-10T09:00:00Z', sentAt: '2026-09-10T00:00:00Z' }), c({ applicationId: 'f' })] }, NOW);
    expect(r.applicationId).toBe('f');
  });

  it('the page speaks like the match page: badge, serif congratulations, practice card, Complete agreement, later', () => {
    const html = P.buildHtml({ applicationId: 'a1', practiceName: 'Sandbox Coastal Medical Centre', jobTitle: 'General Practitioner', locationCity: 'Merewether', locationState: 'NSW', website: 'https://coastal.example', headerImageUrl: 'javascript:alert(1)' }, { lastName: 'Miller' });
    expect(html).toContain('The position is yours');
    expect(html).toContain('Congratulations,<br>Dr Miller');
    expect(html).toContain('<b>Sandbox Coastal Medical Centre</b> has offered you the position');
    expect(html).toContain('Review your employment agreement and sign it');
    expect(html).toContain('data-gpcp-go href="/pages/offer-review?applicationId=a1">Complete agreement</a>');
    expect(html).toContain('data-gpcp-later>I’ll do it later');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('https://coastal.example');
    expect(P.agreementPath('x y')).toBe('/pages/offer-review?applicationId=x%20y');
  });
});

describe('wiring', () => {
  it('the shell loads it after the interview popup and the service worker precaches it', () => {
    const shell = read('pages/app-shell.html');
    const v = (/\/js\/contract-popup\.js\?v=([0-9a-z]+)/.exec(shell) || [])[1];
    expect(v).toBeTruthy();
    expect(shell.indexOf('/js/contract-popup.js?v=')).toBeGreaterThan(shell.indexOf('/js/interview-popup.js?v='));
    expect(read('sw.js')).toContain('"/js/contract-popup.js?v=' + v + '"');
  });

  it('the interview popup publishes its decision so the contract popup never stacks over it', () => {
    const ip = read('js/interview-popup.js');
    expect(ip).toContain("window.gpInterviewCheck = { pending: true, popupShown: false }");
    expect(ip).toContain("new CustomEvent('gp-interview-check-done', { detail: s })");
    expect(ip).toContain('publishInterviewCheck(true);');
    const cp = read('js/contract-popup.js');
    expect(cp).toContain("window.addEventListener('gp-interview-check-done', once, { once: true });");
    expect(cp).toContain("document.getElementById('gpMatchPopup') || document.getElementById('gpInterviewPopup')");
  });

  it('server: pending-contracts feed and the dismissal, both behind the GP session; a staff resend endpoint', () => {
    const s = read('server.js');
    expect(s).toContain("if (pathname === '/api/career/contracts/pending' && req.method === 'GET') {");
    expect(s).toContain("&status=eq.sent_to_gp&order=sent_to_gp_at.desc&limit=20");
    expect(s).toContain("if (pathname === '/api/career/contract/popup-seen' && req.method === 'POST') {");
    expect(s).toContain('csState.contract_popup_dismissed = csMap;');
    expect(s).toContain("if (pathname === '/api/ats/contract/notify-gp' && req.method === 'POST') {");
    expect(s).toContain("const cnSession = requireAtsSession(req, res);");
  });

  it('submitting a contract to the GP sends the WhatsApp template with a Complete-agreement button, alongside card, push and email', () => {
    const s = read('server.js');
    expect(s).toContain("var CONTRACT_WA_TEMPLATE = 'gp_link_contract_ready';");
    expect(s).toContain("sendDoubleTickTemplateTo(wa.phone, CONTRACT_WA_TEMPLATE, [wa.firstName || 'Doctor', practiceName || 'The practice'], [String(applicationId || '')])");
    const fn = s.slice(s.indexOf('async function notifyGpContractReady('), s.indexOf('async function sendMatchAcceptedWhatsAppToGp('));
    expect(fn).toContain("if (want('inapp'))");
    expect(fn).toContain("if (want('push'))");
    expect(fn).toContain("if (want('email'))");
    expect(fn).toContain("if (want('whatsapp'))");
    expect(fn).toContain("'Secure my position'");
    // the submit_to_gp branch goes through the shared notifier, nothing inline any more
    const at = s.indexOf("if (cdAction === 'submit_to_gp') {");
    const branch = s.slice(at, s.indexOf("// action === 'return_to_practice'", at));
    expect(branch).toContain('await notifyGpContractReady(cdContract, cdApp);');
    expect(branch).not.toContain('sendGpNotificationEmail(');
  });

  it('the card and the application page say "Complete agreement" too', () => {
    expect(read('pages/career.html')).toContain('ctaLabel: "Complete agreement", ctaHref: offerHref');
    expect(read('pages/application-detail.html')).toContain("isContractSent ? 'Complete agreement' : 'Review Offer'");
  });
});
