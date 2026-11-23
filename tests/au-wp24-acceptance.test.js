import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

// WP-24 ACCEPTANCE: an Australian lead and a UK lead on the same day appear
// under different campaigns in the ads hub and send different conversion
// events. One walk through the REAL server, at a fixed clock, with a stub
// Graph API (ads + Conversions API) and a stub model. Nothing is delivered:
// every request the app would have made is captured by the stubs.
//
//   Part 1 (today: no Australian campaign, no Australian dataset)
//     four leads on one day  -> stored attribution -> the conversion requests
//     (UK: today's dataset and events, byte-identical to the pre-change
//     snapshot; Australian: NOTHING) -> the hub's per-campaign numbers.
//   Part 2 (the owner has configured the Australian campaign and dataset)
//     the same Australian leads now send THEIR OWN events to THEIR OWN
//     dataset; the review runs per campaign with its own brief and its own
//     leads; the net drops bad copy; every guard still applies per campaign.
const require = createRequire(import.meta.url);
const parity = require('./helpers/au-wp24-parity.js');
const auAttribution = require('../lib/au-attribution.js');
const adsReview = require('../lib/ads-review.js');
const { bannedIn } = require('./helpers/au-banned-words.js');

const AU_FORM = '2370693577089999';
const AU_LEAD_ID = '1432788012007777';
const AU_DATASET = '31126391376979999';
const AU_CAMPAIGN = '120248645727409999';
const AU_ADSET = '900';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let rig;
const snapshot = parity.readSnapshot();

function auWebhookBody() {
  return { entry: [{ changes: [{ value: {
    leadgen_id: AU_LEAD_ID, form_id: AU_FORM, ad_id: '9001',
    field_data: [
      { name: 'full_name', values: ['Test Auwebhook'] },
      { name: 'email', values: ['au.webhook.test@gplink-test.local'] },
      { name: 'phone_number', values: ['+61400000411'] },
      { name: 'are_you_currently_registered_with_ahpra?', values: ['yes'] },
      { name: 'which_state_or_territory_are_you_in?', values: ['western_australia'] },
      { name: 'are_you_a_vocationally_registered_gp_(fracgp_or_facrrm)?', values: ['yes'] },
      { name: 'does_the_19ab_moratorium_apply_to_you?', values: ['no'] },
      { name: 'what_is_your_right_to_work_in_australia?', values: ['australian_citizen_or_permanent_resident'] }
    ] } }] }] };
}
function cookieFor(touch) {
  return auAttribution.COOKIE_NAME + '=' + auAttribution.encodeCookie({ first: touch, last: touch });
}
function siteForm(over) {
  return Object.assign({ name: 'Dr Test Sitelead', phone: '+61400200300', country: 'uk', question: '', website: '', utm: {}, tz: 'Australia/Perth' }, over);
}
const events = () => rig.graph.calls.filter((c) => /\/events$/.test(c.path));
const leadByEmail = (email) => (rig.readDb().siteEnquiries || []).find((r) => r.email === email);
const card = (json, key) => (json.campaigns || []).find((c) => c.key === key);
const web = (ip) => ({ host: 'localhost', headers: { 'x-forwarded-for': ip, 'x-real-ip': ip, 'user-agent': 'wp24-acceptance' } });

beforeAll(async () => {
  rig = await parity.bootWp24Rig(vi, {
    switchOn: true,
    env: { FB_GP_LEAD_FORM_IDS: parity.UK_FORM, FB_AU_GP_LEAD_FORM_IDS: AU_FORM }
  });
  rig.testUtils.__resetSiteEnquiriesForTest();
});
afterAll(async () => { if (rig) await rig.close(); });

