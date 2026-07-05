import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isZohoCandidateHired, toCandidateLead, normalizeArchiveRow } = require('../lib/zoho-archive.js');

describe('isZohoCandidateHired', () => {
  it('is true when Candidate_Status says Hired (any case)', () => {
    expect(isZohoCandidateHired({ Candidate_Status: 'Hired' })).toBe(true);
    expect(isZohoCandidateHired({ Candidate_Status: 'hired' })).toBe(true);
    expect(isZohoCandidateHired({ Status: 'Placed' })).toBe(true);
  });
  it('is false for active/other statuses', () => {
    expect(isZohoCandidateHired({ Candidate_Status: 'New' })).toBe(false);
    expect(isZohoCandidateHired({})).toBe(false);
  });
  it('is true when Candidate_Stage says Hired (real Zoho org field)', () => {
    expect(isZohoCandidateHired({ Candidate_Status: 'New', Candidate_Stage: 'Hired' })).toBe(true);
    expect(isZohoCandidateHired({ Candidate_Stage: 'In Review' })).toBe(false);
  });
});

describe('toCandidateLead', () => {
  it('extracts name/email/phone/id', () => {
    expect(toCandidateLead({
      id: '123', Full_Name: 'Dr Jane Doe', Email: 'jane@example.com', Phone: '0400000000'
    })).toEqual({ name: 'Dr Jane Doe', email: 'jane@example.com', phone: '0400000000', zoho_candidate_id: '123' });
  });
  it('falls back to First+Last name and Mobile', () => {
    expect(toCandidateLead({
      id: '9', First_Name: 'Jane', Last_Name: 'Doe', Email: 'j@x.com', Mobile: '0411'
    })).toEqual({ name: 'Jane Doe', email: 'j@x.com', phone: '0411', zoho_candidate_id: '9' });
  });
  it('returns null when there is no email', () => {
    expect(toCandidateLead({ id: '1', Full_Name: 'No Email' })).toBeNull();
  });
});

describe('normalizeArchiveRow', () => {
  it('builds a row keyed by entity_type + zoho id', () => {
    const row = normalizeArchiveRow('candidate', { id: '77', Full_Name: 'X' }, '2026-07-05T00:00:00.000Z');
    expect(row).toEqual({
      entity_type: 'candidate', zoho_id: '77',
      payload: { id: '77', Full_Name: 'X' }, pulled_at: '2026-07-05T00:00:00.000Z'
    });
  });
  it('returns null when the record has no id', () => {
    expect(normalizeArchiveRow('client', { Full_Name: 'X' }, '2026-07-05T00:00:00.000Z')).toBeNull();
  });
});
