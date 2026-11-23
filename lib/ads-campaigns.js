'use strict';

/**
 * WP-24 (Australian GP build, WEB-14): the ads hub's campaigns, as a LIST.
 * Pure, no I/O. Read docs/au-gp/CONVENTIONS.md section 39 before changing it.
 *
 * Until now the hub held one campaign, wired into lib/meta-ads.js
 * (`adsConfig`). That campaign is still the first entry here and is built from
 * the very same `adsConfig`, so with one campaign configured nothing about the
 * hub changes: same reads, same prompts, same proposals, same actions
 * (tests/au-wp24-single-campaign-parity-*.test.js hold the snapshot).
 *
 * The Australian campaign is listed only with the Australian switch on. Until
 * the owner creates it in Ads Manager and sets META_ADS_AU_CAMPAIGN_ID it is
 * `configured: false`: the hub shows it as "not set up yet" with the app's own
 * lead numbers, reads nothing from Meta for it, and can never propose or make
 * a change for it.
 *
 * A campaign with no audience recorded is an overseas (UK) campaign: the same
 * rule as a doctor with no pathway recorded.
 */

const metaAds = require('./meta-ads.js');
const adsActions = require('./ads-actions.js');

const UK_KEY = 'overseas_uk';
const AU_KEY = 'au_gp';

function digits(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s : '';
}
function idList(v) {
  return String(v == null ? '' : v).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}
function tagList(v) {
  return idList(v).map(function (x) { return x.toLowerCase().replace(/[^a-z0-9 _.|:+~-]/g, '').slice(0, 80); }).filter(Boolean);
}
function siteOrigin(env) {
  return (String(env.PUBLIC_SITE_ORIGIN || '').trim() || 'https://www.mygplink.com.au').replace(/\/+$/, '');
}

/** Today's campaign, exactly as lib/meta-ads.js configures it. */
function overseasCampaign(env) {
  const cfg = metaAds.adsConfig(env);
  return {
    key: UK_KEY,
    label: 'Overseas GPs (UK)',
    audience: 'overseas_uk',
    configured: true,
    campaignId: cfg.campaignId,
    adsetId: cfg.adsetId,
    leadFormId: cfg.leadFormId,
    // Every doctor form that is not an Australian form belongs to this campaign.
    leadFormIds: [cfg.leadFormId].concat(idList(env.FB_GP_LEAD_FORM_IDS)).filter(function (x, i, a) { return x && a.indexOf(x) === i; }),
    landingPath: '/start',
    landingLink: '/start?src=fb#book',
    utmCampaigns: tagList(env.META_ADS_UK_UTM_CAMPAIGNS),
    // The stage the ad set optimises for in the Conversions API feed.
    conversionEvent: 'qualified_gp',
    houseContext: 'overseas_uk',
    houseContextApproved: true
  };
}

/** The Australian campaign. `configured` only when its campaign id is set. */
function australianCampaign(env) {
  const campaignId = digits(env.META_ADS_AU_CAMPAIGN_ID);
  const formIds = idList(env.FB_AU_GP_LEAD_FORM_IDS);
  const leadFormId = digits(env.META_AU_LEAD_FORM_ID) || digits(formIds[0]) || '';
  const tags = tagList(env.META_ADS_AU_UTM_CAMPAIGNS);
  return {
    key: AU_KEY,
    label: 'Australian GPs',
    audience: 'au_gp',
    configured: !!campaignId,
    campaignId: campaignId || null,
    adsetId: digits(env.META_ADS_AU_DEFAULT_ADSET_ID) || null,
    leadFormId: leadFormId || null,
    leadFormIds: formIds,
    landingPath: '/australian-gps',
    landingLink: '/australian-gps',
    // A paid click tagged utm_campaign=au_... is this campaign's wherever it lands.
    utmCampaigns: tags.length ? tags : ['au_'],
    conversionEvent: 'au_qualified_gp',
    houseContext: 'au_gp',
    // The Australian brief is a DRAFT until the owner approves it (owner
    // action 95). Until then no review or copy is written for this campaign.
    houseContextApproved: String(env.ADS_AU_HOUSE_CONTEXT_APPROVED || '').trim() === 'true',
    freeForDoctorsApproved: String(env.ADS_AU_FREE_FOR_DOCTORS_APPROVED || '').trim() === 'true'
  };
}

