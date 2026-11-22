import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// WP-24: (B) the pixel and Google tag on sign-in and onboarding, (C) the
// conversion router, (D) the campaign list, the Australian brief and its net.
// Library level; the walk through the real server is au-wp24-acceptance.
const require = createRequire(import.meta.url);
const tracking = require('../js/au-tracking.js');
const metaCapi = require('../lib/meta-capi.js');
const metaAds = require('../lib/meta-ads.js');
const adsActions = require('../lib/ads-actions.js');
const adsReview = require('../lib/ads-review.js');
const campaigns = require('../lib/ads-campaigns.js');
const auContext = require('../lib/ads-au-context.js');
const parity = require('./helpers/au-wp24-parity.js');
const { bannedIn } = require('./helpers/au-banned-words.js');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const snapshot = parity.readSnapshot();

describe('B. sign-in and onboarding: when anything loads at all', () => {
  const REAL = 'app.mygplink.com.au';
  it('switch off: nothing, whatever the page or the address', () => {
    expect(tracking.decide({ switchOn: false, hostname: REAL, href: 'https://' + REAL + '/pages/signin' })).toEqual({ track: false, reason: 'switch off' });
    expect(tracking.decide({ hostname: REAL, href: 'https://' + REAL + '/pages/onboarding' }).track).toBe(false);
  });
  it('switch on but not the real domain (localhost, a preview): nothing', () => {
    for (const host of ['localhost', 'site.localhost', 'gplink-git-au-gp-testing.vercel.app', 'preview.mygplink.com.au', 'app.mygplink.com.au.evil.example']) {
      expect(tracking.decide({ switchOn: true, hostname: host, href: 'https://' + host + '/pages/signin' }).track, host).toBe(false);
    }
  });
  it('the sign-up link from the booking page: the email is taken out of the address before anything loads', () => {
    const d = tracking.decide({ switchOn: true, hostname: 'www.mygplink.com.au', href: 'https://www.mygplink.com.au/pages/signin?signup=1&email=dr.jane%40example.com' });
    expect(d).toEqual({ track: true, url: '/pages/signin?signup=1', changed: true });
    expect(JSON.stringify(d)).not.toContain('jane');
  });
  it('a sign-in link, a recovery link or any unlisted parameter: NOTHING is loaded for that page view', () => {
    const bad = [
      '/pages/signin#access_token=eyJhbGciOi&refresh_token=abc&type=recovery',
      '/pages/signin?code=4f1e5b&signup=1',
      '/pages/signin?token_hash=abcdef&type=signup',
      '/pages/signin?next=https://evil.example/',
      '/pages/signin?next=/pages/practice-decision?token=abc',
      '/pages/signin?signup=yes',
      '/pages/onboarding.html?reupload=specialist_qualification',
      '/pages/onboarding?ahpra=MED0001234567',
      '/pages/signin?utm_campaign=me%40example.com',
      '/pages/signin?signup=1&lead=SECRET'
    ];
    for (const p of bad) expect(tracking.decide({ switchOn: true, hostname: REAL, href: 'https://' + REAL + p }).track, p).toBe(false);
  });
  it('an ordinary address is reported as it is', () => {
    expect(tracking.plan('https://app.mygplink.com.au/pages/signin?signup=1&next=/pages/career&utm_campaign=au_test&fbclid=FAKE'))
      .toEqual({ track: true, url: '/pages/signin?signup=1&next=%2Fpages%2Fcareer&utm_campaign=au_test&fbclid=FAKE', changed: false });
    expect(tracking.plan('https://app.mygplink.com.au/pages/onboarding.html?step=2&au=1')).toEqual({ track: true, url: '/pages/onboarding.html?step=2&au=1', changed: false });
    expect(tracking.plan('https://app.mygplink.com.au/pages/signin')).toEqual({ track: true, url: '/pages/signin', changed: false });
  });
});

