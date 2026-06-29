import { describe, it, expect } from 'vitest';
import * as m from '../lib/interview-meetings.js';

describe('interview-meetings model', () => {
  it('maps GP country to IANA timezone, defaulting to London', () => {
    expect(m.gpTzForCountry('uk')).toBe('Europe/London');
    expect(m.gpTzForCountry('ie')).toBe('Europe/Dublin');
    expect(m.gpTzForCountry('nz')).toBe('Pacific/Auckland');
    expect(m.gpTzForCountry('')).toBe('Europe/London');
  });

  it('defaults practice timezone to Sydney when location is unknown', () => {
    expect(m.practiceTzForLocation('')).toBe('Australia/Sydney');
    expect(m.practiceTzForLocation('Perth WA')).toBe('Australia/Perth');
  });

  it('builds an interview row tagged interview/ceo/requested', () => {
    const row = m.buildInterviewRow({
      caseId: 'c1', userId: 'u1', applicationId: 'a1', careerRoleId: 7,
      practiceName: 'Greenslopes', createdBy: 'ceo@x', nowIso: '2026-06-30T00:00:00.000Z'
    });
    expect(row.meeting_kind).toBe('interview');
    expect(row.host_kind).toBe('ceo');
    expect(row.application_id).toBe('a1');
    expect(row.practice_name).toBe('Greenslopes');
    expect(row.practice_availability_status).toBe('requested');
    expect(row.status).toBe('invited');
    expect(row.summary_status).toBe('not_requested');
  });

  it('normalizes a meeting row with kind label + is_interview flag', () => {
    const out = m.normalizeMeetingForApi({ meeting_kind: 'interview' });
    expect(out.is_interview).toBe(true);
    expect(out.meeting_kind_label).toBe('Interview');
  });
});