/**
 * The list. opts.auOn is the Australian switch, read by the caller at call
 * time. Switch off: exactly one campaign, today's.
 */
function adsCampaigns(env, opts) {
  const e = env || process.env;
  const list = [overseasCampaign(e)];
  if (opts && opts.auOn === true) list.push(australianCampaign(e));
  return list;
}

function findCampaign(list, key) {
  return (Array.isArray(list) ? list : []).find(function (c) { return c.key === key; }) || null;
}

/**
 * The lib/meta-ads.js config for one campaign. The overseas campaign's is
 * `adsConfig(env)` itself. The Australian one keeps the account, page, token
 * and time zones and swaps the campaign, ad set, form and link; null when it
 * is not configured (nothing may be read or changed for it).
 */
function configFor(campaign, env) {
  const e = env || process.env;
  const cfg = metaAds.adsConfig(e);
  if (!campaign || campaign.key === UK_KEY) return cfg;
  if (!campaign.configured || !campaign.campaignId) return null;
  return Object.assign({}, cfg, {
    campaignId: campaign.campaignId,
    adsetId: campaign.adsetId || '',
    leadFormId: campaign.leadFormId || '',
    leadLink: siteOrigin(e) + campaign.landingLink
  });
}

/**
 * The environment lib/ads-actions.js reads its floor and ceiling from, for one
 * campaign. The overseas campaign: the environment itself. The Australian one
 * may carry its own (ADS_AU_MIN_LIVE_ADS, ADS_AU_MAX_DAILY_BUDGET) and
 * otherwise uses the same limits. The checks themselves are untouched and are
 * always lib/ads-actions.js `checkChange`.
 */
function limitsEnvFor(campaign, env) {
  const e = env || process.env;
  if (!campaign || campaign.key === UK_KEY) return e;
  const out = Object.assign({}, e);
  if (String(e.ADS_AU_MIN_LIVE_ADS || '').trim() !== '') out.ADS_MIN_LIVE_ADS = e.ADS_AU_MIN_LIVE_ADS;
  if (String(e.ADS_AU_MAX_DAILY_BUDGET || '').trim() !== '') out.ADS_MAX_DAILY_BUDGET = e.ADS_AU_MAX_DAILY_BUDGET;
  return out;
}
function limitsFor(campaign, env) {
  return adsActions.limits(limitsEnvFor(campaign, env));
}

/**
 * Which campaign's NUMBERS a lead counts in. One lead, one answer:
 *   Australian-segment, attributed to the Australian campaign -> 'au_gp'
 *   Australian-segment, anything else (direct, unknown, another campaign)
 *                                                    -> 'au_other'
 *   not Australian-segment but from the Australian campaign's form or ads
 *                                                    -> 'au_campaign_other'
 *   every other lead                                 -> 'overseas_uk', as today
 * So an Australian lead is never in the UK campaign's numbers, and a lead the
 * Australian campaign paid for is never in them either.
 * `isAu` is auLead.isAuSegmentLead(row); `attribution` is
 * auAttribution.attributionForLead(row, campaigns).
 */
function bucketForLead(isAu, attribution) {
  const fromAu = !!attribution && attribution.campaign === AU_KEY;
  if (isAu) return fromAu ? AU_KEY : 'au_other';
  return fromAu ? 'au_campaign_other' : UK_KEY;
}

module.exports = {
  UK_KEY,
  AU_KEY,
  adsCampaigns,
  overseasCampaign,
  australianCampaign,
  findCampaign,
  configFor,
  limitsEnvFor,
  limitsFor,
  bucketForLead
};
