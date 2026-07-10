import { describe, it, expect } from 'vitest';
import { buildJobViewLinks, makePublicId } from '../js/ats-job-view-links.js';

describe('makePublicId', () => {
  it('joins provider and provider_role_id with a colon', () => {
    expect(makePublicId({ provider: 'zoho_recruit', provider_role_id: '11734000000821603' }))
      .toBe('zoho_recruit:11734000000821603');
  });
  it('prefers a precomputed public_id when present', () => {
    expect(makePublicId({ public_id: 'internal_ats:ats_carrara_gp', provider: 'x', provider_role_id: 'y' }))
      .toBe('internal_ats:ats_carrara_gp');
  });
  it('defaults the provider to zoho_recruit', () => {
    expect(makePublicId({ provider_role_id: 'abc' })).toBe('zoho_recruit:abc');
  });
  it('returns empty string when there is no role id', () => {
    expect(makePublicId({ provider: 'zoho_recruit' })).toBe('');
    expect(makePublicId(null)).toBe('');
  });
});

describe('buildJobViewLinks', () => {
  it('builds URL-encoded in-app and public-website links', () => {
    const links = buildJobViewLinks({ provider: 'zoho_recruit', provider_role_id: '11734000000821603' });
    expect(links.publicId).toBe('zoho_recruit:11734000000821603');
    expect(links.appUrl).toBe('/pages/job.html?id=zoho_recruit%3A11734000000821603');
    expect(links.websiteUrl).toBe('/jobs/view?id=zoho_recruit%3A11734000000821603');
  });
  it('works from a precomputed public_id (internal ATS job)', () => {
    const links = buildJobViewLinks({ public_id: 'internal_ats:ats_carrara_gp' });
    expect(links.appUrl).toBe('/pages/job.html?id=internal_ats%3Aats_carrara_gp');
    expect(links.websiteUrl).toBe('/jobs/view?id=internal_ats%3Aats_carrara_gp');
  });
  it('returns empty links when the job has no id', () => {
    const links = buildJobViewLinks({});
    expect(links).toEqual({ publicId: '', appUrl: '', websiteUrl: '' });
  });
});
