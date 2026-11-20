import { describe, it, expect } from 'vitest';

const { isAuPathwayEnabled } = require('../lib/au-pathway-flag.js');

describe('AU_PATHWAY_ENABLED — the one switch for Australian-GP behaviour', () => {
  it('is OFF in production when the variable is not set', () => {
    expect(isAuPathwayEnabled({ VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(false);
    expect(isAuPathwayEnabled({ NODE_ENV: 'production' })).toBe(false);
  });

  it('is ON for Vercel preview deployments even though Vercel sets NODE_ENV=production there', () => {
    expect(isAuPathwayEnabled({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(true);
    expect(isAuPathwayEnabled({ VERCEL_ENV: 'development', NODE_ENV: 'development' })).toBe(true);
  });

  it('is ON for local development and tests', () => {
    expect(isAuPathwayEnabled({})).toBe(true);
    expect(isAuPathwayEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isAuPathwayEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('an explicit value always wins, in every environment', () => {
    for (const on of ['true', 'TRUE', '1', 'on', 'yes', ' true ']) {
      expect(isAuPathwayEnabled({ AU_PATHWAY_ENABLED: on, VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(true);
    }
    for (const off of ['false', 'FALSE', '0', 'off', 'no', ' false ']) {
      expect(isAuPathwayEnabled({ AU_PATHWAY_ENABLED: off, VERCEL_ENV: 'preview' })).toBe(false);
      expect(isAuPathwayEnabled({ AU_PATHWAY_ENABLED: off })).toBe(false);
    }
  });

  it('an unreadable value in production stays OFF (fails closed)', () => {
    expect(isAuPathwayEnabled({ AU_PATHWAY_ENABLED: 'maybe', VERCEL_ENV: 'production' })).toBe(false);
    expect(isAuPathwayEnabled({ AU_PATHWAY_ENABLED: '', VERCEL_ENV: 'production' })).toBe(false);
  });

  it('is read at call time, not cached', () => {
    const env = { VERCEL_ENV: 'production' };
    expect(isAuPathwayEnabled(env)).toBe(false);
    env.AU_PATHWAY_ENABLED = 'true';
    expect(isAuPathwayEnabled(env)).toBe(true);
  });
});
