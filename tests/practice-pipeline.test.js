import { describe, it, expect } from 'vitest';
import {
  generateIntakeToken,
  normalizeFacebookLeadPayload,
  validatePracticeIntakePayload,
  buildMaskedTitle,
  buildMaskedDisplayLabel,
  canRevealPracticeIdentityCore,
  gpQualifiesForRole,
  rankRolesForGp,
  buildRedactedRoleStub,
  buildIntakeEmailCopy,
  buildCongratsEmailCopy,
  INTAKE_FIELDS,
} from '../lib/practice-pipeline.js';

function validPayload(overrides) {
  return Object.assign(
    {
      billing_style: 'mixed',
      dpa: 'true',
      percentage_split: '70%',
      suburb: 'Fitzroy',
      nearest_city: 'Melbourne',
      state: 'VIC',
      address: '1 Smith St, Fitzroy VIC 3065',
    },
    overrides
  );
}

describe('generateIntakeToken', () => {
  it('returns a 32-char base64url string', () => {
    const token = generateIntakeToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBe(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('produces unique values across calls', () => {
    const a = generateIntakeToken();
    const b = generateIntakeToken();
    expect(a).not.toBe(b);
  });
});

describe('normalizeFacebookLeadPayload', () => {
  it('maps native FB Lead Ads payload with leadgen_id and field_data', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                leadgen_id: 'fb12345',
                field_data: [
                  { name: 'company_name', values: ['Fitzroy Medical'] },
                  { name: 'full_name', values: ['Jane Smith'] },
                  { name: 'email', values: ['jane@fitzroymed.com.au'] },
                  { name: 'phone_number', values: ['0400000000'] },
                  { name: 'city', values: ['Melbourne'] },
                  { name: 'website', values: ['https://fitzroymed.com.au'] },
                  { name: 'dpa', values: ['yes'] },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = normalizeFacebookLeadPayload(body);
    expect(result).toEqual({
      leadId: 'fb12345',
      practice_name: 'Fitzroy Medical',
      contact_name: 'Jane Smith',
      contact_email: 'jane@fitzroymed.com.au',
      contact_phone: '0400000000',
      location: 'Melbourne',
      website: 'https://fitzroymed.com.au',
      dpa: 'yes',
    });
  });

  it('maps Zapier/Make flat JSON payload', () => {
    const body = {
      lead_id: 'zap-1',
      practice_name: 'Bourke St Clinic',
      location: 'Melbourne',
      contact_name: 'John Doe',
      contact_email: 'john@bourkeclinic.com.au',
      contact_phone: '0411111111',
      website: 'https://bourkeclinic.com.au',
      dpa: true,
    };
    const result = normalizeFacebookLeadPayload(body);
    expect(result).toEqual({
      leadId: 'zap-1',
      practice_name: 'Bourke St Clinic',
      contact_name: 'John Doe',
      contact_email: 'john@bourkeclinic.com.au',
      contact_phone: '0411111111',
      location: 'Melbourne',
      website: 'https://bourkeclinic.com.au',
      dpa: true,
    });
  });

  it('returns null when neither practice_name nor contact_email resolves', () => {
    expect(normalizeFacebookLeadPayload({ foo: 'bar' })).toBeNull();
    expect(normalizeFacebookLeadPayload({})).toBeNull();
  });

  it('falls back to a sha1-derived leadId when no explicit id is present', () => {
    const body = { practice_name: 'No Id Clinic', contact_email: 'x@y.com' };
    const result = normalizeFacebookLeadPayload(body);
    expect(result.leadId).toMatch(/^sha1:[a-f0-9]{40}$/);
  });
});

describe('validatePracticeIntakePayload', () => {
  it('accepts a valid happy-path payload', () => {
    const result = validatePracticeIntakePayload(validPayload());
    expect(result.ok).toBe(true);
    expect(result.value.billing_style).toBe('mixed');
    expect(result.value.dpa).toBe(true);
    expect(result.value.suburb).toBe('Fitzroy');
  });

  it('rejects when suburb is missing', () => {
    const result = validatePracticeIntakePayload(validPayload({ suburb: '' }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects an invalid billing_style', () => {
    const result = validatePracticeIntakePayload(validPayload({ billing_style: 'free' }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('coerces boolean-like strings for boolean fields', () => {
    const result = validatePracticeIntakePayload(
      validPayload({ dpa: 'yes', visa_sponsorship: 'true', nursing_on_site: 'false' })
    );
    expect(result.ok).toBe(true);
    expect(result.value.dpa).toBe(true);
    expect(result.value.visa_sponsorship).toBe(true);
    expect(result.value.nursing_on_site).toBe(false);
  });

  it('trims whitespace on string fields', () => {
    const result = validatePracticeIntakePayload(validPayload({ suburb: '  Fitzroy  ' }));
    expect(result.ok).toBe(true);
    expect(result.value.suburb).toBe('Fitzroy');
  });

  it('exposes INTAKE_FIELDS as an array with key/label/type/required', () => {
    expect(Array.isArray(INTAKE_FIELDS)).toBe(true);
    const bySlug = {};
    INTAKE_FIELDS.forEach((f) => {
      bySlug[f.key] = f;
      expect(typeof f.key).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(typeof f.type).toBe('string');
      expect(typeof f.required).toBe('boolean');
    });
    expect(bySlug.billing_style).toBeTruthy();
    expect(bySlug.billing_style.required).toBe(true);
  });
});

describe('buildMaskedTitle', () => {
  it('builds the exact Melbourne example string', () => {
    const title = buildMaskedTitle({
      nearestCity: 'Melbourne',
      suburb: 'Fitzroy',
      billingStyle: 'mixed',
      dpa: true,
      visaSponsorship: false,
      earningsText: '$8k/wk',
    });
    expect(title).toBe('GP Job near Melbourne | Mixed Billing | DPA Approved | Earnings ~$8k/wk');
  });
});

describe('buildMaskedDisplayLabel', () => {
  it('builds the exact display label', () => {
    const label = buildMaskedDisplayLabel({
      billingStyle: 'mixed',
      dpa: false,
      nearestCity: 'Melbourne',
    });
    expect(label).toBe('Mixed Billing · Non-DPA · near Melbourne');
  });

  it('shows DPA when dpa is true', () => {
    const label = buildMaskedDisplayLabel({ billingStyle: 'bulk', dpa: true, nearestCity: 'Perth' });
    expect(label).toBe('Bulk Billing · DPA · near Perth');
  });

  it('omits missing parts (no billing label, no nearest city) without stray separators', () => {
    const label = buildMaskedDisplayLabel({ billingStyle: '', dpa: false, nearestCity: '' });
    expect(label).toBe('Non-DPA');
  });

  it('never includes a practice name — output is a masked shape assembled only from billing/dpa/city', () => {
    const label = buildMaskedDisplayLabel({ billingStyle: 'private', dpa: true, nearestCity: 'Brisbane' });
    expect(label).not.toMatch(/medical|clinic|centre|practice/i);
  });
});

describe('canRevealPracticeIdentityCore', () => {
  it('is true when application.origin is admin_applied', () => {
    expect(
      canRevealPracticeIdentityCore({ application: { origin: 'admin_applied' }, offer: null })
    ).toBe(true);
  });

  it('is true when application.revealed is true', () => {
    expect(
      canRevealPracticeIdentityCore({ application: { revealed: true }, offer: null })
    ).toBe(true);
  });

  it('is true when the offer status is accepted', () => {
    expect(
      canRevealPracticeIdentityCore({
        application: { origin: 'gp_applied' },
        offer: { status: 'accepted' },
      })
    ).toBe(true);
  });

  it('is false for a plain applied application with no offer', () => {
    expect(
      canRevealPracticeIdentityCore({ application: { origin: 'gp_applied' }, offer: null })
    ).toBe(false);
  });

  it('is false when there is no application at all', () => {
    expect(canRevealPracticeIdentityCore({ application: null, offer: null })).toBe(false);
  });

  it('is false for a gp_applied application with an offer that is only sent (not yet accepted)', () => {
    expect(
      canRevealPracticeIdentityCore({
        application: { origin: 'gp_applied', revealed: false },
        offer: { status: 'sent' },
      })
    ).toBe(false);
  });

  it('is false when revealed/origin columns are missing entirely (undefined, not false) and the offer is only sent', () => {
    // Missing-column tolerance: an application row read before migration
    // 20260705100000 has no `revealed`/`origin` columns at all — both come
    // back undefined, not false. The core rule must still safely return
    // false rather than throwing or coercing undefined into a reveal.
    expect(
      canRevealPracticeIdentityCore({ application: {}, offer: { status: 'sent' } })
    ).toBe(false);
  });
});

describe('gpQualifiesForRole', () => {
  it('always qualifies for a DPA role', () => {
    expect(gpQualifiesForRole({ dpa: true }, { australiaTrained: false })).toEqual({
      qualifies: true,
    });
  });

  it('qualifies a non-DPA role when the GP is Australia-trained', () => {
    expect(gpQualifiesForRole({ dpa: false }, { australiaTrained: true })).toEqual({
      qualifies: true,
    });
  });

  it('rejects a non-DPA role for a non-Australia-trained GP', () => {
    expect(gpQualifiesForRole({ dpa: false }, { australiaTrained: false })).toEqual({
      qualifies: false,
      reason: 'dpa_restricted',
    });
  });
});

describe('rankRolesForGp', () => {
  it('ranks city match first, same-state second, others last', () => {
    const rows = [
      { id: 'sydney', nearest_city: 'Sydney', location_state: 'NSW', created_at: '2026-01-01T00:00:00Z' },
      { id: 'melbourne', nearest_city: 'Melbourne', location_state: 'VIC', created_at: '2026-01-02T00:00:00Z' },
      { id: 'geelong', nearest_city: 'Geelong', location_state: 'VIC', created_at: '2026-01-03T00:00:00Z' },
      { id: 'perth', nearest_city: 'Perth', location_state: 'WA', created_at: '2026-01-04T00:00:00Z' },
    ];
    const ranked = rankRolesForGp(rows, { preferredCity: 'Melbourne' });
    expect(ranked.map((r) => r.id)).toEqual(['melbourne', 'geelong', 'perth', 'sydney']);
  });

  it('sorts by published_at||created_at desc within the same score', () => {
    const rows = [
      { id: 'older', nearest_city: 'Perth', location_state: 'WA', created_at: '2026-01-01T00:00:00Z' },
      { id: 'newer', nearest_city: 'Perth', location_state: 'WA', created_at: '2026-01-05T00:00:00Z' },
    ];
    const ranked = rankRolesForGp(rows, { preferredCity: '' });
    expect(ranked.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      { id: 'a', nearest_city: 'Perth', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', nearest_city: 'Sydney', created_at: '2026-01-02T00:00:00Z' },
    ];
    const copy = rows.slice();
    rankRolesForGp(rows, { preferredCity: 'Sydney' });
    expect(rows).toEqual(copy);
  });

  // Task 11: /api/career/roles ranks the ALREADY client-serialized shape
  // produced by mapCareerRoleRowToClient — `state` (not `location_state`),
  // `nearest_city`, `dpa`, and no `published_at`/`created_at` timestamp at
  // all. Must still rank without crashing and keep stable ordering.
  it('ranks client-role-shaped objects (mapCareerRoleRowToClient output: state, nearest_city, dpa, no timestamp field)', () => {
    const clientRoles = [
      { id: 'internal_ats:sydney', dpa: true, state: 'NSW', nearest_city: 'Sydney' },
      { id: 'internal_ats:melbourne', dpa: false, state: 'VIC', nearest_city: 'Melbourne' },
      { id: 'internal_ats:geelong', dpa: true, state: 'VIC', nearest_city: 'Geelong' },
      { id: 'internal_ats:perth', dpa: true, state: 'WA', nearest_city: 'Perth' },
    ];
    const ranked = rankRolesForGp(clientRoles, { preferredCity: 'Melbourne' });
    // No timestamp field on client roles → ties within a score keep their
    // original (stable) order: sydney (idx 0) then perth (idx 3), both score 2.
    expect(ranked.map((r) => r.id)).toEqual([
      'internal_ats:melbourne',
      'internal_ats:geelong',
      'internal_ats:sydney',
      'internal_ats:perth',
    ]);
  });
});

describe('buildRedactedRoleStub', () => {
  it('leaks no practiceName/suburb/address fields', () => {
    const role = {
      id: 'role-1',
      practiceName: 'Fitzroy Medical',
      suburb: 'Fitzroy',
      address: '1 Smith St, Fitzroy VIC 3065',
      state: 'VIC',
      qualifyReason: 'dpa_restricted',
    };
    const stub = buildRedactedRoleStub(role);
    expect(stub).toEqual({
      id: 'role-1',
      title: 'GP Opportunity',
      practiceName: 'Confidential practice',
      location: 'VIC',
      billing: '',
      summary: "You don't currently qualify for this role.",
      qualifies: false,
      blurred: true,
      qualifyReason: 'dpa_restricted',
    });
    expect(JSON.stringify(stub)).not.toContain('Fitzroy');
    expect(JSON.stringify(stub)).not.toContain('Smith St');
  });

  it('falls back to Australia when no state is present', () => {
    const stub = buildRedactedRoleStub({ id: 'role-2' });
    expect(stub.location).toBe('Australia');
    expect(stub.qualifyReason).toBe('dpa_restricted');
  });

  // Task 11: gated client roles carry dpa/nearest_city/practiceName straight
  // from mapCareerRoleRowToClient — confirm none of that survives into the stub.
  it('leaks no dpa/nearest_city/headerImageUrl/displayLabel fields from a gated client role', () => {
    const gatedClientRole = {
      id: 'internal_ats:secret1',
      practiceName: 'ULTRA SECRET Toowoomba Family Medical Centre',
      headerImageUrl: 'https://example.com/secret-practice-photo.jpg',
      displayLabel: 'Mixed Billing · Non-DPA · near Toowoomba',
      dpa: false,
      state: 'QLD',
      nearest_city: 'Toowoomba',
      qualifies: false,
      reason: 'dpa_restricted',
    };
    const stub = buildRedactedRoleStub(gatedClientRole);
    expect(stub).toEqual({
      id: 'internal_ats:secret1',
      title: 'GP Opportunity',
      practiceName: 'Confidential practice',
      location: 'QLD',
      billing: '',
      summary: "You don't currently qualify for this role.",
      qualifies: false,
      blurred: true,
      qualifyReason: 'dpa_restricted',
    });
    const serialized = JSON.stringify(stub);
    expect(serialized).not.toContain('Toowoomba');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('secret-practice-photo');
    expect(stub.dpa).toBeUndefined();
    expect(stub.nearest_city).toBeUndefined();
    expect(stub.headerImageUrl).toBeUndefined();
    expect(stub.displayLabel).toBeUndefined();
  });
});

describe('buildIntakeEmailCopy', () => {
  it('includes the required subject, promise, difference, CTA, and footer', () => {
    const copy = buildIntakeEmailCopy({
      practiceName: 'Fitzroy Medical',
      intakeUrl: 'https://app.mygplink.com.au/intake/abc123',
    });
    expect(copy.subject).toBe('Your GP is waiting — complete your job details');
    expect(copy.body).toMatch(/30 days/);
    expect(copy.body.toLowerCase()).toMatch(/gp link/);
    expect(copy.ctaText).toBe('Complete your job details');
    expect(copy.ctaUrl).toBe('https://app.mygplink.com.au/intake/abc123');
    expect(copy.footer).toBe('You are receiving this because you enquired about GP recruitment with GP Link.');
  });
});

describe('buildCongratsEmailCopy', () => {
  it('includes the required subject, practice name, and CTA', () => {
    const copy = buildCongratsEmailCopy({
      gpName: 'Dr Jane Smith',
      practiceName: 'Fitzroy Medical',
      secureUrl: 'https://app.mygplink.com.au/secure/xyz789',
    });
    expect(copy.subject).toBe('Congratulations — a practice wants to meet you 🎉');
    expect(copy.body).toMatch(/Fitzroy Medical/);
    expect(copy.ctaText).toBe('Secure My Interview');
    expect(copy.ctaUrl).toBe('https://app.mygplink.com.au/secure/xyz789');
  });
});
