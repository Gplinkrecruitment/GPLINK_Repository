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
