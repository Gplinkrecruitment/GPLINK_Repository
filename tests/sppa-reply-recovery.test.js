import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');
const { selectSppaReplyMessage } = __testUtils;

// extractEmailMeta-shaped thread messages. `sender` may be a bare address or "Name <addr>".
function msg(id, sender, opts = {}) {
  return {
    messageId: id,
    sender,
    attachments: opts.attachments || [],
    internalDate: opts.internalDate || '0',
  };
}

const PRACTICE = 'khaleedmahmoud1211@gmail.com';
const CANDIDATE = 'smithmiller1234@gmail.com';

describe('selectSppaReplyMessage', () => {
  it('picks up the practice reply with an attachment when awaiting the practice', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE, sent_to_candidate_email: CANDIDATE };
    const messages = [
      msg('m-root', 'registration@mygplink.com.au', { internalDate: '100' }),
      msg('m-cand', CANDIDATE, { internalDate: '200', attachments: [{ filename: 'reply.pdf' }] }),
      msg('m-prac', PRACTICE, { internalDate: '300', attachments: [{ filename: 'SPPA-00.pdf' }] }),
    ];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe('practice');
    expect(r.message.messageId).toBe('m-prac');
    expect(r.expectedSender).toBe(PRACTICE);
  });

  it('matches the expected sender even when From is "Name <addr>"', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-prac', 'Khaleed Mahmoud <KhaleedMahmoud1211@gmail.com>', { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe('practice');
    expect(r.message.messageId).toBe('m-prac');
  });

  it('does NOT accept a candidate reply while awaiting the practice', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE, sent_to_candidate_email: CANDIDATE };
    const messages = [msg('m-cand', CANDIDATE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe(null);
    expect(r.reason).toBe('no-matching-reply');
  });

  it('picks up the candidate reply when awaiting the candidate', () => {
    const meta = { sppa_state: 'sent_to_candidate', sent_to_practice_email: PRACTICE, sent_to_candidate_email: CANDIDATE };
    const messages = [
      msg('m-prac', PRACTICE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] }),
      msg('m-cand', CANDIDATE, { internalDate: '400', attachments: [{ filename: 'signed.pdf' }] }),
    ];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe('candidate');
    expect(r.message.messageId).toBe('m-cand');
  });

  it('treats corrections_requested as awaiting the practice', () => {
    const meta = { sppa_state: 'corrections_requested', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-prac', PRACTICE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    expect(selectSppaReplyMessage(messages, meta, []).direction).toBe('practice');
  });

  it('treats gp_corrections_requested as awaiting the candidate', () => {
    const meta = { sppa_state: 'gp_corrections_requested', sent_to_candidate_email: CANDIDATE };
    const messages = [msg('m-cand', CANDIDATE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    expect(selectSppaReplyMessage(messages, meta, []).direction).toBe('candidate');
  });

  it('does not pick up when the SPPA is not awaiting a reply', () => {
    const meta = { sppa_state: 'practice_returned', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-prac', PRACTICE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe(null);
    expect(r.reason).toBe('not-awaiting');
  });

  it('requires an attachment (ignores a chatty reply with no file)', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-prac', PRACTICE, { internalDate: '300', attachments: [] })];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe(null);
  });

  it('skips a message already attached to the task (idempotent)', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-prac', PRACTICE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, ['m-prac']);
    expect(r.direction).toBe(null);
    expect(r.reason).toBe('already-attached');
  });

  it('chooses the NEWEST eligible practice reply when several exist', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [
      msg('m-old', PRACTICE, { internalDate: '100', attachments: [{ filename: 'old.pdf' }] }),
      msg('m-new', PRACTICE, { internalDate: '500', attachments: [{ filename: 'new.pdf' }] }),
      msg('m-mid', PRACTICE, { internalDate: '300', attachments: [{ filename: 'mid.pdf' }] }),
    ];
    expect(selectSppaReplyMessage(messages, meta, []).message.messageId).toBe('m-new');
  });

  it('returns no-expected-sender when the awaited address is missing from metadata', () => {
    const meta = { sppa_state: 'sent_to_practice' };
    const messages = [msg('m-prac', PRACTICE, { internalDate: '300', attachments: [{ filename: 'x.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, []);
    expect(r.direction).toBe(null);
    expect(r.reason).toBe('no-expected-sender');
  });
});

// ── Trusted-return senders (owner 2026-08-25, Dr Mercy Obanimoh) ────────────────────────────
// The practice manager the supervisor passed the form to returns it from her own address; a
// predicate over provably-affiliated addresses lets that reply flip the machine, PDF required.
const TRUSTED_PM = 'pm@thefamilydoctors.com.au';
const trustFn = (addr) => addr === TRUSTED_PM;

describe('selectSppaReplyMessage — trusted senders', () => {
  it('accepts a PDF return from a trusted non-expected sender while awaiting the practice', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE, sent_to_candidate_email: CANDIDATE };
    const messages = [msg('m-pm', 'Naomi Milne <pm@thefamilydoctors.com.au>', { internalDate: '400', attachments: [{ filename: 'CCF_000527.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, [], trustFn);
    expect(r.direction).toBe('practice');
    expect(r.message.messageId).toBe('m-pm');
  });

  it('still rejects an untrusted third party even with a PDF', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-x', 'stranger@example.com', { internalDate: '400', attachments: [{ filename: 'x.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, [], trustFn);
    expect(r.direction).toBe(null);
  });

  it('a trusted sender must return a PDF — an image attachment is not a return', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-pm', TRUSTED_PM, { internalDate: '400', attachments: [{ filename: 'photo.jpg', mimeType: 'image/jpeg' }] })];
    const r = selectSppaReplyMessage(messages, meta, [], trustFn);
    expect(r.direction).toBe(null);
  });

  it('the expected sender still passes without a PDF (in-thread path stays permissive)', () => {
    const meta = { sppa_state: 'sent_to_practice', sent_to_practice_email: PRACTICE };
    const messages = [msg('m-prac', PRACTICE, { internalDate: '400', attachments: [{ filename: 'scan.jpg' }] })];
    const r = selectSppaReplyMessage(messages, meta, [], trustFn);
    expect(r.direction).toBe('practice');
  });

  it('trust is never consulted while awaiting the CANDIDATE', () => {
    const meta = { sppa_state: 'sent_to_candidate', sent_to_practice_email: PRACTICE, sent_to_candidate_email: CANDIDATE };
    const messages = [msg('m-pm', TRUSTED_PM, { internalDate: '400', attachments: [{ filename: 'form.pdf' }] })];
    const r = selectSppaReplyMessage(messages, meta, [], trustFn);
    expect(r.direction).toBe(null);
  });
});

describe('sppaSenderIsTrustedForReturn', () => {
  const { sppaSenderIsTrustedForReturn } = __testUtils;
  const trust = {
    addresses: new Set(['pm@thefamilydoctors.com.au']),
    excluded: new Set(['dzungwemb@gmail.com']),
    signals: {
      domains: new Set(['thefamilydoctors.com.au']),
      tokens: ['werribee'],
    },
  };

  it('trusts an explicitly harvested address', () => {
    expect(sppaSenderIsTrustedForReturn('pm@thefamilydoctors.com.au', trust)).toBe(true);
  });
  it('trusts the practice domain', () => {
    expect(sppaSenderIsTrustedForReturn('reception@thefamilydoctors.com.au', trust)).toBe(true);
  });
  it('trusts a domain label echoing the practice name', () => {
    expect(sppaSenderIsTrustedForReturn('admin@werribeefamilyclinic.com.au', trust)).toBe(true);
  });
  it('NEVER trusts the candidate, even if harvested', () => {
    const t2 = { ...trust, addresses: new Set(['dzungwemb@gmail.com']) };
    expect(sppaSenderIsTrustedForReturn('dzungwemb@gmail.com', t2)).toBe(false);
  });
  it('a public webmail domain never vouches by domain', () => {
    expect(sppaSenderIsTrustedForReturn('someoneelse@gmail.com', trust)).toBe(false);
  });
  it('never trusts our own mailboxes', () => {
    expect(sppaSenderIsTrustedForReturn('registration@mygplink.com.au', trust)).toBe(false);
  });
  it('rejects a stranger', () => {
    expect(sppaSenderIsTrustedForReturn('stranger@example.com', trust)).toBe(false);
  });
});

// The surfacing + one-click accept must exist on BOTH dashboards and in the server (parity
// guard, same style as the repo's page greps — the endpoint literal is the contract).
describe('unverified-return surfacing (source guard)', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  it('server exposes the accept endpoint + shared transition', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    expect(src).toContain("pathname.endsWith('/sppa-accept-return')");
    expect(src).toContain('async function _applySppaPracticeReturn(');
    expect(src).toContain('unverified_return');
    expect(src).toContain('async function buildSppaTrustedReturnSenders(');
  });
  it('the shared transition identifies documents with AI and files extras as Other', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    // The transition asks the AI which document IS the SPPA-00 (filenames like CCF_000527
    // say nothing), refuses a confident non-SPPA return unless forced, and files a judged
    // non-CV extra to the GP's documents (practice_other_N + Drive) instead of calling
    // everything an alternate-supervisor CV.
    const fn = src.slice(src.indexOf('async function _applySppaPracticeReturn('), src.indexOf('async function _repairSppaMissingAttachments('));
    expect(fn).toContain('identifySppaDocuments(');
    expect(fn).toContain("reason: 'not_sppa_form'");
    expect(fn).toContain('_fileExtraPracticeDocToGp(');
    expect(src).toContain("document_key: 'practice_other_' + slot");
    // Missing-attachment self-heal: a listed-but-never-stored file is re-fetched from Gmail.
    expect(src).toContain('async function _repairSppaMissingAttachments(');
    expect(src).toContain("via: 'attachment_repair'");
    // The completeness check can never be pointed at a demoted "other" document.
    expect(src).toContain('category=not.in.(alt_supervisor_cv,other)');
  });
  it('admin dashboard renders the banner and calls the endpoint', () => {
    const src = fs.readFileSync(path.join(root, 'pages', 'admin.html'), 'utf8');
    expect(src).toContain('sppa-accept-return');
    expect(src).toContain('Accept as practice return');
    expect(src).toContain('unverified_return');
  });
  it('CEO dashboard renders the banner and calls the endpoint', () => {
    const src = fs.readFileSync(path.join(root, 'pages', 'ceo-dashboard.html'), 'utf8');
    expect(src).toContain('sppa-accept-return');
    expect(src).toContain('Accept as practice return');
    expect(src).toContain('unverified_return');
  });
});
