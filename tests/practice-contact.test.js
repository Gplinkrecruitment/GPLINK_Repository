// tests/practice-contact.test.js
import { describe, it, expect } from 'vitest';
import {
  PLACED_APPLICATION_FILTER,
  PLACED_APPLICATION_COLUMNS,
  hasContactEmail,
  practiceIdForRow,
  applyPracticeContactFallback,
  pickPlacedApplication,
  toPracticeContact,
  pendingPracticeIds,
  pendingRoleIds
} from '../lib/practice-contact.js';

// The live row that exposed both bugs: a placement written straight to the database,
// so status is 'placement_secured' (not 'hired') and the contact columns are NULL —
// which left the admin "Request document from practice" composer with an empty To
// and a "Hi ," greeting even though the practice had a contact on file.
const HAND_CREATED_PLACEMENT = {
  user_id: 'gp-mercy',
  career_role_id: 93103,
  practice_id: 'practice-werribee',
  practice_contact_name: null,
  practice_contact_email: null,
  status: 'placement_secured',
  ats_stage: 'hired'
};

const WERRIBEE = { id: 'practice-werribee', contact_name: 'Dr Chamira Ranatunga', contact_email: 'chamira@example.com' };

describe('PLACED_APPLICATION_FILTER', () => {
  it('matches placements on ats_stage as well as status', () => {
    // status=eq.hired alone was the whole bug — a hand-created placement never matched.
    expect(PLACED_APPLICATION_FILTER).toContain('status.eq.hired');
    expect(PLACED_APPLICATION_FILTER).toContain('ats_stage.eq.hired');
    expect(PLACED_APPLICATION_FILTER.startsWith('or=(')).toBe(true);
  });

  it('selects both routes to a practices row so the fallback can run', () => {
    expect(PLACED_APPLICATION_COLUMNS).toContain('practice_id');
    expect(PLACED_APPLICATION_COLUMNS).toContain('career_role_id');
    // gp_applications has NO practice_name column — selecting it 400s the whole query.
    expect(PLACED_APPLICATION_COLUMNS).not.toContain('practice_name');
  });
});

describe('hasContactEmail', () => {
  it('treats null, empty and whitespace-only addresses as missing', () => {
    expect(hasContactEmail({ practice_contact_email: null })).toBe(false);
    expect(hasContactEmail({ practice_contact_email: '' })).toBe(false);
    expect(hasContactEmail({ practice_contact_email: '   ' })).toBe(false);
    expect(hasContactEmail(null)).toBe(false);
    expect(hasContactEmail({ practice_contact_email: 'a@b.com' })).toBe(true);
  });
});

describe('practiceIdForRow', () => {
  it('prefers the application own practice_id', () => {
    expect(practiceIdForRow(HAND_CREATED_PLACEMENT, { 93103: 'practice-other' })).toBe('practice-werribee');
  });

  it('falls back to the career role practice for rows that predate the column', () => {
    const legacy = { ...HAND_CREATED_PLACEMENT, practice_id: null };
    expect(practiceIdForRow(legacy, { 93103: 'practice-from-role' })).toBe('practice-from-role');
  });

  it('returns empty when there is nothing to look up', () => {
    expect(practiceIdForRow({ practice_id: null, career_role_id: null }, {})).toBe('');
    expect(practiceIdForRow(null, {})).toBe('');
  });
});

