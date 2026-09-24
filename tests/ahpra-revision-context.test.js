import { describe, it, expect } from 'vitest';
import s80 from '../lib/ahpra-s80.js';
import chk from '../lib/ahpra-upload-check.js';

// Shapes taken from a real supervisor-CV resubmission thread (Yahoo + Apple Mail quoting).
const ASK = 'Dear Dr Ranatunga,\n\nAHPRA has noticed your CV lists current employment at White Cross Accident and Medical Clinic. Please send an updated CV showing the dates you finished.\n\nKind regards,\nHazel, GP Link';
const REPLY_1 = 'Hazel they are not correct , I finished in white cross in 2014.\nPut current employment only at The Doctors Werribee\n\n> On 22 Sep 2026, at 4:39 pm, Hazel, GP Link <registration@mygplink.com.au> wrote:\n> \n> Dear Dr Ranatunga,';
const REPLY_2 = ' Hazel pls find the new CV\n    On Thursday 24 September 2026 at 01:05:13 pm AEST, Hazel, GP Link <registration@mygplink.com.au> wrote:\n\n Dear Dr Ranatunga, AHPRA has been reviewing';

describe('stripQuotedReply', () => {
  it('keeps only what the sender wrote this time', () => {
    expect(s80.stripQuotedReply(REPLY_1)).toBe('Hazel they are not correct , I finished in white cross in 2014.\nPut current employment only at The Doctors Werribee');
    expect(s80.stripQuotedReply(REPLY_2)).toBe('Hazel pls find the new CV');
  });
  it('handles a wrapped "On … wrote:" header and Outlook history', () => {
    expect(s80.stripQuotedReply('Here it is.\nOn Tue, 22 Sep 2026 at 16:39, Hazel\n<registration@mygplink.com.au> wrote:\nold text')).toBe('Here it is.');
    expect(s80.stripQuotedReply('Attached.\n\nFrom: Hazel <x@y.com>\nSent: Monday')).toBe('Attached.');
  });
});

describe('buildRevisionContext', () => {
  it('carries our latest ask and what the practice told us to change', () => {
    const out = s80.buildRevisionContext({ messages: [
      { direction: 'outbound', body_text: 'first ask' },
      { direction: 'inbound', body_text: REPLY_1 },
      { direction: 'outbound', body_text: ASK },
      { direction: 'inbound', body_text: REPLY_2 }
    ] });
    expect(out).toContain('White Cross Accident and Medical Clinic. Please send an updated CV');
    expect(out).not.toContain('first ask');
    expect(out).toContain('I finished in white cross in 2014');
    expect(out).toContain('The Doctors Werribee');
    expect(out).not.toContain('> Dear Dr Ranatunga');
  });
  it('includes a previous reject reason and is empty when there is nothing', () => {
    expect(s80.buildRevisionContext({ rejectReason: 'Not signed', messages: [] })).toContain('rejected by our team because: Not signed');
    expect(s80.buildRevisionContext({})).toBe('');
  });
});

describe('upload check prompt with a requested correction', () => {
  it('asks the model to confirm each requested fix', () => {
    const p = chk.buildUploadCheckPrompt({ title: 'Supervisor CV', detail: 'd', revision_request: 'Remove White Cross as current employment' });
    expect(p).toContain('Remove White Cross as current employment');
    expect(p).toMatch(/is EACH one actually made in this file/);
  });
  it('is unchanged when there is no correction', () => {
    const p = chk.buildUploadCheckPrompt({ title: 'Supervisor CV', detail: 'd' });
    expect(p).not.toMatch(/EACH one actually made/);
    expect(p).not.toMatch(/Our emails with the sender/);
  });
});
