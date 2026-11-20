'use strict';

/**
 * Local test stack only. WP-08 of the Australian GP build: give the three FAKE
 * roles the "who this role is open to" fields, so the role rule
 * (lib/role-eligibility.js) has something real to decide on.
 *
 *   metro, full time   VR required. Mixed billing. Permanent, 6 to 10 sessions.
 *                      Not in a DPA.
 *   metro, part time   Non-VR accepted, registrars accepted. Contract, 2 to 6
 *                      sessions. Not in a DPA.
 *   regional           In a DPA. Accepts doctors who need supervision.
 *                      VR preferred. Permanent, 8 to 10 sessions.
 *
 * Runs after seed.js (which creates the roles). Safe to run again. Needs the
 * WP-08 migration (apply-migrations.sh runs before the seed).
 */

const ROLE_FIELDS = {
  'metro-ft': {
    vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false,
    engagement_type: 'permanent', sessions_min: 6, sessions_max: 10,
    special_interests: ['Skin cancer medicine', 'Chronic disease management'], dpa_status: 'no'
  },
  'metro-pt': {
    vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: false,
    engagement_type: 'contract', sessions_min: 2, sessions_max: 6,
    special_interests: ["Women's health"], dpa_status: 'no'
  },
  'regional-ft': {
    vr_requirement: 'vr_preferred', accepts_registrars: false, accepts_supervised: true,
    engagement_type: 'permanent', sessions_min: 8, sessions_max: 10,
    special_interests: ['Emergency medicine', 'Aboriginal health'], dpa_status: 'yes'
  }
};

module.exports = async function seedWp08RoleFields(ctx) {
  for (const key of Object.keys(ROLE_FIELDS)) {
    const providerRoleId = 'ats_aulocal_' + key.replace(/[^a-z0-9]/gi, '');
    await ctx.upsertRow('career_roles', Object.assign({
      provider: 'internal_ats', provider_role_id: providerRoleId
    }, ROLE_FIELDS[key]), ['provider', 'provider_role_id']);
    const f = ROLE_FIELDS[key];
    ctx.say('    role fields: ' + key + '  [' + f.vr_requirement + ', DPA ' + f.dpa_status
      + (f.accepts_registrars ? ', registrars' : '') + (f.accepts_supervised ? ', supervised' : '') + ']');
  }
};

module.exports.ROLE_FIELDS = ROLE_FIELDS;
