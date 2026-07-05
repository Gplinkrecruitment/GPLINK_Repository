// lib/zoho-backfill.js — pure helpers for the Zoho decommission backfill (no I/O).
// Mirrors lib/zoho-archive.js: plain object transforms only, no fetch/db calls here.

const { buildMaskedTitle } = require('./practice-pipeline.js');

// Zoho client (Client_Name) ids that are corporation groups, not independent
// practices. This is DATA, not a magic constant — see the live Zoho archive.
const CORPORATION_ZOHO_IDS = ['11734000000817081', '11734000000772001'];

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

// Build a practices row from a raw Zoho Client payload.
function mapZohoClientToPracticeRow(clientPayload, zohoId) {
  const c = clientPayload || {};
  const id = str(zohoId);
  const phone = str(c.Client_Phone_Number) || str(c.Contact_Number);
  return {
    zoho_client_id: id,
    name: str(c.Client_Name),
    org_type: CORPORATION_ZOHO_IDS.includes(id) ? 'corporation' : 'independent',
    // No Zoho field maps to a contact person's name in the live payload
    // (Client_Name is the practice/org name) — always '' per the contract.
    contact_name: '',
    contact_email: str(c.Client_Email),
    contact_phone: phone,
    location_city: str(c.Billing_City),
    location_state: str(c.Billing_State),
    source: 'zoho_import',
    is_active: true,
  };
}

// Build the { benefits, gpCount, ... } details object, dropping empty/null
// values (benefits is the one array field: only non-empty strings survive).
function buildRoleDetails(z) {
  const benefits = [z.Benefit_1, z.Benefit_2, z.Benefit_3]
    .map((b) => str(b))
    .filter((b) => b !== '');

  const details = { benefits };
  const scalarFields = {
    gpCount: z.Current_Amount_of_General_Practiti,
    positions: z.Number_of_Positions,
    website: z.Practice_Website,
    shortIntro: z.Short_Intro,
    alliedHealth: z.Allied_Health,
    pathology: z.Pathology_on_Site,
    yearsOperating: z.Years_of_Operation,
    visaSponsorship: z.Visa_Sponsorship_Available,
    avgConsult: z.Average_Standard_Consult,
  };
  for (const key of Object.keys(scalarFields)) {
    const v = scalarFields[key];
    if (v != null && String(v).trim() !== '') {
      details[key] = v;
    }
  }
  return details;
}

// Build a career_role backfill patch from roleRow.source_payload.zoho.
// Returns null when the row isn't a Zoho-sourced row (never patch those).
function buildCareerRoleBackfillPatch(roleRow, practiceIdByZohoClientId) {
  const row = roleRow || {};
  const z = row.source_payload && row.source_payload.zoho;
  if (!z || typeof z !== 'object') return null;

  const lookup = practiceIdByZohoClientId || {};
  const dpa = str(z.DPA).toLowerCase() === 'yes';
  const suburb = str(z.City);
  const address = [str(z.Location), str(z.Zip_Code)].filter((p) => p !== '').join(', ');
  const billingModel = str(row.billing_model) || str(z.Billing_Type);

  const patch = {
    dpa,
    suburb,
    address,
    billing_model: billingModel,
    details: buildRoleDetails(z),
    masked_title: buildMaskedTitle({
      suburb,
      nearestCity: row.nearest_city,
      billingStyle: billingModel,
      dpa,
      state: row.location_state,
    }),
  };

  const clientId = z.Client_Name && typeof z.Client_Name === 'object' ? z.Client_Name.id : undefined;
  const practiceId = clientId != null ? lookup[clientId] : undefined;
  if (practiceId) {
    patch.practice_id = practiceId;
  }

  return patch;
}

module.exports = {
  CORPORATION_ZOHO_IDS,
  mapZohoClientToPracticeRow,
  buildCareerRoleBackfillPatch,
};
