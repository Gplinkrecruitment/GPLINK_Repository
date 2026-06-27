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
