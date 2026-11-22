'use strict';

/**
 * WP-22 (job board filters, job page, apply carry-through): career_roles rows
 * for the public job board tests. Every practice is obviously fake.
 *
 * The rows cover: every billing model, a role with every WP-08 field filled
 * in, roles with none of them (a row as production has it today, before the
 * migration), DPA yes / no / unknown / not recorded, metro and regional, an
 * internal-ATS row with an admin-written title, a legacy (Zoho) row, stored
 * copy that carries figures and a benefit written for a doctor moving
 * country, and one closed role that must never be public.
 */

const NOW = '2026-11-20T01:00:00.000Z';

function role(n, over) {
  const o = over || {};
  return Object.assign({
    id: '00000000-0000-4000-8000-0000000022' + String(n).padStart(2, '0'),
    provider: 'internal_ats',
    provider_role_id: 'wp22-role-' + n,
    title: 'Role ' + n,
    masked_title: null,
    practice_name: 'Test Practice ' + n + ' (FAKE)',
    practice_id: null,
    address: n + ' Fake Street',
    location_label: '',
    location_city: 'Parramatta',
    location_state: 'NSW',
    location_country: 'Australia',
    suburb: 'Parramatta',
    nearest_city: 'Sydney',
    billing_model: 'Mixed Billing',
    private_billing: false,
    mixed_billing: true,
    dpa: false,
    mmm: '1',
    metro: true,
    regional: false,
    earnings_text: '',
    summary: 'A friendly, well-supported general practice with a full nursing team.',
    employment_type: 'Full-time',
    tags: [],
    published_at: NOW,
    updated_at: NOW,
    header_image_url: '',
    visa_pathway_aligned: false,
    is_active: true,
    job_status: 'open',
    approval_status: 'approved',
    source_payload: {}
  }, o);
}