describe('applyPracticeContactFallback', () => {
  it('fills a blank contact from the linked practice record', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT }];
    applyPracticeContactFallback(rows, { 'practice-werribee': WERRIBEE }, {});
    expect(rows[0].practice_contact_email).toBe('chamira@example.com');
    expect(rows[0].practice_contact_name).toBe('Dr Chamira Ranatunga');
  });

  it('never overwrites a contact the offer flow already stored', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT, practice_contact_email: 'manager@clinic.com', practice_contact_name: 'Practice Manager' }];
    applyPracticeContactFallback(rows, { 'practice-werribee': WERRIBEE }, {});
    expect(rows[0].practice_contact_email).toBe('manager@clinic.com');
    expect(rows[0].practice_contact_name).toBe('Practice Manager');
  });

  it('keeps a stored name when only the address is missing', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT, practice_contact_name: 'Reception' }];
    applyPracticeContactFallback(rows, { 'practice-werribee': WERRIBEE }, {});
    expect(rows[0].practice_contact_email).toBe('chamira@example.com');
    expect(rows[0].practice_contact_name).toBe('Reception');
  });

  it('resolves the practice through the career role when the application has no practice_id', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT, practice_id: null }];
    applyPracticeContactFallback(rows, { 'practice-werribee': WERRIBEE }, { 93103: 'practice-werribee' });
    expect(rows[0].practice_contact_email).toBe('chamira@example.com');
  });

  it('leaves the row blank when the practice itself has no contact email', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT }];
    applyPracticeContactFallback(rows, { 'practice-werribee': { id: 'practice-werribee', contact_name: 'Someone', contact_email: '  ' } }, {});
    expect(hasContactEmail(rows[0])).toBe(false);
    // A name without an address must not be adopted — the greeting would then read
    // "Hi Someone," on an email with nobody in the To field.
    expect(rows[0].practice_contact_name).toBeNull();
  });

  it('tolerates missing lookups and non-array input', () => {
    expect(applyPracticeContactFallback(null, null, null)).toEqual([]);
    const rows = [{ ...HAND_CREATED_PLACEMENT }];
    expect(applyPracticeContactFallback(rows, {}, {})[0].practice_contact_email).toBeNull();
  });
});

describe('pendingPracticeIds / pendingRoleIds', () => {
  it('only asks for what a blank row actually needs', () => {
    const rows = [
      { ...HAND_CREATED_PLACEMENT },
      { user_id: 'gp-filled', career_role_id: 5, practice_id: 'practice-other', practice_contact_email: 'has@contact.com' }
    ];
    // The filled row costs no extra lookup.
    expect(pendingPracticeIds(rows, {})).toEqual(['practice-werribee']);
    expect(pendingRoleIds(rows)).toEqual([]);
  });

  it('lists role ids only for blank rows with no practice_id', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT, practice_id: null }];
    expect(pendingRoleIds(rows)).toEqual([93103]);
    expect(pendingPracticeIds(rows, { 93103: 'practice-from-role' })).toEqual(['practice-from-role']);
  });

  it('de-duplicates so two GPs at one practice cost one lookup', () => {
    const rows = [{ ...HAND_CREATED_PLACEMENT }, { ...HAND_CREATED_PLACEMENT, user_id: 'gp-two' }];
    expect(pendingPracticeIds(rows, {})).toEqual(['practice-werribee']);
  });
});

describe('pickPlacedApplication', () => {
  it('prefers the placement that actually carries an address', () => {
    const blank = { ...HAND_CREATED_PLACEMENT };
    const filled = { ...HAND_CREATED_PLACEMENT, user_id: 'gp-mercy', practice_contact_email: 'real@clinic.com' };
    expect(pickPlacedApplication([blank, filled])).toBe(filled);
  });

  it('falls back to the first row and handles an empty set', () => {
    const blank = { ...HAND_CREATED_PLACEMENT };
    expect(pickPlacedApplication([blank])).toBe(blank);
    expect(pickPlacedApplication([])).toBeNull();
    expect(pickPlacedApplication(null)).toBeNull();
  });
});

describe('toPracticeContact', () => {
  it('returns null rather than an empty To so callers can fall through', () => {
    expect(toPracticeContact(HAND_CREATED_PLACEMENT)).toBeNull();
    expect(toPracticeContact(null)).toBeNull();
  });

  it('trims the stored values', () => {
    expect(toPracticeContact({ practice_contact_email: ' a@b.com ', practice_contact_name: ' Reception ' }))
      .toEqual({ email: 'a@b.com', name: 'Reception' });
  });

  it('end to end: the hand-created placement resolves to the practice contact', () => {
    const rows = applyPracticeContactFallback([{ ...HAND_CREATED_PLACEMENT }], { 'practice-werribee': WERRIBEE }, {});
    expect(toPracticeContact(pickPlacedApplication(rows)))
      .toEqual({ email: 'chamira@example.com', name: 'Dr Chamira Ranatunga' });
  });
});
