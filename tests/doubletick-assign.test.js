import { describe, it, expect } from 'vitest';
import { findRsoPhoneInRoster, buildDoubleTickAssignBody } from '../server.js';

const ROSTER = [
  { user_id: 'rso-khaleed', name: 'Khaleed', phone: '+61406281243', active: true },
  { user_id: 'rso-hazel', name: 'Hazel', phone: '', active: true },          // owner, no phone
  { user_id: 'rso-local', name: 'Local', phone: '0406281243', active: true } // AU local format
];

describe('findRsoPhoneInRoster', () => {
  it('returns the normalized phone for a matching RSO', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'rso-khaleed')).toBe('+61406281243');
  });
  it('normalizes an AU local 04xx number to +61', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'rso-local')).toBe('+61406281243');
  });
  it('returns empty string when the RSO has no phone (owner/archive)', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'rso-hazel')).toBe('');
  });
  it('returns empty string when the RSO is not in the roster', () => {
    expect(findRsoPhoneInRoster(ROSTER, 'nope')).toBe('');
  });
  it('returns empty string for bad inputs', () => {
    expect(findRsoPhoneInRoster(null, 'rso-khaleed')).toBe('');
    expect(findRsoPhoneInRoster(ROSTER, '')).toBe('');
  });
});

describe('buildDoubleTickAssignBody', () => {
  it('builds the assign body with reassign:true and digits-only WABA', () => {
    expect(buildDoubleTickAssignBody({
      gpPhone: '+61400000001', rsoPhone: '+61406281243', wabaNumber: '+61494391968'
    })).toEqual({
      customerPhoneNumber: '+61400000001',
      assignedUserPhoneNumber: '+61406281243',
      reassign: true,
      wabaNumber: '61494391968'
    });
  });
  it('normalizes phones inside the builder', () => {
    const body = buildDoubleTickAssignBody({ gpPhone: '0400000001', rsoPhone: '0406281243', wabaNumber: '+61494391968' });
    expect(body.customerPhoneNumber).toBe('+61400000001');
    expect(body.assignedUserPhoneNumber).toBe('+61406281243');
  });
  it('returns null when GP phone is missing', () => {
    expect(buildDoubleTickAssignBody({ gpPhone: '', rsoPhone: '+61406281243', wabaNumber: '+61494391968' })).toBeNull();
  });
  it('returns null when RSO phone is missing', () => {
    expect(buildDoubleTickAssignBody({ gpPhone: '+61400000001', rsoPhone: '', wabaNumber: '+61494391968' })).toBeNull();
  });
  it('returns null when WABA number is missing', () => {
    expect(buildDoubleTickAssignBody({ gpPhone: '+61400000001', rsoPhone: '+61406281243', wabaNumber: '' })).toBeNull();
  });
});