const ROWS = [
  // 1. The role the third walk met: an internal masked title, a percentage in
  //    the earnings, figures in the package, a benefit for a doctor moving
  //    country. Metro, not a DPA, VR required, sessions stated.
  role(1, {
    masked_title: 'Non-DPA - Parramatta - Mixed Billing',
    title: 'Non-DPA - Parramatta - Mixed Billing',
    earnings_text: '70% to GP',
    dpa: false, dpa_status: 'no',
    vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false,
    engagement_type: 'permanent', sessions_min: 6, sessions_max: 9,
    special_interests: ['Skin cancer medicine', "Women's health"],
    tags: ['Mixed Billing', 'Visa pathway'],
    visa_pathway_aligned: true,
    source_payload: {
      gpLink: {
        websiteUrl: '',
        publicIntro: 'A busy mixed-billing practice in western Sydney. Ideal for overseas GPs relocating to Australia. The team is long standing and the books are full.',
        publicBenefits: ['Visa and PR pathway support', 'Full nursing support', '70% of billings', 'Modern rooms'],
        packageTerms: {
          billingSplit: 'GP 70% / Practice 30%',
          incomeGuarantee: '$2,000 per day for the first 3 months',
          agreementBonus: '$10,000 sign-on bonus\nRelocation support up to $5,000',
          visaSponsorship: true,
          supervision: 'Available'
        },
        aiWriteup: {
          about: 'A well established mixed-billing clinic. GPs here keep 70% of billings. We support overseas doctors with their visa. Parking is on site.',
          highlights: ['Full nursing team', 'Visa sponsorship available', 'Earn $400k+', 'Long-standing patients'],
          perks: [
            { label: 'Income guarantee', value: '$2,000 a day for 3 months' },
            { label: 'Relocation package', value: 'Flights and 4 weeks accommodation' },
            { label: 'Nursing', value: 'Full-time practice nurses' },
            { label: 'Parking', value: 'On site' }
          ]
        }
      }
    }
  }),
  // 2. Regional, DPA, bulk billing, open to GPs without VR, registrars and
  //    supervised doctors. Masked title.
  role(2, {
    masked_title: 'DPA - Dubbo - Bulk Billing', title: 'DPA - Dubbo - Bulk Billing',
    location_city: 'Dubbo', suburb: 'Dubbo', nearest_city: '', location_state: 'New South Wales',
    billing_model: 'bulk', mixed_billing: false,
    dpa: true, dpa_status: 'yes', mmm: '3', metro: false, regional: true,
    vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: true,
    engagement_type: 'contract', sessions_min: 4, sessions_max: 4,
    earnings_text: '$350k - $450k'
  }),
  // 3. A row exactly as production has it today: none of the WP-08 columns.
  //    DPA boolean true, private billing, Victoria (long spelling).
  role(3, {
    masked_title: 'DPA - Ballarat - Private Billing', title: 'DPA - Ballarat - Private Billing',
    location_city: 'Ballarat', suburb: 'Ballarat', nearest_city: 'Melbourne', location_state: 'VICTORIA',
    billing_model: 'Private-Billing', private_billing: true, mixed_billing: false,
    dpa: true, mmm: '2', metro: false, regional: true
  }),
  // 4. Not stated: no DPA status, the boolean false (which today means only
  //    "nobody said yes"), no MMM, no billing model, no sessions.
  role(4, {
    title: 'General Practitioner', masked_title: null,
    location_city: 'Fremantle', suburb: 'Fremantle', nearest_city: 'Perth', location_state: 'WA',
    billing_model: '', mixed_billing: false, dpa: false, mmm: '', metro: false, regional: false
  }),
  // 5. DPA status recorded as unknown (the practice did not say).
  role(5, {
    masked_title: 'Non-DPA - Geelong - Mixed Billing', title: 'Non-DPA - Geelong - Mixed Billing',
    location_city: 'Geelong', suburb: 'Geelong', nearest_city: 'Melbourne', location_state: 'VIC',
    dpa: false, dpa_status: 'unknown', mmm: '1', metro: true,
    vr_requirement: 'vr_preferred', sessions_min: 8, sessions_max: 10
  }),
  // 6. An admin-written title on an internal role (kept as written), metro
  //    Queensland, mixed billing, VR required by default (not stated).
  role(6, {
    title: 'Family GP with a skin interest', masked_title: null,
    location_city: 'Brisbane', suburb: 'Paddington', nearest_city: 'Brisbane', location_state: 'QLD',
    dpa: false, dpa_status: 'no', mmm: '1', metro: true,
    special_interests: ['Skin cancer medicine']
  }),
  // 7. A legacy (Zoho) row: the raw title is the practice's name and must
  //    never be shown; the masked fallback is used.
  role(7, {
    provider: 'zoho_recruit', provider_role_id: 'zr-wp22-7',
    title: 'Test Practice 7 (FAKE)', masked_title: null,
    location_city: 'Hobart', suburb: 'Hobart', nearest_city: 'Hobart', location_state: 'TAS',
    billing_model: 'Mixed-Billing', dpa: true, mmm: '2', metro: false, regional: true,
    summary: 'Raw summary naming Test Practice 7 (FAKE).'
  }),
  // 8. Closed: never public.
  role(8, { job_status: 'filled', masked_title: 'Non-DPA - Newcastle - Mixed Billing', suburb: 'Newcastle', location_city: 'Newcastle' })
];

/** The rows the public board is given (open and approved only). */
function publicRows() {
  return ROWS.filter(function (r) { return r.job_status === 'open'; }).map(function (r) { return JSON.parse(JSON.stringify(r)); });
}
function allRows() { return ROWS.map(function (r) { return JSON.parse(JSON.stringify(r)); }); }
function publicId(n) { const r = ROWS[n - 1]; return r.provider + ':' + r.provider_role_id; }

// Query strings the parity snapshot asks. The last group are the WP-22
// filters: with the switch off they must be ignored exactly as any unknown
// parameter is today.
const PARITY_QUERIES = [
  '', 'q=parramatta', 'q=dpa', 'state=NSW', 'state=VIC', 'billing=bulk', 'billing=mixed', 'billing=private',
  'state=NSW&billing=mixed', 'limit=2', 'limit=2&offset=2', 'type=vr-gp',
  'id=' + encodeURIComponent('internal_ats:wp22-role-1'), 'id=' + encodeURIComponent('zoho_recruit:zr-wp22-7'), 'id=nope',
  'vr=non_vr', 'vr=vr', 'dpa=yes', 'dpa=no', 'dpa=unknown', 'area=metro', 'area=regional', 'mmm=3', 'sessions=part',
  'vr=non_vr&dpa=yes&area=regional'
];

module.exports = { ROWS, publicRows, allRows, publicId, PARITY_QUERIES, NOW };