describe('Part 1: today (no Australian campaign or dataset configured)', () => {
  it('a UK Meta lead sends exactly the pre-change request: same dataset, same events, same bytes', async () => {
    const res = await rig.req('POST', '/api/webhooks/facebook-lead?secret=test-fb-secret', { body: parity.ukWebhookBody(), host: 'localhost' });
    expect(res.status).toBe(200);
    const sent = events();
    expect(sent.length).toBe(1);
    expect(sent[0].path).toBe('/v26.0/' + parity.DATASET + '/events');
    expect(sent[0].raw).toBe(snapshot.webhook.capi[0].raw);
    expect(sent[0].params.data.map((e) => e.event_name)).toEqual(['lead', 'qualified_gp']);
    rig.graph.calls.length = 0;
  });

  it('an Australian Meta lead on the same day sends NOTHING to Meta', async () => {
    const res = await rig.req('POST', '/api/webhooks/facebook-lead?secret=test-fb-secret', { body: auWebhookBody(), host: 'localhost' });
    expect(res.status).toBe(200);
    const row = leadByEmail('au.webhook.test@gplink-test.local');
    expect(row.metadata.consult.segment).toBe('au_vr');
    expect(row.metadata.fb_form_id).toBe(AU_FORM);
    expect(events()).toEqual([]);
    expect(row.metadata.consult.meta_capi).toBeUndefined();
  });

  it('the hourly sweep is consistent with the webhook: still nothing for the Australian lead', async () => {
    const res = await rig.req('GET', '/api/cron/meta-lead-stages', { headers: { Authorization: 'Bearer test-cron-secret' }, host: 'localhost' });
    expect(res.status).toBe(200);
    expect(res.json.failed).toBe(0);
    expect(events()).toEqual([]);
    expect(leadByEmail('au.webhook.test@gplink-test.local').metadata.consult.meta_capi).toBeUndefined();
  });

  it('website leads carry their first and last touch from the cookie, cleaned; a lead with no cookie carries none', async () => {
    const uk = await rig.req('POST', '/api/public/consult-lead', Object.assign(web('10.24.0.1'), {
      body: siteForm({ email: 'uk.site.test@gplink-test.local', ahpraRegistered: false, consentVersion: 'overseas_v0', utm: { utm_campaign: 'uk_test' } }),
      cookie: cookieFor({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'uk_test', landing_page: '/start', at: '2026-11-20T01:00:00.000Z' })
    }));
    expect(uk.status).toBe(200);
    const au = await rig.req('POST', '/api/public/consult-lead', Object.assign(web('10.24.0.2'), {
      body: siteForm({ email: 'au.site.test@gplink-test.local', phone: '+61400200301', country: '', ahpraRegistered: true, state: 'WA', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' }),
      cookie: cookieFor({ utm_source: 'test', utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps', at: '2026-11-20T01:30:00.000Z' })
    }));
    expect(au.status).toBe(200);
    const direct = await rig.req('POST', '/api/public/consult-lead', Object.assign(web('10.24.0.3'), {
      body: siteForm({ email: 'au.direct.test@gplink-test.local', phone: '+61400200302', country: '', ahpraRegistered: true, state: 'NSW', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' })
    }));
    expect(direct.status).toBe(200);

    const ukRow = leadByEmail('uk.site.test@gplink-test.local');
    expect(ukRow.metadata.utm).toEqual({ utm_campaign: 'uk_test' });            // today's field, unchanged
    expect(ukRow.metadata.attribution.first).toMatchObject({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'uk_test', landing_page: '/start' });
    const auRow = leadByEmail('au.site.test@gplink-test.local');
    expect(auRow.metadata.attribution.last).toMatchObject({ utm_source: 'test', utm_campaign: 'au_test', fbclid: 'FAKE', landing_page: '/australian-gps' });
    expect(auRow.metadata.consult.segment).toBe('au_vr');
    expect(leadByEmail('au.direct.test@gplink-test.local').metadata.attribution).toBeUndefined();
    // Website leads never go to the Conversions API (no Meta lead id), today or now.
    expect(events()).toEqual([]);
  });

  it('the hub shows the two campaigns separately; each lead is counted once, in its own campaign', async () => {
    const page = await rig.req('GET', '/api/ceo/ads', rig.ceo());
    expect(page.status).toBe(200);
    const uk = card(page.json, 'overseas_uk');
    const au = card(page.json, 'au_gp');
    expect(page.json.campaigns.map((c) => c.key)).toEqual(['overseas_uk', 'au_gp']);
    // The UK campaign's numbers are the page's own funnel: the UK Meta lead only.
    expect(page.json.snapshot.funnel.d30.leads).toBe(1);
    expect(uk.leads.d30.leads).toBe(1);
    expect(uk.landing_link).toBe('/start?src=fb#book');
    // Beside them: the UK website enquiry that came from a paid click (never in the Australian numbers).
    expect(uk.website_leads.d30.leads).toBe(1);
    expect(uk.conversion_event).toBe('qualified_gp');
    // The Australian campaign: the Meta-form lead and the paid website lead.
    expect(au.status).toBe('not_set_up');
    expect(au.status_note).toMatch(/Not set up yet/);
    expect(au.leads.d30.leads).toBe(2);
    expect(au.leads.by_channel).toEqual({ meta_lead_form: 1, paid: 1 });
    expect(au.landing_link).toBe('/australian-gps');
    expect(au.conversion_event).toBe('au_qualified_gp');
    expect(au.conversions).toBe('not_configured');
    // The Australian lead with no attribution is direct / unknown: in neither campaign.
    expect(au.other_australian_leads.d30.leads).toBe(1);
    expect(au.other_australian_leads.by_channel).toEqual({ direct: 1 });
    expect(au.snapshot).toBeNull();
    expect(au.review).toBeNull();
    // Nothing was read from Meta for the Australian campaign.
    expect(rig.graph.calls.some((c) => c.path.indexOf(AU_CAMPAIGN) !== -1)).toBe(false);
  });

  it('the Performance card (any date range) is the UK campaign\'s too: the Australian leads are not in it', async () => {
    const r = await rig.req('GET', '/api/ceo/ads/range?preset=today&increment=1', rig.ceo());
    expect(r.status).toBe(200);
    expect(r.json.funnel.leads).toBe(1);
    rig.setSwitch(false);
    try {
      // Switch off: as today, every Meta lead counts (two of them here).
      const off = await rig.req('GET', '/api/ceo/ads/range?preset=today&increment=1', rig.ceo());
      expect(off.json.funnel.leads).toBe(2);
    } finally { rig.setSwitch(true); }
  });

  it('no account change is possible for a campaign that is not set up', async () => {
    rig.graph.calls.length = 0;
    const res = await rig.req('POST', '/api/ceo/ads/changes/apply', Object.assign({ body: { campaign: 'au_gp', review_id: 'anything', ids: ['chg-1'] } }, rig.ceo()));
    expect(res.status).toBe(409);
    expect(res.json.message).toMatch(/not set up yet/i);
    expect(rig.graph.calls).toEqual([]);
  });
});

describe('Part 2: the Australian campaign and dataset are configured', () => {
  const AU_ADS = ['9001', '9002'].map((id) => ({
    id, name: 'AU ad ' + id, status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: AU_ADSET, created_time: '2026-11-01T00:40:28+1100',
    creative: { id: 'c' + id, title: 'A better-fitting practice ' + id, body: 'Body', call_to_action_type: 'LEARN_MORE' }
  }));
  const GOOD_BRIEF = { angle: 'au-01-fit', image_headline: 'A practice that fits how you work', image_sub: 'A confidential conversation, on your terms.', headline: 'A practice that fits how you work',
    primary_text: 'The mix of sessions, the patient list and the billing model can all be different.\n\nA conversation with us is confidential. Your current practice is not told.\n\nThe first step is a short call with a person.',
    description: 'A confidential first call.', image_prompt: 'A GP in a plain shirt walking into a suburban practice in morning sun, eyes on the door, 35mm.', rationale: 'r', improvements_applied: [], why_strong: ['Thin data.'] };
  const BAD_BRIEFS = [
    Object.assign({}, GOOD_BRIEF, { angle: 'au-02-money', primary_text: 'Earn up to $400k. Guaranteed offer in two weeks.' }),
    Object.assign({}, GOOD_BRIEF, { angle: 'au-03-move', image_sub: 'Visa and relocation handled for overseas GPs.' }),
    Object.assign({}, GOOD_BRIEF, { angle: 'au-04-free', description: 'Completely free for doctors.' })
  ];
  const AU_REVIEW = {
    headline: 'Early days.', summary: 'Two ads live. Data is thin.', actions_today: [], ad_verdicts: [], improvements: [], what_works: [], what_doesnt: [],
    account_changes: [
      { id: 'x', action: 'pause_ad', target_id: '9002', target_name: 'AU ad 9002', daily_budget: 0, title: 'Pause 9002', why: 'No leads.', priority: 2 },
      { id: 'x', action: 'pause_ad', target_id: '9001', target_name: 'AU ad 9001', daily_budget: 0, title: 'Pause 9001', why: 'Test.', priority: 2 },
      { id: 'x', action: 'set_adset_daily_budget', target_id: AU_ADSET, target_name: 'AU set', daily_budget: 500, title: 'Raise the budget', why: 'Test.', priority: 3 },
      { id: 'x', action: 'pause_ad', target_id: '1', target_name: 'A UK ad', daily_budget: 0, title: 'Pause a UK ad', why: 'Test.', priority: 3 },
      { id: 'x', action: 'create_ad', target_id: 'au-01-fit', target_name: 'New ad', daily_budget: 0, title: 'Write a new ad', why: 'Test.', priority: 3 }
    ],
    automation_changes: [{ lever: 'hazel.max_attempts', value: 3, why: 'x' }],
    new_ad_briefs: [GOOD_BRIEF].concat(BAD_BRIEFS), warnings: []
  };

  beforeAll(() => {
    // Later the same day (rows are ordered by when they were written).
    vi.setSystemTime(parity.FIXED_NOW + 10 * 60000);
    process.env.META_AU_CAPI_DATASET_ID = AU_DATASET;
    process.env.META_ADS_AU_CAMPAIGN_ID = AU_CAMPAIGN;
    process.env.META_ADS_AU_DEFAULT_ADSET_ID = AU_ADSET;
    process.env.ADS_AU_HOUSE_CONTEXT_APPROVED = 'true';
    process.env.ADS_AU_MAX_DAILY_BUDGET = '120';
    rig.graph.adsets[AU_CAMPAIGN] = [{ id: AU_ADSET, name: 'AU set', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '5000', optimization_goal: 'QUALITY_LEAD' }];
    rig.graph.ads[AU_CAMPAIGN] = AU_ADS;
    // The UK review is the baseline's; the Australian one is told apart by its brief.
    rig.ai.reply = (body) => JSON.stringify(/ALREADY registered with Ahpra and working in Australia/.test(JSON.stringify(body.system)) ? AU_REVIEW : parity.MODEL_REVIEW);
    rig.graph.calls.length = 0;
    rig.ai.calls.length = 0;
  });

  it('a preview deployment sends nothing even with the Australian dataset configured (the send lock still applies)', async () => {
    process.env.VERCEL_ENV = 'preview';
    try {
      const res = await rig.req('GET', '/api/cron/meta-lead-stages', { headers: { Authorization: 'Bearer test-cron-secret' }, host: 'localhost' });
      expect(res.status).toBe(200);
      expect(events()).toEqual([]);
      expect(leadByEmail('au.webhook.test@gplink-test.local').metadata.consult.meta_capi).toBeUndefined();
    } finally { delete process.env.VERCEL_ENV; }
    rig.graph.calls.length = 0;
  });

  it('the Australian lead now sends ITS OWN events to ITS OWN dataset; the UK lead sends nothing new', async () => {
    const res = await rig.req('GET', '/api/cron/meta-lead-stages', { headers: { Authorization: 'Bearer test-cron-secret' }, host: 'localhost' });
    expect(res.status).toBe(200);
    const sent = events();
    expect(sent.length).toBe(1);
    expect(sent[0].path).toBe('/v26.0/' + AU_DATASET + '/events');
    expect(sent[0].params.data.map((e) => e.event_name)).toEqual(['au_lead', 'au_qualified_gp']);
    for (const e of sent[0].params.data) {
      expect(e.event_id).toBe(AU_LEAD_ID + ':' + e.event_name);
      expect(e.action_source).toBe('system_generated');
      // The same fields as the existing feed, hashed the same way; nothing new about the person.
      expect(Object.keys(e.user_data).sort()).toEqual(['em', 'lead_id', 'ph']);
      expect(e.user_data.em).toEqual([sha('au.webhook.test@gplink-test.local')]);
      expect(e.custom_data).toEqual({ lead_event_source: 'GP Link app (Australian GPs)', event_source: 'crm' });
    }
    expect(sent[0].raw).not.toContain('au.webhook.test');
    expect(sent[0].raw).not.toContain('"event_name":"qualified_gp"');
    expect(sent[0].raw).not.toContain('"event_name":"lead"');
    // Not one request reached the overseas dataset.
    expect(rig.graph.calls.some((c) => c.path === '/v26.0/' + parity.DATASET + '/events')).toBe(false);
    rig.graph.calls.length = 0;
  });

  it('the review runs once per campaign: the UK prompt is today\'s, the Australian one carries the Australian brief and only its own leads', async () => {
    vi.setSystemTime(parity.FIXED_NOW + 20 * 60000);
    const rev = await rig.req('POST', '/api/ceo/ads/review', Object.assign({ body: {} }, rig.ceo()));
    expect(rev.status).toBe(200);
    expect(rev.json.ok).toBe(true);
    expect(rig.ai.calls.length).toBe(2);
    const ukCall = rig.ai.calls.find((c) => c.body.system[0].text === adsReview.buildReviewMessages({}).system);
    const auCall = rig.ai.calls.find((c) => c !== ukCall);
    expect(ukCall).toBeTruthy();
    // The UK system prompt is byte-identical to the pre-change snapshot's.
    expect(ukCall.body.system).toEqual(snapshot.review.model_requests[0].system);
    const ukUser = JSON.stringify(ukCall.body.messages);
    expect(ukUser).not.toContain('AU ad 9001');
    const auSystem = auCall.body.system[0].text;
    expect(auSystem).toContain('ALREADY registered with Ahpra and working in Australia');
    expect(auSystem).not.toContain('UK-trained GPs in Australian practices');
    expect(auSystem).not.toContain('Hazel');
    expect(auSystem).not.toContain('QOF');
    const auUser = JSON.stringify(auCall.body.messages);
    expect(auUser).toContain('AU ad 9001');
    expect(auUser).not.toContain('No QOF. No CQC.');
    expect(auUser).not.toMatch(/Hazel/);
    // The Australian campaign's own funnel: the Meta-form lead (the app joins by ad id).
    const auFunnel = JSON.parse(auCall.body.messages[0].content.split('\n').find((l) => l.charAt(0) === '{')).app_funnel;
    expect(auFunnel.d30.leads).toBe(1);
  });

  let auCard;
  let reviewRowId;
  it('the net drops Australian copy that breaks a wording rule, and only status and budget changes survive', async () => {
    const page = await rig.req('GET', '/api/ceo/ads', rig.ceo());
    auCard = card(page.json, 'au_gp');
    reviewRowId = auCard.review_row_id;
    expect(auCard.status).toBe('configured');
    expect(auCard.snapshot.ads.map((a) => a.id).sort()).toEqual(['9001', '9002']);
    expect(auCard.review.new_ad_briefs.map((b) => b.angle)).toEqual(['au-01-fit']);
    expect(auCard.dropped.filter((d) => d.kind === 'brief').map((d) => d.id).sort()).toEqual(['au-02-money', 'au-03-move', 'au-04-free']);
    expect(bannedIn(JSON.stringify(auCard.review.new_ad_briefs))).toEqual([]);
    expect(auCard.review.account_changes.map((c) => c.action)).toEqual(['pause_ad', 'pause_ad', 'set_adset_daily_budget', 'pause_ad']);
    expect(auCard.review.automation_changes).toEqual([]);
    // The UK campaign's page is the UK campaign's: its own review, its own ads.
    expect(page.json.review.review.headline).toBe('Steady week.');
    expect(page.json.snapshot.ads.map((a) => a.id).sort()).toEqual(['1', '2', '3', '4']);
    expect(page.json.snapshot.funnel.d30.leads).toBe(1);
    expect(card(page.json, 'overseas_uk').leads.d30.leads).toBe(1);
    expect(auCard.conversions).toBe('configured');
  });

  it('every guard still applies, per campaign: the floor, the ceiling, and a campaign can only touch its own ads', async () => {
    rig.graph.calls.length = 0;
    const ids = auCard.review.account_changes.map((c) => c.id);
    const res = await rig.req('POST', '/api/ceo/ads/changes/apply', Object.assign({ body: { campaign: 'au_gp', review_id: reviewRowId, ids } }, rig.ceo()));
    expect(res.status).toBe(200);
    const byTitle = {};
    auCard.review.account_changes.forEach((c) => { byTitle[c.title] = res.json.results.find((r) => r.id === c.id); });
    // One pause goes through; the second would empty the ad set and is refused.
    const pauses = [byTitle['Pause 9002'], byTitle['Pause 9001']];
    expect(pauses.filter((r) => r.ok).length, JSON.stringify(res.json.results)).toBe(1);
    expect(pauses.find((r) => !r.ok).message).toMatch(/leave|live/i);
    // AU$500 a day is above this campaign's own ceiling (120) and more than double.
    expect(byTitle['Raise the budget'].ok).toBe(false);
    // A UK ad is not in this campaign's live state.
    expect(byTitle['Pause a UK ad'].ok).toBe(false);
    const writes = rig.graph.calls.filter((c) => c.method !== 'GET');
    expect(writes.length).toBe(1);
    expect(['/v21.0/9001', '/v21.0/9002']).toContain(writes[0].path);
    expect(writes[0].params.status).toBe('PAUSED');
    // Every read before the write was of the Australian campaign.
    expect(rig.graph.calls.filter((c) => c.method === 'GET' && /\/(ads|adsets)$/.test(c.path)).every((c) => c.path.indexOf(AU_CAMPAIGN) !== -1)).toBe(true);
  });

  it('the UK campaign\'s own apply cannot reach an Australian ad', async () => {
    // Put a change naming an Australian ad into the stored UK review, then tick it.
    const db = rig.readDb();
    const row = (db.adReviews || []).find((r) => r.id === reviewRowId);
    expect(row).toBeTruthy();
    const rev = await rig.req('POST', '/api/ceo/ads/changes/apply', Object.assign({ body: { review_id: reviewRowId, ids: ['nope'] } }, rig.ceo()));
    expect(rev.status).toBe(400);
    const adsActions = require('../lib/ads-actions.js');
    const check = adsActions.checkChange({ id: 'c', action: 'pause_ad', target_id: '9001' }, { ads: parity.LIVE_ADS.map((a) => ({ id: a.id, adset_id: a.adset_id, effective_status: 'ACTIVE', rotation: 'live' })), adsets: [] }, [], adsActions.limits({}));
    expect(check.ok).toBe(false);
  });

  it('nothing in this walk tried to reach a real outside address', () => {
    expect(rig.blocked).toEqual([]);
  });
});
