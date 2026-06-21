// tests/drive-lifecycle.test.js
import { describe, it, expect } from 'vitest';
import pkg from '../lib/drive-lifecycle.js';
const { stageForCase, isAcceptedStatus, LIFECYCLE_FOLDER_NAMES } = pkg;

describe('stageForCase', () => {
  it('archived account → archived regardless of placement', () => {
    expect(stageForCase({ accountStatus: 'archived', placementSecured: true })).toBe('archived');
    expect(stageForCase({ accountStatus: 'archived', placementSecured: false })).toBe('archived');
  });
  it('placement secured (not archived) → candidates', () => {
    expect(stageForCase({ accountStatus: 'active', placementSecured: true })).toBe('candidates');
  });
  it('signed up, not placed, not archived → users', () => {
    expect(stageForCase({ accountStatus: 'active', placementSecured: false })).toBe('users');
    expect(stageForCase({})).toBe('users');
  });
});

describe('isAcceptedStatus', () => {
  it('only approved counts as accepted', () => {
    expect(isAcceptedStatus('approved')).toBe(true);
    expect(isAcceptedStatus('Approved')).toBe(true);
    expect(isAcceptedStatus('uploaded')).toBe(false);
    expect(isAcceptedStatus('under_review')).toBe(false);
    expect(isAcceptedStatus('rejected')).toBe(false);
    expect(isAcceptedStatus('')).toBe(false);
    expect(isAcceptedStatus(null)).toBe(false);
  });
});

describe('LIFECYCLE_FOLDER_NAMES', () => {
  it('exact names', () => {
    expect(LIFECYCLE_FOLDER_NAMES).toEqual({ users: 'Users', candidates: 'Candidates', archived: 'Archived' });
  });
});
