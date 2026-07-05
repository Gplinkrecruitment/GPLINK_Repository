// Task 4 — pure backfill mappers (client -> practice row, job -> career_role patch).
// No I/O: everything here is plain object transforms, mirrors tests/zoho-archive-lib.test.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  mapZohoClientToPracticeRow,
  buildCareerRoleBackfillPatch,
  CORPORATION_ZOHO_IDS,
} = require('../lib/zoho-backfill.js');

describe('mapZohoClientToPracticeRow', () => {
  it('seeds org_type=corporation for known corporation zoho ids', () => {
    const row = mapZohoClientToPracticeRow({ Client_Name: 'ForHealth Clinic' }, '11734000000817081');
    expect(row.org_type).toBe('corporation');
    const row2 = mapZohoClientToPracticeRow({ Client_Name: 'GP West Clinic' }, '11734000000772001');
    expect(row2.org_type).toBe('corporation');
  });

  it('seeds org_type=practice for an unknown/non-corporation zoho id', () => {
    const row = mapZohoClientToPracticeRow({ Client_Name: 'Non-Corporation Clinic' }, '99999999999');
    expect(row.org_type).toBe('practice');
  });

  it('exposes the corporation ids as data (CORPORATION_ZOHO_IDS)', () => {
    expect(CORPORATION_ZOHO_IDS).toContain('11734000000817081');
    expect(CORPORATION_ZOHO_IDS).toContain('11734000000772001');
  });

  it('extracts name/contact fields and sets fixed source/is_active', () => {
    const row = mapZohoClientToPracticeRow({
      Client_Name: 'Riverside Medical',
      Client_Email: 'admin@riverside.example',
      Client_Phone_Number: '0399999999',
      Billing_City: 'Bendigo',
      Billing_State: 'VIC',
    }, '123');
    expect(row).toEqual({
      zoho_client_id: '123',
      name: 'Riverside Medical',
      org_type: row.org_type,
      contact_name: '',
      contact_email: 'admin@riverside.example',
      contact_phone: '0399999999',
      location_city: 'Bendigo',
      location_state: 'VIC',
      source: 'backfill',
      is_active: true,
    });
  });

  it('falls back to Contact_Number when Client_Phone_Number is absent', () => {
    const row = mapZohoClientToPracticeRow({
      Client_Name: 'Fallback Clinic',
      Contact_Number: '0400111222',
    }, '456');
    expect(row.contact_phone).toBe('0400111222');
  });

  it('prefers Client_Phone_Number over Contact_Number when both present', () => {
    const row = mapZohoClientToPracticeRow({
      Client_Name: 'Both Numbers Clinic',
      Client_Phone_Number: '0311111111',
      Contact_Number: '0322222222',
    }, '789');
    expect(row.contact_phone).toBe('0311111111');
  });

  it('trims strings and defaults missing fields to empty string', () => {
    const row = mapZohoClientToPracticeRow({
      Client_Name: '  Spacey Clinic  ',
    }, '1');
    expect(row).toEqual({
      zoho_client_id: '1',
      name: 'Spacey Clinic',
      org_type: row.org_type,
      contact_name: '',
      contact_email: '',
      contact_phone: '',
      location_city: '',
      location_state: '',
      source: 'backfill',
      is_active: true,
    });
  });

  it('handles an entirely empty client payload without throwing', () => {
    const row = mapZohoClientToPracticeRow({}, '2');
    expect(row.name).toBe('');
    expect(row.contact_email).toBe('');
    expect(row.zoho_client_id).toBe('2');
  });
});

