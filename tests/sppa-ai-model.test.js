import { describe, it, expect } from 'vitest';
import model from '../lib/anthropic-model.js';
import completeness from '../lib/sppa-completeness-check.js';

const { sanitizeBodyForModel, isModelRetiredError, candidateModels } = model._internals;

describe('anthropic-model: SPPA model selection + auto-upgrade', () => {
  it('uses Opus 4.6 as the primary model by default', () => {
    expect(model.primaryModel()).toBe('claude-opus-4-6');
    expect(candidateModels()[0]).toBe('claude-opus-4-6');
  });

  it('lists newest-first fallbacks so a retired 4.6 upgrades to the latest model', () => {
    expect(candidateModels()).toEqual([
      'claude-opus-4-6', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6'
    ]);
  });

  it('honours an ANTHROPIC_MODEL env override as the primary', () => {
    const prev = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-x';
    try { expect(candidateModels()[0]).toBe('claude-opus-4-x'); }
    finally { if (prev === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = prev; }
  });

  it('keeps temperature on 4.6 but strips sampling params on 4.7/4.8 (forward-compat)', () => {
    expect(sanitizeBodyForModel({ temperature: 0, max_tokens: 9 }, 'claude-opus-4-6').temperature).toBe(0);
    const s48 = sanitizeBodyForModel({ temperature: 0, top_p: 1, top_k: 5 }, 'claude-opus-4-8');
    expect('temperature' in s48).toBe(false);
    expect('top_p' in s48).toBe(false);
    expect('top_k' in s48).toBe(false);
    expect(sanitizeBodyForModel({}, 'claude-opus-4-8').model).toBe('claude-opus-4-8');
  });

  it('treats unknown/retired model errors as upgrade triggers, but not transient errors', () => {
    expect(isModelRetiredError(404, null, 'not found')).toBe(true);
    expect(isModelRetiredError(404, { error: { type: 'not_found_error' } }, '')).toBe(true);
    expect(isModelRetiredError(400, { error: { type: 'not_found_error', message: 'model claude-opus-4-6 has been deprecated' } }, '')).toBe(true);
    // a temperature 400 or a rate-limit must NOT cause model churn
    expect(isModelRetiredError(400, { error: { type: 'invalid_request_error', message: 'temperature: not supported' } }, '')).toBe(false);
    expect(isModelRetiredError(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, '')).toBe(false);
  });
});

describe('sppa-completeness-check: verdict parsing', () => {
  it('parses an "incomplete" verdict with missing items', () => {
    const v = completeness.parseCompletenessResponse(JSON.stringify({
      is_complete: false, confidence: 'high',
      missing_signatures: ['Section J — primary supervisor unsigned'],
      missing_documents: ['Alternate supervisor CV for Dr X'],
      summary: 'Not ready: supervisor signature and an alternate CV are missing.'
    }));
    expect(v.is_complete).toBe(false);
    expect(v.confidence).toBe('high');
    expect(v.missing_signatures).toContain('Section J — primary supervisor unsigned');
    expect(v.missing_documents.length).toBe(1);
  });

  it('parses a "complete" verdict even with surrounding prose', () => {
    const v = completeness.parseCompletenessResponse('Here is my verdict: {"is_complete":true,"confidence":"high","summary":"All sections complete and signed."} done');
    expect(v.is_complete).toBe(true);
    expect(v.summary).toBe('All sections complete and signed.');
  });

  it('fails safe (not complete) on unparseable output', () => {
    const v = completeness.parseCompletenessResponse('the model said something unparseable');
    expect(v.is_complete).toBe(false);
    expect(v.confidence).toBe('low');
  });
});
