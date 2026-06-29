import { describe, it, expect } from 'vitest';
import pkg from '../lib/suggest-reply-prompt.js';
const { buildSuggestReplyMessages, GROUNDING_RULES } = pkg;

const base = {
  playbookText: 'AHPRA: certified copies, signed CV, English pathway, ICHC, SPPA-00.',
  handoverSummary: 'Dr Sana Khan, AHPRA stage, UK. CV rejected once.',
  facts: { stage: 'ahpra', open_tasks: [{ title: 'Upload certified degree', status: 'open' }] },
  threadText: 'You: please send a certified copy.\nSana: where do I get it certified?',
  currentEmail: 'Sana: where do I get my degree certified?',
  senderIsGp: true,
};

describe('buildSuggestReplyMessages', () => {
  it('static system block carries the grounding rules + playbook and is cacheable', () => {
    const { system } = buildSuggestReplyMessages(base);
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0].text).toContain(GROUNDING_RULES);
    expect(system[0].text).toContain('AHPRA: certified copies');
  });
  it('the cacheable static block does NOT contain the per-email content', () => {
    const { system } = buildSuggestReplyMessages(base);
    expect(system[0].text).not.toContain('where do I get my degree certified');
    expect(system[0].text).not.toContain('Upload certified degree'); // facts are dynamic
  });
  it('grounding rules carry the practice-document request guardrail (no premature practice requests)', () => {
    expect(GROUNDING_RULES).toContain('outstanding_from_practice');
    expect(GROUNDING_RULES).toContain('do_not_request');
    expect(buildSuggestReplyMessages(base).system[0].text).toContain('do_not_request');
  });
  it('signs off as the assigned RSO, not a hardcoded name; static block stays RSO-agnostic', () => {
    const { system, userText } = buildSuggestReplyMessages({ ...base, rsoName: 'Smith Miller' });
    expect(system[0].text).not.toContain('Hazel');               // cached block shared across RSOs
    expect(userText).toContain('Sign the reply off as Smith Miller');
  });
  it('instructs plain-text formatting (no markdown / no Subject line) so drafts are not a wall of text', () => {
    expect(GROUNDING_RULES.toLowerCase()).toContain('plain text');
    expect(GROUNDING_RULES.toLowerCase()).toContain('markdown');
    expect(GROUNDING_RULES).toContain('Subject:');
    expect(buildSuggestReplyMessages(base).system[0].text.toLowerCase()).toContain('plain text');
  });
  it('signs off generically when no RSO name is given', () => {
    expect(buildSuggestReplyMessages(base).userText).toContain('GP Link Registration team');
  });
  it('user text carries summary, facts, thread, and the email to answer', () => {
    const { userText } = buildSuggestReplyMessages(base);
    expect(userText).toContain('Dr Sana Khan');
    expect(userText).toContain('Upload certified degree');
    expect(userText).toContain('where do I get my degree certified');
  });
  it('addresses the doctor directly when senderIsGp is true', () => {
    expect(buildSuggestReplyMessages(base).userText.toLowerCase()).toContain('directly to the doctor');
  });
  it('refers to the doctor in third person when the sender is a practice', () => {
    const { userText } = buildSuggestReplyMessages({ ...base, senderIsGp: false });
    expect(userText.toLowerCase()).toContain('third person');
  });
  it('omits optional sections cleanly when absent', () => {
    const { userText } = buildSuggestReplyMessages({ currentEmail: 'hi', senderIsGp: true });
    expect(userText).toContain('hi');
    expect(userText).not.toContain('CANDIDATE SUMMARY');
  });
});