describe('buildCareerRoleBackfillPatch', () => {
  function zohoRole(zoho, roleRow = {}) {
    return { source_payload: { zoho }, ...roleRow };
  }

  it('returns null when roleRow.source_payload.zoho is missing (non-Zoho rows)', () => {
    expect(buildCareerRoleBackfillPatch({}, {})).toBeNull();
    expect(buildCareerRoleBackfillPatch({ source_payload: {} }, {})).toBeNull();
    expect(buildCareerRoleBackfillPatch({ source_payload: { zoho: null } }, {})).toBeNull();
    expect(buildCareerRoleBackfillPatch({ source_payload: { zoho: 'not-an-object' } }, {})).toBeNull();
  });

  it('computes dpa=true only when DPA is "Yes" (case-insensitive)', () => {
    const yes = buildCareerRoleBackfillPatch(zohoRole({ DPA: 'Yes' }), {});
    expect(yes.dpa).toBe(true);
    const yesLower = buildCareerRoleBackfillPatch(zohoRole({ DPA: 'yes' }), {});
    expect(yesLower.dpa).toBe(true);
  });

  it('computes dpa=false for "No" and for absent DPA', () => {
    const no = buildCareerRoleBackfillPatch(zohoRole({ DPA: 'No' }), {});
    expect(no.dpa).toBe(false);
    const absent = buildCareerRoleBackfillPatch(zohoRole({}), {});
    expect(absent.dpa).toBe(false);
  });

  it('billing_model: existing roleRow value wins over Zoho Billing_Type', () => {
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ Billing_Type: 'Bulk Billing' }, { billing_model: 'mixed' }),
      {}
    );
    expect(patch.billing_model).toBe('mixed');
  });

  it('billing_model: falls back to Zoho Billing_Type when roleRow has none', () => {
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ Billing_Type: 'Private Billing' }, { billing_model: '' }),
      {}
    );
    expect(patch.billing_model).toBe('Private Billing');
  });

  it('builds address by joining Location and Zip_Code, skipping empties', () => {
    const both = buildCareerRoleBackfillPatch(zohoRole({ Location: '123 Main St', Zip_Code: '3000' }), {});
    expect(both.address).toBe('123 Main St, 3000');
    const onlyLocation = buildCareerRoleBackfillPatch(zohoRole({ Location: '123 Main St' }), {});
    expect(onlyLocation.address).toBe('123 Main St');
    const onlyZip = buildCareerRoleBackfillPatch(zohoRole({ Zip_Code: '3000' }), {});
    expect(onlyZip.address).toBe('3000');
    const neither = buildCareerRoleBackfillPatch(zohoRole({}), {});
    expect(neither.address).toBe('');
  });

  it('sets suburb from City', () => {
    const patch = buildCareerRoleBackfillPatch(zohoRole({ City: 'Ballarat' }), {});
    expect(patch.suburb).toBe('Ballarat');
  });

  it('assembles details, dropping empty/null values and empty benefits', () => {
    const patch = buildCareerRoleBackfillPatch(zohoRole({
      Benefit_1: 'Relocation assistance',
      Benefit_2: '',
      Benefit_3: null,
      Current_Amount_of_General_Practiti: '4',
      Number_of_Positions: '2',
      Practice_Website: 'https://example.com',
      Short_Intro: 'Great practice',
      Allied_Health: 'Yes',
      Pathology_on_Site: 'No',
      Years_of_Operation: '10',
      Visa_Sponsorship_Available: 'Yes',
      Average_Standard_Consult: '15 mins',
    }), {});
    expect(patch.details).toEqual({
      benefits: ['Relocation assistance'],
      gpCount: '4',
      positions: '2',
      website: 'https://example.com',
      shortIntro: 'Great practice',
      alliedHealth: 'Yes',
      pathology: 'No',
      yearsOperating: '10',
      visaSponsorship: 'Yes',
      avgConsult: '15 mins',
    });
  });

  it('drops empty/null detail keys entirely rather than including them empty', () => {
    const patch = buildCareerRoleBackfillPatch(zohoRole({}), {});
    expect(patch.details).toEqual({ benefits: [] });
    expect(patch.details).not.toHaveProperty('gpCount');
    expect(patch.details).not.toHaveProperty('website');
  });

  it('omits practice_id when the zoho client id is not in the lookup', () => {
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ Client_Name: { id: 'unknown-id', name: 'Unknown Clinic' } }),
      {}
    );
    expect(patch).not.toHaveProperty('practice_id');
  });

  it('includes practice_id when the zoho client id resolves via practiceIdByZohoClientId', () => {
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ Client_Name: { id: 'client-42', name: 'Known Clinic' } }),
      { 'client-42': 'practice-uuid-1' }
    );
    expect(patch.practice_id).toBe('practice-uuid-1');
  });

  it('builds masked_title using the COMPUTED dpa, not roleRow.dpa', () => {
    // roleRow.dpa says false, but Zoho DPA says Yes -> computed dpa (true) must win.
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ DPA: 'Yes', City: 'Geelong', Billing_Type: 'Bulk Billing' }, {
        dpa: false,
        nearest_city: 'Melbourne',
        location_state: 'VIC',
      }),
      {}
    );
    expect(patch.dpa).toBe(true);
    expect(patch.masked_title).toBe('DPA - Geelong (Melbourne) - Bulk Billing');
  });

  it('masked_title reflects Non-DPA when computed dpa is false', () => {
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ DPA: 'No', City: 'Geelong', Billing_Type: 'Mixed Billing' }, {
        nearest_city: 'Melbourne',
        location_state: 'VIC',
      }),
      {}
    );
    expect(patch.masked_title).toBe('Non-DPA - Geelong (Melbourne) - Mixed Billing');
  });

  it('masked_title prefers existing roleRow.billing_model over Zoho Billing_Type', () => {
    const patch = buildCareerRoleBackfillPatch(
      zohoRole({ DPA: 'Yes', City: 'Geelong', Billing_Type: 'Bulk Billing' }, {
        billing_model: 'private',
        nearest_city: 'Melbourne',
        location_state: 'VIC',
      }),
      {}
    );
    expect(patch.billing_model).toBe('private');
    expect(patch.masked_title).toBe('DPA - Geelong (Melbourne) - Private Billing');
  });
});
