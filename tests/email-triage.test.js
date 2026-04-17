import { describe, it, expect, vi, afterEach } from 'vitest';

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
