import { describe, it, expect } from 'vitest';
import {
  normalizeWebsitePracticeLead,
  buildPracticeProspectRow,
  normalizeFacebookLeadPayload,
} from '../lib/practice-pipeline.js';

function validWebsiteLead(overrides) {
  return Object.assign(
    {
      gps_needed: '2',
      urgency: 'asap',
      employment_type: 'full_time',
      practice_name: 'Bayside Family Practice',
      suburb: 'Erina',
      state: 'NSW',
      postcode: '2250',
      contact_name: 'Dana Whitfield',
      contact_role: 'practice_manager',
      contact_email: 'dana@baysidefp.com.au',
      contact_phone: '0412 345 678',
      website: 'https://baysidefp.com.au',
      dpa: true,
      latitude: -33.43,
      longitude: 151.39,
    },
    overrides || {}
  );
}

describe('normalizeWebsitePracticeLead', () => {
  it('accepts a complete website submission', () => {
    const lead = normalizeWebsitePracticeLead(validWebsiteLead());
    expect(lead).toBeTruthy();
    expect(lead.practice_name).toBe('Bayside Family Practice');
    expect(lead.contact_email).toBe('dana@baysidefp.com.au');
    expect(lead.urgency).toBe('asap');
    expect(lead.employment_type).toBe('full_time');
    expect(lead.suburb).toBe('Erina');
    expect(lead.postcode).toBe('2250');
    expect(lead.dpa).toBe(true);
  });

  it('requires BOTH a practice name and a contact email', () => {
    // The Facebook normalizer accepts either one, because Meta controls the
    // form. A public web form must demand both — a lead we cannot email is
    // worthless, and a lead with no practice name cannot be deduplicated.
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ practice_name: '' }))).toBeNull();
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ contact_email: '' }))).toBeNull();
  });

  it('rejects an email that is not a plausible address', () => {
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ contact_email: 'not-an-email' }))).toBeNull();
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ contact_email: 'a@b' }))).toBeNull();
  });

  it('lowercases and trims the contact email so dedupe cannot be defeated by case', () => {
    const lead = normalizeWebsitePracticeLead(validWebsiteLead({ contact_email: '  Dana@BaysideFP.com.AU ' }));
    expect(lead.contact_email).toBe('dana@baysidefp.com.au');
  });

  it('drops vocabulary values it does not recognise instead of passing them through', () => {
    const lead = normalizeWebsitePracticeLead(validWebsiteLead({ urgency: 'whenever', employment_type: 'casual' }));
    expect(lead).toBeTruthy();
    expect(lead.urgency).toBeUndefined();
    expect(lead.employment_type).toBeUndefined();
  });

  it('keeps dpa as a real tri-state — true, false or unknown, never coerced', () => {
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ dpa: false })).dpa).toBe(false);
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ dpa: null })).dpa).toBeUndefined();
    expect(normalizeWebsitePracticeLead(validWebsiteLead({ dpa: 'yes' })).dpa).toBeUndefined();
  });

  it('ignores coordinates that are not inside Australia', () => {
    const lead = normalizeWebsitePracticeLead(validWebsiteLead({ latitude: 51.5, longitude: -0.12 }));
    expect(lead.latitude).toBeUndefined();
    expect(lead.longitude).toBeUndefined();
  });
});

describe('buildPracticeProspectRow — shared by both front doors', () => {
  it('builds the Facebook row exactly as the webhook always has', () => {
    const lead = normalizeFacebookLeadPayload({
      lead_id: 'L1',
      practice_name: 'Coastal Medical',
      contact_name: 'Sam Reed',
      contact_email: 'sam@coastal.example',
      contact_phone: '0400 000 000',
      location: 'Gosford',
      website: 'https://coastal.example',
    });
    const row = buildPracticeProspectRow(lead, {
      source: 'facebook_lead',
      createdBy: 'facebook_lead_webhook',
      intakeToken: 'TOKEN123',
      metadata: { fb_lead: lead, fb_raw: { lead_id: 'L1' } },
    });

    expect(row.name).toBe('Coastal Medical');
    expect(row.location_city).toBe('Gosford');
    expect(row.location_country).toBe('Australia');
    expect(row.source).toBe('facebook_lead');
    expect(row.created_by).toBe('facebook_lead_webhook');
    expect(row.stage).toBe('prospective');
    expect(row.agreement_status).toBe('unsigned');
    expect(row.is_active).toBe(true);
    expect(row.intake_token).toBe('TOKEN123');
    expect(row.dpa).toBeNull();
    expect(row.metadata.fb_lead).toEqual(lead);
  });

  it('falls back to a readable practice name when the lead had none', () => {
    const row = buildPracticeProspectRow(
      { contact_name: 'Sam Reed', contact_email: 'sam@coastal.example' },
      { source: 'facebook_lead', intakeToken: 'T' }
    );
    expect(row.name).toBe("Sam Reed's practice");

    const anon = buildPracticeProspectRow({ contact_email: 'sam@coastal.example' }, { source: 'facebook_lead', intakeToken: 'T' });
    expect(anon.name).toBe('New practice lead');
  });

  it('writes the website flow answers into real columns so the intake form is pre-filled', () => {
    const lead = normalizeWebsitePracticeLead(validWebsiteLead());
    const row = buildPracticeProspectRow(lead, {
      source: 'website_lead',
      createdBy: 'site_practice_lead',
      intakeToken: 'TOKEN456',
    });

    expect(row.source).toBe('website_lead');
    expect(row.stage).toBe('prospective');
    expect(row.urgency).toBe('asap');
    expect(row.employment_type).toBe('full_time');
    expect(row.gps_needed).toBe('2');
    expect(row.suburb).toBe('Erina');
    expect(row.postcode).toBe('2250');
    expect(row.location_state).toBe('NSW');
    expect(row.dpa).toBe(true);
    expect(row.latitude).toBeCloseTo(-33.43);
  });

  it('never writes an unrecognised vocabulary value into a constrained column', () => {
    // A bad enum reaching the column could fail the INSERT and lose the lead
    // entirely. Unknown values are dropped by the normalizer and must never
    // be resurrected here.
    const row = buildPracticeProspectRow(
      { practice_name: 'X', contact_email: 'x@y.com', urgency: 'whenever', employment_type: 'casual' },
      { source: 'website_lead', intakeToken: 'T' }
    );
    expect(row.urgency).toBeUndefined();
    expect(row.employment_type).toBeUndefined();
  });

  it('omits empty optional columns rather than writing blanks', () => {
    const row = buildPracticeProspectRow(
      { practice_name: 'X', contact_email: 'x@y.com' },
      { source: 'website_lead', intakeToken: 'T' }
    );
    expect(row).not.toHaveProperty('suburb');
    expect(row).not.toHaveProperty('postcode');
    expect(row).not.toHaveProperty('latitude');
  });
});
