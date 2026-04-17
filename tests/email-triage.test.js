import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseTriageResponse, buildTriagePrompt } from '../lib/email-triage.js';

describe('Phase 1b AI matching — Sonnet + prompt cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts with model claude-sonnet-4-6 and cache_control on system block', async () => {
    const capturedBody = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('api.anthropic.com')) {
        capturedBody.push(JSON.parse(opts.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ text: '{"matches":[],"is_relevant":false,"summary":"x"}' }], usage: { input_tokens: 10, output_tokens: 10 } })
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { aiMatchEmail } = await import('../lib/ai-matching.js');
    await aiMatchEmail({ sender: 's@x.com', subject: 'x', body: 'x', attachments: [] }, [{ task_id: 't1', document_type: 'offer_contract', gp_name: 'Dr X' }]);
    expect(capturedBody.length).toBe(1);
    expect(capturedBody[0].model).toBe('claude-sonnet-4-6');
    expect(capturedBody[0].system).toBeDefined();
    const sysBlocks = Array.isArray(capturedBody[0].system) ? capturedBody[0].system : [capturedBody[0].system];
    expect(sysBlocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('Email triage — response parsing', () => {
  it('parses a well-formed triage response', () => {
    const text = JSON.stringify({
      matched_gp_user_id: 'u-1',
      confidence: 0.85,
      category: 'signing_question',
      urgency: 'high',
      summary: 'Contact asking about SPPA clause 4.2',
      needs_triage: false
    });
    const r = parseTriageResponse(text);
    expect(r.matched_gp_user_id).toBe('u-1');
    expect(r.confidence).toBe(0.85);
    expect(r.category).toBe('signing_question');
    expect(r.urgency).toBe('high');
    expect(r.needs_triage).toBe(false);
  });
  it('normalizes unknown category to "other"', () => {
    const text = JSON.stringify({ matched_gp_user_id: null, confidence: 0.2, category: 'banana', urgency: 'low', summary: 'x', needs_triage: true });
    const r = parseTriageResponse(text);
    expect(r.category).toBe('other');
  });
  it('marks needs_triage when confidence < 0.7', () => {
    const text = JSON.stringify({ matched_gp_user_id: 'u-2', confidence: 0.5, category: 'schedule_query', urgency: 'normal', summary: 'x', needs_triage: false });
    const r = parseTriageResponse(text);
    expect(r.needs_triage).toBe(true);
  });
  it('handles malformed JSON gracefully', () => {
    const r = parseTriageResponse('not-json');
    expect(r.needs_triage).toBe(true);
    expect(r.matched_gp_user_id).toBeNull();
  });
});

describe('Email triage — prompt building', () => {
  it('includes all placed GPs in user prompt', () => {
    const p = buildTriagePrompt(
      { sender: 's@x.com', subject: 'hi', body: 'body text', date: '2026-04-17' },
      [{ user_id: 'u-1', gp_name: 'Dr A', practice_name: 'A Clinic', contact_emails: ['a@x.com'] }]
    );
    expect(p).toContain('Dr A');
    expect(p).toContain('A Clinic');
    expect(p).toContain('s@x.com');
  });
});