describe('B. what an event may carry: the segment, and nothing else', () => {
  it('page view: the pixel\'s own form and button scanning is switched off before it starts', () => {
    const calls = tracking.pageViewCalls();
    expect(calls[0]).toEqual({ tool: 'fbq', args: ['set', 'autoConfig', false, tracking.PIXEL_ID] });
    expect(calls.map((c) => c.args[0] + ':' + (c.args[1] || ''))).toEqual(['set:autoConfig', 'init:' + tracking.PIXEL_ID, 'track:PageView']);
    // init carries no user data (no "advanced matching" object).
    expect(calls[1].args.length).toBe(2);
  });
  it('sign-up completed and onboarding completed: one fixed word each', () => {
    for (const build of [tracking.signupCompletedCalls, tracking.onboardingCompletedCalls]) {
      for (const input of ['australian', 'overseas', 'dr.jane@example.com', '+61400000000', 'MED0001234567', '<script>', undefined, { email: 'x@y.z' }]) {
        const calls = build(input);
        const payloads = calls.map((c) => c.args[c.args.length - 1]);
        for (const p of payloads) {
          const keys = Object.keys(p).filter((k) => k !== 'event');
          expect(keys.length).toBe(1);
          expect(['australian', 'overseas']).toContain(p[keys[0]]);
        }
        expect(JSON.stringify(calls)).not.toMatch(/@|\+61|MED\d|script/);
      }
    }
    expect(tracking.signupCompletedCalls('australian')).toEqual([
      { tool: 'fbq', args: ['track', 'CompleteRegistration', { segment: 'australian' }] },
      { tool: 'dataLayer', args: [{ event: 'gp_sign_up_completed', gp_segment: 'australian' }] }
    ]);
    expect(tracking.onboardingCompletedCalls('overseas')).toEqual([
      { tool: 'fbq', args: ['trackCustom', 'OnboardingCompleted', { segment: 'overseas' }] },
      { tool: 'dataLayer', args: [{ event: 'gp_onboarding_completed', gp_segment: 'overseas' }] }
    ]);
  });
  it('the script itself never reads a form field, and uses the same pixel and container as the site pages', () => {
    const src = read('js/au-tracking.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    expect(src).not.toMatch(/querySelector|getElementById|\.value\b|FormData|localStorage|sessionStorage/);
    const start = read('pages/site-start.html');
    expect(start).toContain("fbq('init', '" + tracking.PIXEL_ID + "');");
    expect(start).toContain('gtm.js?id=' + tracking.GTM_ID);
  });
});

describe('B. the pages', () => {
  it('sign-in and onboarding load the tracker once, after the switch helper, and carry no tracking code of their own', () => {
    for (const [file, page] of [['pages/signin.html', 'signin'], ['pages/onboarding.html', 'onboarding']]) {
      const html = read(file);
      const tag = '<script src="/js/au-tracking.js?v=20261123a" data-page="' + page + '"></script>';
      expect(html.split(tag).length - 1, file).toBe(1);
      expect(html.indexOf(tag), file).toBeGreaterThan(html.indexOf('/js/au-pathway.js?v='));
      expect(html, file).not.toMatch(/connect\.facebook\.net|googletagmanager\.com|fbq\(|gtag\(|dataLayer/);
      // Exactly what the page carried before WP-24, by this measure.
      expect(parity.trackingFacts(file), file).toEqual(snapshot.pages[page]);
    }
  });
  it('the signed-in app pages get nothing new', () => {
    for (const file of ['index.html', 'app-shell.html', 'career.html', 'admin.html', 'ceo-dashboard.html', 'my-documents.html', 'account.html']) {
      const html = read('pages/' + file);
      expect(html, file).not.toContain('au-tracking');
      expect(html, file).not.toContain('site-attribution');
      expect(html, file).not.toContain('googletagmanager.com');
    }
  });
});

describe('C. the conversion router: one decision per lead', () => {
  const UK_ENV = { META_CAPI_DATASET_ID: parity.DATASET, META_CAPI_ACCESS_TOKEN: 'test-capi-token' };
  const AU_ENV = Object.assign({}, UK_ENV, { META_AU_CAPI_DATASET_ID: '31126391376979999' });
  const row = parity.ukLead();

  it('switch off: every lead goes where it goes today, an Australian one included', () => {
    for (const segment of ['overseas', 'au_vr', 'au_unknown']) {
      const r = metaCapi.routeMetaLeadConversion(row, { env: AU_ENV, auOn: false, segment });
      expect(r.route).toBe('overseas');
      expect(r.cfg).toEqual(metaCapi.metaCapiConfigFromEnv(UK_ENV));
    }
  });
  it('switch on, overseas lead: today\'s config, and a payload identical to the pre-change snapshot', () => {
    const r = metaCapi.routeMetaLeadConversion(row, { env: AU_ENV, auOn: true, segment: 'overseas' });
    expect(r).toEqual({ route: 'overseas', cfg: snapshot.lib.capi_config, reason: null });
    const events = metaCapi.buildMetaLeadStageEvents(row, metaCapi.deriveMetaLeadStages(row, { now: parity.FIXED_NOW }), r.cfg, { now: parity.FIXED_NOW });
    expect(metaCapi.serializeMetaCapiBody(events, r.cfg)).toBe(snapshot.lib.capi_body);
  });
  it('switch on, every Australian segment, no Australian dataset: nothing is sent, with the reason', () => {
    for (const segment of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar', 'au_unknown']) {
      expect(metaCapi.routeMetaLeadConversion(row, { env: UK_ENV, auOn: true, segment })).toEqual({ route: 'au', cfg: null, reason: 'au_not_configured' });
    }
  });
  it('the Australian dataset can never be the overseas one', () => {
    const same = Object.assign({}, UK_ENV, { META_AU_CAPI_DATASET_ID: parity.DATASET });
    expect(metaCapi.metaAuCapiConfigFromEnv(same)).toBeNull();
    expect(metaCapi.routeMetaLeadConversion(row, { env: same, auOn: true, segment: 'au_vr' })).toEqual({ route: 'au', cfg: null, reason: 'au_dataset_same_as_overseas' });
    expect(metaCapi.metaAuCapiConfigFromEnv({ META_AU_CAPI_DATASET_ID: 'abc', META_CAPI_ACCESS_TOKEN: 't' })).toBeNull();
    expect(metaCapi.metaAuCapiConfigFromEnv({ META_AU_CAPI_DATASET_ID: '123' })).toBeNull();
  });
  it('configured: its own dataset AND its own event names; the same hashing and fields as the existing feed', () => {
    const r = metaCapi.routeMetaLeadConversion(row, { env: AU_ENV, auOn: true, segment: 'au_vr' });
    expect(r.route).toBe('au');
    expect(r.cfg.datasetId).toBe('31126391376979999');
    const stages = metaCapi.deriveMetaLeadStages(row, { now: parity.FIXED_NOW });
    const au = metaCapi.buildMetaLeadStageEvents(row, stages, r.cfg, { now: parity.FIXED_NOW });
    const uk = snapshot.lib.capi_events;
    expect(au.map((e) => e.event_name)).toEqual(['au_lead', 'au_qualified_gp', 'au_call_booked']);
    expect(uk.map((e) => e.event_name)).toEqual(['lead', 'qualified_gp', 'call_booked']);
    au.forEach((e, i) => {
      expect(e.user_data).toEqual(uk[i].user_data);            // nothing new about the person
      expect(e.event_time).toBe(uk[i].event_time);
      expect(e.action_source).toBe(uk[i].action_source);
      expect(Object.keys(e).sort()).toEqual(Object.keys(uk[i]).sort());
      expect(e.event_id).toBe(parity.UK_LEAD_ID_2 + ':' + e.event_name);
    });
    // No event name is shared between the two routes.
    const names = Object.values(metaCapi.AU_META_EVENT_NAMES);
    expect(names.filter((n) => metaCapi.META_LEAD_STAGES.indexOf(n) !== -1)).toEqual([]);
    expect(Object.keys(metaCapi.AU_META_EVENT_NAMES)).toEqual(metaCapi.META_LEAD_STAGES);
  });
});

describe('D. the campaign list', () => {
  it('switch off: one campaign, and it is exactly the config the hub has always used', () => {
    const list = campaigns.adsCampaigns({}, { auOn: false });
    expect(list.length).toBe(1);
    const uk = list[0];
    const cfg = metaAds.adsConfig({});
    expect(uk).toMatchObject({ key: 'overseas_uk', audience: 'overseas_uk', configured: true, campaignId: cfg.campaignId, adsetId: cfg.adsetId, leadFormId: cfg.leadFormId, landingLink: '/start?src=fb#book', conversionEvent: 'qualified_gp' });
    expect(campaigns.configFor(uk, {})).toEqual(cfg);
    expect(campaigns.configFor(uk, {})).toEqual(snapshot.lib.ads_config);
    expect(campaigns.limitsFor(uk, {})).toEqual(snapshot.lib.action_limits);
    expect(campaigns.limitsEnvFor(uk, process.env)).toBe(process.env);
    expect(campaigns.adsCampaigns({}).length).toBe(1);
  });
  it('switch on, nothing configured: the Australian campaign is listed as not set up, with no config to read or change anything', () => {
    const list = campaigns.adsCampaigns({}, { auOn: true });
    expect(list.map((c) => c.key)).toEqual(['overseas_uk', 'au_gp']);
    const au = list[1];
    expect(au).toMatchObject({ audience: 'au_gp', configured: false, campaignId: null, landingLink: '/australian-gps', conversionEvent: 'au_qualified_gp', houseContextApproved: false, freeForDoctorsApproved: false });
    expect(campaigns.configFor(au, { META_ADS_ACCESS_TOKEN: 't' })).toBeNull();
    // The first entry is untouched by the second existing.
    expect(list[0]).toEqual(campaigns.adsCampaigns({}, { auOn: false })[0]);
  });
  it('configured: its own campaign, ad set, form and link; the same account and token', () => {
    const env = { META_ADS_ACCESS_TOKEN: 't', META_ADS_AU_CAMPAIGN_ID: '555', META_ADS_AU_DEFAULT_ADSET_ID: '556', FB_AU_GP_LEAD_FORM_IDS: '777, 778' };
    const au = campaigns.adsCampaigns(env, { auOn: true })[1];
    expect(au).toMatchObject({ configured: true, campaignId: '555', adsetId: '556', leadFormId: '777', leadFormIds: ['777', '778'] });
    const cfg = campaigns.configFor(au, env);
    const uk = metaAds.adsConfig(env);
    expect(cfg).toMatchObject({ campaignId: '555', adsetId: '556', leadFormId: '777', leadLink: 'https://www.mygplink.com.au/australian-gps', accountId: uk.accountId, pageId: uk.pageId, token: 't' });
    expect(campaigns.adsCampaigns({ META_ADS_AU_CAMPAIGN_ID: 'not-a-number' }, { auOn: true })[1].configured).toBe(false);
  });
  it('floors and ceilings: the same checks, with the campaign\'s own numbers when it has them', () => {
    const au = campaigns.australianCampaign({});
    expect(campaigns.limitsFor(au, {})).toEqual(adsActions.limits({}));
    expect(campaigns.limitsFor(au, { ADS_MAX_DAILY_BUDGET: '250', ADS_MIN_LIVE_ADS: '2' })).toEqual(adsActions.limits({ ADS_MAX_DAILY_BUDGET: '250', ADS_MIN_LIVE_ADS: '2' }));
    const own = campaigns.limitsFor(au, { ADS_MAX_DAILY_BUDGET: '250', ADS_AU_MAX_DAILY_BUDGET: '80', ADS_AU_MIN_LIVE_ADS: '3' });
    expect(own).toMatchObject({ maxDailyBudget: 80, minLiveAds: 3, maxBudgetStep: 2 });
    // The check itself is lib/ads-actions.js, unchanged: a budget over the campaign's ceiling is refused.
    const live = { adsets: [{ id: '556', name: 'AU set', effective_status: 'ACTIVE', daily_budget: 50 }], ads: [] };
    const check = adsActions.checkChange({ id: 'c', action: 'set_adset_daily_budget', target_id: '556', daily_budget: 90 }, live, [], own);
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/ceiling/);
    // No action kind was added.
    expect(adsActions.ACTIONS).toEqual(snapshot.lib.actions);
    expect(auContext.AU_ALLOWED_ACTIONS.every((a) => adsActions.ACTIONS.indexOf(a) !== -1)).toBe(true);
  });
});

describe('D. the prompts: the UK brief is today\'s; the Australian one is its own', () => {
  it('no audience, or an audience the hub does not know: the UK prompts, byte for byte', () => {
    expect(adsReview.HOUSE_CONTEXT).toBe(snapshot.lib.house_context);
    for (const audience of [undefined, 'overseas_uk', 'something_else', '']) {
      expect(adsReview.buildReviewMessages({ audience }).system).toBe(snapshot.lib.review_messages.system);
      expect(adsReview.buildBriefMessages({ audience }).system).toBe(snapshot.lib.brief_messages.system);
    }
    expect(parity.captureLib()).toEqual(snapshot.lib);
  });
  it('the Australian review and brief prompts carry the Australian brief and none of the UK one', () => {
    for (const system of [adsReview.buildReviewMessages({ audience: 'au_gp' }).system, adsReview.buildBriefMessages({ audience: 'au_gp' }).system]) {
      expect(system).toContain('ALREADY registered with Ahpra and working in Australia');
      expect(system).toContain('their current employer is not told');
      expect(system).toContain('Never an airport, a suitcase, a passport');
      for (const uk of ['UK-trained GPs in Australian practices', 'QOF', 'CQC', 'Hazel', 'the UK pain', '8am scramble', 'Completely free for doctors', 'AHPRA, the visa']) expect(system, uk).not.toContain(uk);
      expect(system).not.toContain('AHPRA');     // the regulator is written "Ahpra" in new Australian copy
    }
  });
  it('"free for doctors" is in the brief only once the owner has approved it for this audience', () => {
    expect(auContext.houseContext({})).not.toContain('That the service is free for doctors.');
    expect(auContext.houseContext({})).toContain('not approved for this audience yet');
    expect(auContext.houseContext({ freeForDoctorsApproved: true })).toContain('- That the service is free for doctors.');
    expect(auContext.houseContext({ freeForDoctorsApproved: true })).not.toContain('not approved for this audience yet');
  });
  it('what the model is told happens after an Australian lead never mentions the AI caller ringing them', () => {
    const text = auContext.AUTOMATION.join('\n');
    expect(text).toContain('never rings a lead from this campaign');
    expect(text).not.toMatch(/Hazel|UK hours/);
  });
});

describe('D. the net on Australian ad copy', () => {
  const clean = { angle: 'a', image_headline: 'A practice that fits how you work', image_sub: 'A confidential conversation, on your terms.', headline: 'A practice that fits how you work',
    primary_text: 'The billing model, the mix of sessions and the commute can all be different.\n\nA conversation is confidential.\n\nThe first step is a short call with a person.',
    description: 'A confidential first call.', image_prompt: 'A GP walking into a suburban practice in morning sun.' };
  it('clean copy passes; mixed, bulk and private billing may be named', () => {
    expect(auContext.briefViolations(clean)).toEqual([]);
    expect(auContext.adCopyViolations('Bulk billing, mixed billing or private billing: you choose.')).toEqual([]);
    expect(bannedIn(JSON.stringify(clean))).toEqual([]);
  });
  it('each rule trips on its own', () => {
    const trips = {
      'MyIntealth and AMC are handled': /banned word/, 'We sort your visa': /banned word: visa/, 'Relocation support': /banned word/, 'For overseas GPs': /banned word: overseas/,
      'Earn $350,000': /pay figure/, 'Keep 70% of billings': /pay figure/, 'A 70/30 split': /pay figure/, 'Earn more this year': /pay figure/, 'A better salary': /pay figure/, 'Up to 400k': /pay figure/,
      'A guaranteed offer': /guarantee/, 'We promise an interview': /guarantee/,
      'Completely free for doctors.': /free for doctors/, 'It costs you nothing': /free for doctors/,
      'For UK-trained GPs': /somewhere else/, 'Leaving the NHS?': /somewhere else/, 'Sponsorship available': /somewhere else/,
      'No 19AB restrictions': /regulatory/, 'DPA roles': /regulatory/, 'No supervision needed': /regulatory/,
      'Hazel will ring you': /automated caller/
    };
    for (const text of Object.keys(trips)) {
      const got = auContext.adCopyViolations(text).join(' | ');
      expect(got, text).toMatch(trips[text]);
    }
  });
  it('"free for doctors" passes only when approved; nothing else is loosened by that', () => {
    expect(auContext.adCopyViolations('Free for doctors.', { freeForDoctorsApproved: true })).toEqual([]);
    expect(auContext.adCopyViolations('Free for doctors. Earn $300k.', { freeForDoctorsApproved: true }).length).toBe(1);
  });
  it('a brief that trips is dropped whole, never edited; action kinds outside the five are removed', () => {
    const dirty = Object.assign({}, clean, { angle: 'b', description: 'Guaranteed interviews.' });
    const out = auContext.netReview({
      headline: 'h', summary: 's', new_ad_briefs: [clean, dirty],
      account_changes: [{ id: '1', action: 'pause_ad' }, { id: '2', action: 'launch_draft' }, { id: '3', action: 'create_ad' }, { id: '4', action: 'delete_campaign' }, { id: '5', action: 'set_adset_daily_budget' }],
      automation_changes: [{ lever: 'hazel.max_attempts', value: 3 }]
    });
    expect(out.review.new_ad_briefs).toEqual([clean]);
    expect(out.review.account_changes.map((c) => c.id)).toEqual(['1', '5']);
    expect(out.review.automation_changes).toEqual([]);
    expect(out.dropped.map((d) => d.kind)).toEqual(['brief', 'account_change', 'account_change', 'account_change', 'automation_changes']);
    expect(out.dropped[0]).toEqual({ kind: 'brief', id: 'b', reasons: ['description: a guarantee'] });
  });
});
