// Coverage for lib/ads-review.js — the model's side of the Ads hub: prompt
// builders, JSON extraction and normalisation, and the raw-HTTP Claude call.
// Same CJS interop as tests/meta-capi.test.js; the Messages API is exercised
// through an injected fetchImpl, so no key and no network. The snapshot the
// prompts are built from is assembled by lib/meta-ads.js from the Graph fixture.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const review = require('../lib/ads-review.js');
const meta = require('../lib/meta-ads.js');
const fx = require('./fixtures/meta-ads-graph.js');

const SNAPSHOT = meta.assembleSnapshot({
  config: meta.adsConfig({}), now: fx.NOW, adsets: fx.adsets, ads: fx.ads, insights: fx.insights, daily: fx.daily, leadRows: fx.leadRows
});

// callClaude() falls back to process.env.ANTHROPIC_API_KEY; the "no key" test
// needs it absent, and every other test passes apiKey explicitly.
let savedKey;
beforeAll(() => { savedKey = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY; });
afterAll(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

// A Messages API stand-in: records each call (parsed body) and answers with
// whatever the handler returns for that call number: { status?, json? }.
function claudeStub(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const out = (handler && handler(call, calls.length)) || {};
    const status = out.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => out.json };
  };
  return { impl, calls };
}

function reply(text, extra) {
  return {
    json: Object.assign({
      id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5-20261001', stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 }
    }, extra || {})
  };
}

function apiError(status, message, type) {
  return { status, json: { type: 'error', error: { type: type || 'invalid_request_error', message } } };
}

const CLOSER = 'Completely free for doctors.';
const BRIEF_OK = {
  angle: '05-duty-day',
  image_headline: 'Duty day. Every day.',
  image_sub: 'Australia is hiring UK-trained GPs.',
  headline: 'Duty day. Every day.',
  primary_text: 'The duty list fills before you have sat down.\n\nMost Australian practices run fifteen-minute consults as standard.\n\nIf you\'re UK-trained there\'s a recognised route to practising in Australia. Book a free 30-minute call. ' + CLOSER,
  description: 'UK-trained GPs. Free 30-minute call.',
  image_prompt: 'Documentary photograph, morning light through a consulting room window, no people facing camera, 4:5.',
  rationale: 'Applies imp-1: a jargon headline a GP self-selects on.',
  improvements_applied: ['imp-1']
};
const REVIEW_OK = {
  headline: 'A steady week with bookings holding up.',
  summary: 'Spend rose on last week and leads rose with it. The before/after split ad is below the click-to-lead rule. Bookings sit in two ads.',
  actions_today: [
    { action: 'Pause 01-no-qof before', why: 'Only 2.7% of link clicks became leads over 7 days.', where: 'ads_manager' },
    { action: 'Launch one fresh jargon creative', why: 'Keeps three ads live after the pause.', where: 'this_page' }
  ],
  ad_verdicts: [
    { ad_id: '120249238461530648', verdict: 'pause', reason: 'Below the 4% click-to-lead rule.' },
    { ad_id: '120249238461490648', verdict: 'keep', reason: 'Cheapest bookings this week.' }
  ],
  improvements: [
    { id: 'imp-1', title: 'Lead with profession jargon', evidence: 'The jargon line booked 13 of 34.', change: 'Put QOF or CQC in the image headline.', applies_to: 'headline', priority: 1 },
    { id: 'imp-2', title: 'Sunny after-state image', evidence: 'The sunny practice image outperformed the UK pain image.', change: 'Brief the image as Australian daylight.', applies_to: 'image', priority: 2 }
  ],
  new_ad_briefs: [BRIEF_OK]
};

function keysDeep(v, acc) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { acc.add(k); keysDeep(v[k], acc); });
  return acc;
}

describe('schemas', () => {
  it('use none of the JSON Schema keywords the Messages API rejects inside output_config.format', () => {
    ['REVIEW_SCHEMA', 'BRIEFS_SCHEMA', 'ITERATE_SCHEMA', 'BRIEF_SCHEMA'].forEach((name) => {
      const keys = keysDeep(review[name], new Set());
      ['maxItems', 'minimum', 'maximum', '$ref', '$defs'].forEach((bad) => {
        expect(keys.has(bad), name + ' must not use ' + bad).toBe(false);
      });
      expect(JSON.parse(JSON.stringify(review[name]))).toEqual(review[name]);
      expect(review[name].type).toBe('object');
      expect(review[name].additionalProperties).toBe(false);
    });
    expect(review.BRIEFS_SCHEMA.properties.ads.items).toBe(review.BRIEF_SCHEMA);
    expect(review.REVIEW_SCHEMA.properties.new_ad_briefs.items).toBe(review.BRIEF_SCHEMA);
    expect(review.REVIEW_SCHEMA.required).toEqual(['headline', 'summary', 'actions_today', 'ad_verdicts', 'improvements', 'new_ad_briefs']);
    expect(review.DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(review.MESSAGES_URL).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('compactSnapshot', () => {
  const c = review.compactSnapshot(SNAPSHOT);

  it('splits live from paused ads and keeps the shared sections by reference', () => {
    expect(c.live_ads).toHaveLength(7);
    expect(c.paused_ads).toHaveLength(2);
    c.live_ads.forEach((a) => expect(a.status).toBe('ACTIVE'));
    expect(c.paused_ads.map((a) => a.status).sort()).toEqual(['ADSET_PAUSED', 'PAUSED']);
    expect(c.fetched_at).toBe('2026-10-29T02:00:00.000Z');
    expect(c.time_zone).toBe('Australia/Melbourne');
    expect(c.currency).toBe('AUD');
    expect(c.totals).toBe(SNAPSHOT.totals);
    expect(c.app_funnel).toBe(SNAPSHOT.funnel);
    expect(c.app_funnel_unattributed).toBe(SNAPSHOT.funnel_unattributed);
    expect(c.daily_last_14_days).toBe(SNAPSHOT.daily);
    expect(c.data_problems).toEqual([]);
    expect(c.ad_sets).toEqual([
      { id: fx.ADSET_LIVE, name: fx.adsets[0].name, status: 'ACTIVE', daily_budget: 100, goal: 'QUALITY_LEAD', learning: { status: 'LEARNING', exit_reason: null, last_edit_at: '2026-10-26T11:03:02.000Z' } },
      { id: fx.ADSET_OLD, name: fx.adsets[1].name, status: 'PAUSED', daily_budget: 100, goal: 'QUALITY_LEAD', learning: { status: null, exit_reason: null, last_edit_at: '2026-10-21T13:15:38.000Z' } }
    ]);
  });

  it('compacts a live ad to the fields the model needs, flags as labels', () => {
    const top = c.live_ads[0];
    expect(Object.keys(top)).toEqual(['ad_id', 'name', 'status', 'ad_set', 'days_live', 'headline', 'description', 'primary_text', 'cta', 'yesterday', 'last_7d', 'last_30d', 'app_funnel_7d', 'app_funnel_30d', 'flags']);
    expect(top).toMatchObject({
      ad_id: '120249238461530648', name: '"01-no-qof · before"', status: 'ACTIVE', ad_set: fx.adsets[0].name, days_live: 7,
      headline: 'No QOF. No CQC. No 8am scramble.', description: 'UK-trained GPs. Free 30-minute call.', cta: 'Book now',
      flags: ['Only 2.7% of link clicks became leads (rule: pause below 4%)']
    });
    expect(top.primary_text).toBe(fx.ads[0].creative.body);
    expect(top.last_7d).toBe(SNAPSHOT.ads[0].metrics.last_7d);
    expect(top.app_funnel_7d).toEqual({ leads: 2, qualified: 2, booked: 1, signed_up: 0, cost_per_booking: 228.81 });
    expect(review.compactAd({ creative: { cta: 'LEARN_MORE' } }).cta).toBe('LEARN_MORE');
    expect(review.compactAd(null).flags).toEqual([]);
  });

  it('drops primary text and yesterday from paused ads', () => {
    c.paused_ads.forEach((a) => {
      expect(a).not.toHaveProperty('primary_text');
      expect(a).not.toHaveProperty('yesterday');
      expect(a).toHaveProperty('last_7d');
      expect(a).toHaveProperty('last_30d');
      expect(a).toHaveProperty('headline');
    });
    c.live_ads.forEach((a) => {
      expect(typeof a.primary_text).toBe('string');
      expect(a).toHaveProperty('yesterday');
    });
  });

  it('truncates primary text to 420 characters with an ellipsis', () => {
    const long = review.compactAd({ id: 'x', effective_status: 'ACTIVE', creative: { primary_text: 'a'.repeat(1000) } });
    expect(long.primary_text).toHaveLength(420);
    expect(long.primary_text.endsWith('…')).toBe(true);
    expect(long.primary_text.slice(0, 419)).toBe('a'.repeat(419));
    expect(review.compactAd({ creative: { primary_text: 'b'.repeat(420) } }).primary_text).toBe('b'.repeat(420));
    expect(review.compactAd({ creative: {} }).primary_text).toBe('');
  });

  it('copes with an empty snapshot', () => {
    expect(review.compactSnapshot(undefined)).toMatchObject({ live_ads: [], paused_ads: [], ad_sets: [] });
    expect(review.compactSnapshot({ ads: null, errors: ['x'] }).data_problems).toEqual(['x']);
  });
});

describe('buildReviewMessages', () => {
  it('system prompt judges by cost per booking and applies the rotation rule', () => {
    const m = review.buildReviewMessages({ snapshot: SNAPSHOT, today: '2026-10-29' });
    expect(m.system).toContain('cost per BOOKING');
    expect(m.system).toContain('rotation rule');
    expect(m.system).toContain('pause an ad when its 7-day frequency is above 3');
    expect(m.system).toContain('ACCOUNT CONTEXT\n' + review.HOUSE_CONTEXT);
    expect(m.system).toContain('Never invent a number');
  });

  it('user prompt carries the date, the time zone and the compact snapshot as JSON', () => {
    const m = review.buildReviewMessages({ snapshot: SNAPSHOT, today: '2026-10-29' });
    expect(m.user.startsWith('Today is 2026-10-29 (Australia/Melbourne).')).toBe(true);
    expect(m.user).toContain(JSON.stringify(review.compactSnapshot(SNAPSHOT)));
    expect(m.user).toContain('"120249238461530648"');
    expect(m.user).not.toContain('Yesterday\'s improvements');
    expect(m.user.endsWith('Return the review as JSON matching the schema.')).toBe(true);
  });

  it('adds yesterday\'s improvements (id, title, change only) when given', () => {
    const prev = { improvements: [{ id: 'imp-1', title: 'Lead with jargon', change: 'Put QOF in the headline', evidence: 'kept-private', priority: 1 }] };
    const m = review.buildReviewMessages({ snapshot: SNAPSHOT, today: '2026-10-29', previousReview: prev });
    expect(m.user).toContain('Yesterday\'s improvements, for continuity');
    expect(m.user).toContain(JSON.stringify([{ id: 'imp-1', title: 'Lead with jargon', change: 'Put QOF in the headline' }]));
    expect(m.user).not.toContain('kept-private');
    const none = review.buildReviewMessages({ snapshot: SNAPSHOT, today: '2026-10-29', previousReview: { improvements: [] } });
    expect(none.user).not.toContain('Yesterday\'s improvements');
  });

  it('defaults the date to today and the zone to Melbourne', () => {
    const m = review.buildReviewMessages({});
    expect(m.user).toMatch(/^Today is \d{4}-\d{2}-\d{2} \(Australia\/Melbourne\)\./);
    expect(m.user).toContain(JSON.stringify(review.compactSnapshot(undefined)));
  });
});

describe('buildBriefMessages', () => {
  const imps = [{ id: 'imp-1', title: 'T1', change: 'C1', evidence: 'E1', priority: 1, applies_to: 'headline' }];

  it('clamps the count to 1..6 and defaults to 3', () => {
    expect(review.buildBriefMessages({ count: 2 }).user.startsWith('Write 2 new ads.')).toBe(true);
    expect(review.buildBriefMessages({ count: 10 }).user.startsWith('Write 6 new ads.')).toBe(true);
    expect(review.buildBriefMessages({ count: -5 }).user.startsWith('Write 1 new ad.')).toBe(true);
    expect(review.buildBriefMessages({ count: 1 }).user.startsWith('Write 1 new ad.')).toBe(true);
    expect(review.buildBriefMessages({}).user.startsWith('Write 3 new ads.')).toBe(true);
    expect(review.buildBriefMessages({ count: 'lots' }).user.startsWith('Write 3 new ads.')).toBe(true);
    expect(review.buildBriefMessages(undefined).user.startsWith('Write 3 new ads.')).toBe(true);
  });

  it('serialises the improvements, the review summary and the owner\'s instructions', () => {
    const m = review.buildBriefMessages({ count: 2, improvements: imps, review: { summary: 'Leads up on last week.' }, instructions: 'Make one about appraisal.' });
    expect(m.user).toContain('IMPROVEMENTS TO APPLY\n' + JSON.stringify([{ id: 'imp-1', title: 'T1', change: 'C1', evidence: 'E1' }]));
    expect(m.user).not.toContain('"priority"');
    expect(m.user).toContain('THIS MORNING\'S REVIEW\nLeads up on last week.');
    expect(m.user).toContain('OWNER\'S INSTRUCTIONS (take precedence over everything except the creative rules)\nMake one about appraisal.');
    expect(m.user.endsWith('Return JSON matching the schema.')).toBe(true);
    expect(m.system).toContain('You write Meta lead ads for GP Link');
    expect(m.system).toContain(CLOSER);
    expect(m.system).toContain('ACCOUNT CONTEXT\n' + review.HOUSE_CONTEXT);
  });

  it('lists the live ads\' headlines with their lead and booking counts, not the paused ones', () => {
    const m = review.buildBriefMessages({ improvements: imps, snapshot: SNAPSHOT });
    expect(m.user).toContain('LIVE ADS (do not duplicate these headlines; learn from what books)');
    expect(m.user).toContain(JSON.stringify({ headline: 'Australia is hiring UK-trained GPs.', leads_7d: 5, booked_30d: 4, cost_per_lead_7d: 41.72 }));
    expect(m.user).toContain(JSON.stringify({ headline: 'CQC inspection on Tuesday.', leads_7d: 0, booked_30d: 0, cost_per_lead_7d: null }));
    expect(m.user).not.toContain('Paid on your billings.');
    const liveList = JSON.parse(m.user.split('LIVE ADS (do not duplicate these headlines; learn from what books)\n')[1].split('\n')[0]);
    expect(liveList).toHaveLength(7);
  });

  it('lists the drafts already on the page by angle and headline', () => {
    const m = review.buildBriefMessages({ improvements: imps, existingDrafts: [{ angle: '05-duty-day', headline: 'Duty day', primary_text: 'kept-private' }] });
    expect(m.user).toContain('DRAFTS ALREADY ON THE PAGE (do not repeat these angles)\n' + JSON.stringify([{ angle: '05-duty-day', headline: 'Duty day' }]));
    expect(m.user).not.toContain('kept-private');
  });

  it('leaves the optional sections out when there is nothing for them', () => {
    const m = review.buildBriefMessages({ count: 3 });
    expect(m.user).toContain('IMPROVEMENTS TO APPLY\n[]');
    expect(m.user).not.toContain('THIS MORNING\'S REVIEW');
    expect(m.user).not.toContain('OWNER\'S INSTRUCTIONS');
    expect(m.user).not.toContain('LIVE ADS');
    expect(m.user).not.toContain('DRAFTS ALREADY ON THE PAGE');
    const noLive = review.buildBriefMessages({ snapshot: { ads: SNAPSHOT.ads.filter((a) => a.effective_status !== 'ACTIVE') } });
    expect(noLive.user).not.toContain('LIVE ADS');
  });
});

describe('buildIterateMessages', () => {
  it('sends the current ad fields and the owner\'s instruction under the brief system prompt', () => {
    const draft = Object.assign({}, BRIEF_OK, { id: 'draft-1', status: 'draft', rationale: 'kept-private' });
    const m = review.buildIterateMessages({ draft, instruction: 'Shorten the headline.' });
    expect(m.user).toContain('CURRENT AD\n' + JSON.stringify({
      angle: BRIEF_OK.angle, image_headline: BRIEF_OK.image_headline, image_sub: BRIEF_OK.image_sub,
      headline: BRIEF_OK.headline, primary_text: BRIEF_OK.primary_text, description: BRIEF_OK.description, image_prompt: BRIEF_OK.image_prompt
    }));
    expect(m.user).toContain('OWNER\'S INSTRUCTION\nShorten the headline.');
    expect(m.user).toContain('Change only what the instruction needs');
    expect(m.user).not.toContain('kept-private');
    expect(m.user).not.toContain('draft-1');
    expect(m.user.endsWith('Return JSON matching the schema.')).toBe(true);
    expect(m.system).toBe(review.buildBriefMessages({}).system);
    expect(review.buildIterateMessages({}).user).toContain('OWNER\'S INSTRUCTION\n');
  });
});

describe('extractJson', () => {
  it('parses plain, fenced and prose-wrapped JSON, and returns null otherwise', () => {
    expect(review.extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(review.extractJson('  {"a":1}\n')).toEqual({ a: 1 });
    expect(review.extractJson('```json\n{"a":1,"b":[2]}\n```')).toEqual({ a: 1, b: [2] });
    expect(review.extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(review.extractJson('Here is the review:\n\n{"a":{"b":1}}\n\nLet me know.')).toEqual({ a: { b: 1 } });
    expect(review.extractJson('Sure. ```json\n{"a":1}\n``` Done.')).toEqual({ a: 1 });
    expect(review.extractJson('nope')).toBeNull();
    expect(review.extractJson('')).toBeNull();
    expect(review.extractJson(null)).toBeNull();
    expect(review.extractJson('text { not json }')).toBeNull();
    expect(review.extractJson('```json\n{broken\n```')).toBeNull();
    expect(review.extractJson('[1,2]')).toEqual([1, 2]);
  });
});

describe('normaliseReview', () => {
  it('keeps a well-formed review as it is, with no warnings', () => {
    const r = review.normaliseReview(REVIEW_OK);
    expect(r.headline).toBe(REVIEW_OK.headline);
    expect(r.summary).toBe(REVIEW_OK.summary);
    expect(r.actions_today).toEqual(REVIEW_OK.actions_today);
    expect(r.ad_verdicts).toEqual(REVIEW_OK.ad_verdicts);
    expect(r.improvements).toEqual(REVIEW_OK.improvements);
    expect(r.new_ad_briefs).toEqual([review.normaliseBrief(BRIEF_OK, 0)]);
    expect(r.warnings).toEqual([]);
  });

  it('regenerates ids that are not imp-N and makes duplicates unique', () => {
    const r = review.normaliseReview({ improvements: [{ id: 'first' }, { id: 'imp-7' }, { id: 7 }, {}, { id: 'imp-7' }, { id: 'imp-1' }] });
    expect(r.improvements.map((x) => x.id)).toEqual(['imp-1', 'imp-7', 'imp-3', 'imp-4', 'imp-5b', 'imp-6b']);
    expect(new Set(r.improvements.map((x) => x.id)).size).toBe(6);
  });

  it('clamps priority to 1..3 (2 when missing) and falls back applies_to to angle', () => {
    const r = review.normaliseReview({ improvements: [{ priority: 5 }, { priority: -2 }, {}, { priority: '3' }, { priority: 1.7, applies_to: 'image' }, { applies_to: 'everything' }] });
    expect(r.improvements.map((x) => x.priority)).toEqual([3, 1, 2, 3, 1.7, 2]);
    expect(r.improvements.map((x) => x.applies_to)).toEqual(['angle', 'angle', 'angle', 'angle', 'image', 'angle']);
  });

  it('falls back to watch for an unknown verdict and none for an unknown place', () => {
    const r = review.normaliseReview({
      ad_verdicts: [{ ad_id: '1', verdict: 'kill', reason: 'x' }, { ad_id: 2, verdict: 'scale' }, { verdict: 'keep' }],
      actions_today: [{ action: 'Do it', where: 'slack' }, { action: 'Go', where: 'follow_up' }, { why: 'no action text' }]
    });
    expect(r.ad_verdicts).toEqual([{ ad_id: '1', verdict: 'watch', reason: 'x' }, { ad_id: '2', verdict: 'scale', reason: '' }]);
    expect(r.actions_today).toEqual([{ action: 'Do it', why: '', where: 'none' }, { action: 'Go', why: '', where: 'follow_up' }]);
  });

  it('caps at 8 improvements, 4 briefs and 6 actions', () => {
    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const r = review.normaliseReview({
      improvements: many(12, (i) => ({ id: 'imp-' + (i + 1), title: 'T' + i })),
      new_ad_briefs: many(6, (i) => Object.assign({}, BRIEF_OK, { angle: 'angle-' + i })),
      actions_today: many(9, (i) => ({ action: 'A' + i, where: 'none' }))
    });
    expect(r.improvements).toHaveLength(8);
    expect(r.improvements[7].id).toBe('imp-8');
    expect(r.new_ad_briefs).toHaveLength(4);
    expect(r.new_ad_briefs.map((b) => b.angle)).toEqual(['angle-0', 'angle-1', 'angle-2', 'angle-3']);
    expect(r.actions_today).toHaveLength(6);
    expect(r.actions_today[5].action).toBe('A5');
  });

  it('warns, per brief, about em dashes, a missing closer and money figures', () => {
    const r = review.normaliseReview({
      new_ad_briefs: [
        Object.assign({}, BRIEF_OK, { headline: 'Duty day — every day', primary_text: 'Earn $300k. No closer here.' }),
        BRIEF_OK,
        Object.assign({}, BRIEF_OK, { image_sub: 'A — B', primary_text: 'Around £120,000 a year. ' + CLOSER })
      ]
    });
    expect(r.warnings).toEqual([
      'Brief 1: headline contains an em dash.',
      'Brief 1: primary_text does not end with "Completely free for doctors."',
      'Brief 1: copy appears to contain a money figure.',
      'Brief 3: image_sub contains an em dash.',
      'Brief 3: copy appears to contain a money figure.'
    ]);
  });

  it('trims and length-limits the prose fields and tolerates garbage', () => {
    const r = review.normaliseReview({ headline: '  ' + 'h'.repeat(400), summary: 's'.repeat(3000), improvements: 'nope', actions_today: null, ad_verdicts: 7 });
    expect(r.headline).toHaveLength(300);
    expect(r.headline.endsWith('…')).toBe(true);
    expect(r.summary).toHaveLength(2500);
    expect(r.improvements).toEqual([]);
    expect(r.actions_today).toEqual([]);
    expect(r.ad_verdicts).toEqual([]);
    expect(review.normaliseReview(undefined)).toEqual({ headline: '', summary: '', actions_today: [], ad_verdicts: [], improvements: [], new_ad_briefs: [], warnings: [] });
  });
});

describe('normaliseBrief and briefWarnings', () => {
  it('slugs the angle, falls back to ad-N, and fills the headline from the image headline', () => {
    const b = review.normaliseBrief({ angle: 'Appraisal Season!!', image_headline: '  Appraisal. Gone.  ', improvements_applied: ['imp-1', '', 7, null] }, 2);
    expect(b.angle).toBe('appraisal-season');
    expect(b.image_headline).toBe('Appraisal. Gone.');
    expect(b.headline).toBe('Appraisal. Gone.');
    expect(b.improvements_applied).toEqual(['imp-1', '7']);
    expect(b).toEqual({ angle: 'appraisal-season', image_headline: 'Appraisal. Gone.', image_sub: '', headline: 'Appraisal. Gone.', primary_text: '', description: '', image_prompt: '', rationale: '', improvements_applied: ['imp-1', '7'] });
    expect(review.normaliseBrief({}, 2).angle).toBe('ad-3');
    expect(review.normaliseBrief(null, 0).angle).toBe('ad-1');
    expect(review.normaliseBrief({ angle: 'a'.repeat(60) }, 0).angle).toHaveLength(40);
    expect(review.normaliseBrief({ improvements_applied: 'imp-1' }, 0).improvements_applied).toEqual([]);
    expect(review.normaliseBrief(BRIEF_OK, 0)).toEqual(BRIEF_OK);
  });

  it('limits the field lengths', () => {
    const b = review.normaliseBrief({ image_headline: 'x'.repeat(200), primary_text: 'y'.repeat(4000), image_prompt: 'z'.repeat(2000), rationale: 'r'.repeat(1000) }, 0);
    expect(b.image_headline).toHaveLength(120);
    expect(b.primary_text).toHaveLength(3000);
    expect(b.image_prompt).toHaveLength(1200);
    expect(b.rationale).toHaveLength(600);
  });

  it('briefWarnings checks the brand rules the model most often breaks', () => {
    expect(review.briefWarnings(BRIEF_OK)).toEqual([]);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { description: 'UK GPs — free call' }))).toEqual(['description contains an em dash.']);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { primary_text: 'Completely free for doctors. Book today.' }))).toEqual(['primary_text does not end with "Completely free for doctors."']);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { primary_text: 'Short. completely free for doctors' }))).toEqual([]);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { primary_text: 'Short. ' + CLOSER + '  \n' }))).toEqual([]);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { image_headline: 'x'.repeat(46) }))).toEqual(['image_headline is over 45 characters.']);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { image_headline: 'x'.repeat(45) }))).toEqual([]);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { headline: 'Earn €200 a session' }))).toEqual(['copy appears to contain a money figure.']);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { primary_text: 'About 120,000 patients. ' + CLOSER }))).toEqual(['copy appears to contain a money figure.']);
    expect(review.briefWarnings(Object.assign({}, BRIEF_OK, { primary_text: 'Opens at 8am, 15 minutes each. ' + CLOSER }))).toEqual([]);
    expect(review.briefWarnings(undefined)).toEqual(['primary_text does not end with "Completely free for doctors."']);
  });
});

describe('callClaude', () => {
  it('refuses without a key, before any network call', async () => {
    const stub = claudeStub(() => reply('{}'));
    expect(await review.callClaude({ fetchImpl: stub.impl, system: 's', user: 'u' })).toEqual({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' });
    expect(await review.callClaude({ apiKey: '   ', fetchImpl: stub.impl })).toEqual({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' });
    expect(stub.calls).toHaveLength(0);
  });

  it('posts a non-streaming Messages request: Opus, medium effort, cached system, JSON schema format', async () => {
    const stub = claudeStub(() => reply('{"ok":true}'));
    const r = await review.callClaude({ apiKey: 'key-1', fetchImpl: stub.impl, system: 'SYS', user: 'USER', schema: review.ITERATE_SCHEMA });
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'x-api-key': 'key-1', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(call.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 24000,
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'USER' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: review.ITERATE_SCHEMA } }
    });
    expect(r).toEqual({
      ok: true, model: 'claude-opus-5-5-20261001', stop_reason: 'end_turn', text: '{"ok":true}', json: { ok: true }, formatFallback: false,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 }
    });
  });

  it('honours model, effort, max_tokens and url overrides, and sends no format without a schema', async () => {
    const stub = claudeStub(() => reply('{}'));
    await review.callClaude({ apiKey: 'k', fetchImpl: stub.impl, system: 's', user: 'u', model: 'claude-sonnet-4-5', effort: 'high', maxTokens: 4000, url: 'http://127.0.0.1:9/v1/messages' });
    const call = stub.calls[0];
    expect(call.url).toBe('http://127.0.0.1:9/v1/messages');
    expect(call.body.model).toBe('claude-sonnet-4-5');
    expect(call.body.max_tokens).toBe(4000);
    expect(call.body.output_config).toEqual({ effort: 'high' });
    expect(call.body.output_config.format).toBeUndefined();
  });

  it('retries once without the format when the API rejects output_config, and flags the fallback', async () => {
    const stub = claudeStub((call, n) => (n === 1
      ? apiError(400, 'output_config.format.schema: For \'array\' type, property \'maxItems\' is not supported')
      : reply('{"a":1}')));
    const r = await review.callClaude({ apiKey: 'k', fetchImpl: stub.impl, system: 's', user: 'u', schema: review.REVIEW_SCHEMA });
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].body.output_config.format).toEqual({ type: 'json_schema', schema: review.REVIEW_SCHEMA });
    expect(stub.calls[1].body.output_config).toEqual({ effort: 'medium' });
    expect(stub.calls[1].body.output_config.format).toBeUndefined();
    expect(stub.calls[1].body.messages).toEqual(stub.calls[0].body.messages);
    expect(r.ok).toBe(true);
    expect(r.formatFallback).toBe(true);
    expect(r.json).toEqual({ a: 1 });
  });

  it('does not retry other 400s, non-400s, or a second time', async () => {
    const other = claudeStub(() => apiError(400, 'max_tokens: must be a positive integer'));
    const r1 = await review.callClaude({ apiKey: 'k', fetchImpl: other.impl, system: 's', user: 'u', schema: review.REVIEW_SCHEMA });
    expect(other.calls).toHaveLength(1);
    expect(r1).toMatchObject({ ok: false, status: 400, error: 'max_tokens: must be a positive integer' });

    const overloaded = claudeStub(() => apiError(529, 'Overloaded', 'overloaded_error'));
    const r2 = await review.callClaude({ apiKey: 'k', fetchImpl: overloaded.impl, system: 's', user: 'u', schema: review.REVIEW_SCHEMA });
    expect(overloaded.calls).toHaveLength(1);
    expect(r2).toMatchObject({ ok: false, status: 529, error: 'Overloaded' });

    const serverSchema = claudeStub(() => apiError(500, 'schema compiler crashed', 'api_error'));
    await review.callClaude({ apiKey: 'k', fetchImpl: serverSchema.impl, system: 's', user: 'u', schema: review.REVIEW_SCHEMA });
    expect(serverSchema.calls).toHaveLength(1);

    const twice = claudeStub((call, n) => apiError(400, 'output_config.format is not supported on this model (' + n + ')'));
    const r4 = await review.callClaude({ apiKey: 'k', fetchImpl: twice.impl, system: 's', user: 'u', schema: review.REVIEW_SCHEMA });
    expect(twice.calls).toHaveLength(2);
    expect(r4.ok).toBe(false);
    expect(r4.error).toBe('output_config.format is not supported on this model (2)');
    expect(r4.formatFallback).toBeUndefined();

    const noBody = claudeStub(() => ({ status: 401, json: null }));
    const r5 = await review.callClaude({ apiKey: 'k', fetchImpl: noBody.impl, system: 's', user: 'u' });
    expect(r5).toEqual({ ok: false, status: 401, error: 'HTTP 401', data: null });
  });

  it('fails when the model runs out of room', async () => {
    const stub = claudeStub(() => reply('{"headline":"cut off', { stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 24000 } }));
    const r = await review.callClaude({ apiKey: 'k', fetchImpl: stub.impl, system: 's', user: 'u' });
    expect(r).toEqual({ ok: false, error: 'The model ran out of room before finishing (max_tokens).', stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 24000 } });
  });

  it('fails, saying the model declined, on a refusal', async () => {
    const withCategory = claudeStub(() => reply('', { stop_reason: 'refusal', stop_details: { category: 'policy' } }));
    const r1 = await review.callClaude({ apiKey: 'k', fetchImpl: withCategory.impl, system: 's', user: 'u' });
    expect(r1).toEqual({ ok: false, error: 'The model declined this request (policy).', stop_reason: 'refusal' });
    const bare = claudeStub(() => reply('', { stop_reason: 'refusal' }));
    const r2 = await review.callClaude({ apiKey: 'k', fetchImpl: bare.impl, system: 's', user: 'u' });
    expect(r2.error).toBe('The model declined this request (refusal).');
    expect(r2.error).toContain('declined');
  });

  it('joins the text blocks, ignores thinking blocks, and extracts the JSON', async () => {
    const stub = claudeStub(() => reply('', {
      content: [
        { type: 'thinking', thinking: 'Working it out.', signature: 'sig' },
        { type: 'text', text: 'Here is the review:\n```json\n{"headline":' },
        { type: 'text', text: '"Steady week"}\n```' }
      ]
    }));
    const r = await review.callClaude({ apiKey: 'k', fetchImpl: stub.impl, system: 's', user: 'u' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Here is the review:\n```json\n{"headline":\n"Steady week"}\n```');
    expect(r.json).toEqual({ headline: 'Steady week' });
  });

  it('copies the usage numbers and zero-fills what is missing', async () => {
    const full = claudeStub(() => reply('{}'));
    const r1 = await review.callClaude({ apiKey: 'k', fetchImpl: full.impl, system: 's', user: 'u' });
    expect(r1.usage).toEqual({ input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 });
    const partial = claudeStub(() => reply('{}', { usage: { input_tokens: '7' } }));
    const r2 = await review.callClaude({ apiKey: 'k', fetchImpl: partial.impl, system: 's', user: 'u' });
    expect(r2.usage).toEqual({ input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const none = claudeStub(() => reply('{}', { usage: undefined, model: undefined }));
    const r3 = await review.callClaude({ apiKey: 'k', fetchImpl: none.impl, system: 's', user: 'u' });
    expect(r3.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(r3.model).toBe('claude-opus-5-5');
  });

  it('reports a thrown fetch as a network error, with a single attempt', async () => {
    let attempts = 0;
    const r = await review.callClaude({ apiKey: 'k', fetchImpl: async () => { attempts++; throw new Error('ECONNRESET'); }, system: 's', user: 'u', schema: review.REVIEW_SCHEMA });
    expect(r).toEqual({ ok: false, error: 'Could not reach the model: ECONNRESET', network: true });
    expect(attempts).toBe(1);
  });

  it('tolerates a 200 whose body is not JSON (ok, no json, empty text)', async () => {
    const r = await review.callClaude({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }), system: 's', user: 'u' });
    expect(r.ok).toBe(true);
    expect(r.json).toBeNull();
    expect(r.text).toBe('');
  });
});

describe('runDailyReview', () => {
  it('builds the review prompt, asks with the review schema and normalises the answer', async () => {
    const stub = claudeStub(() => reply(JSON.stringify(REVIEW_OK)));
    const r = await review.runDailyReview({
      apiKey: 'k', fetchImpl: stub.impl, snapshot: SNAPSHOT, today: '2026-10-29',
      previousReview: { improvements: [{ id: 'imp-9', title: 'Old point', change: 'x' }] }
    });
    expect(r.ok).toBe(true);
    expect(r.review).toEqual(review.normaliseReview(REVIEW_OK));
    expect(r.review.warnings).toEqual([]);
    expect(r.usage).toEqual({ input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 });
    expect(r.model).toBe('claude-opus-5-5-20261001');
    expect(r.formatFallback).toBe(false);
    expect(r.text).toBe(JSON.stringify(REVIEW_OK));
    expect(stub.calls).toHaveLength(1);
    const body = stub.calls[0].body;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: review.REVIEW_SCHEMA } });
    expect(body.system[0].text).toContain('cost per BOOKING');
    expect(body.messages[0].content.startsWith('Today is 2026-10-29 (Australia/Melbourne).')).toBe(true);
    expect(body.messages[0].content).toContain('Old point');
    expect(body.messages[0].content).toContain(JSON.stringify(review.compactSnapshot(SNAPSHOT)));
  });

  it('fails plainly when the model returns prose instead of JSON, or the API errors', async () => {
    const prose = claudeStub(() => reply('I cannot produce a review from this data today.'));
    const r1 = await review.runDailyReview({ apiKey: 'k', fetchImpl: prose.impl, snapshot: SNAPSHOT, today: '2026-10-29' });
    expect(r1).toEqual({ ok: false, error: 'The model did not return JSON.', text: 'I cannot produce a review from this data today.', usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 900, cache_creation_input_tokens: 300 }, model: 'claude-opus-5-5-20261001' });
    const denied = claudeStub(() => apiError(401, 'invalid x-api-key', 'authentication_error'));
    const r2 = await review.runDailyReview({ apiKey: 'k', fetchImpl: denied.impl, snapshot: SNAPSHOT });
    expect(r2).toMatchObject({ ok: false, status: 401, error: 'invalid x-api-key' });
    expect(await review.runDailyReview({ fetchImpl: prose.impl, snapshot: SNAPSHOT })).toEqual({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' });
  });
});

describe('generateBriefs', () => {
  it('asks with the briefs schema and returns normalised briefs with per-brief warnings', async () => {
    const second = Object.assign({}, BRIEF_OK, { angle: 'Appraisal Season', image_headline: 'Appraisal — gone.', headline: 'Appraisal — gone.' });
    const stub = claudeStub(() => reply(JSON.stringify({ ads: [BRIEF_OK, second] })));
    const r = await review.generateBriefs({ apiKey: 'k', fetchImpl: stub.impl, count: 2, improvements: REVIEW_OK.improvements, snapshot: SNAPSHOT, instructions: 'One about appraisal.' });
    expect(r.ok).toBe(true);
    expect(r.briefs).toHaveLength(2);
    expect(r.briefs[0]).toEqual(BRIEF_OK);
    expect(r.briefs[1].angle).toBe('appraisal-season');
    expect(r.warnings).toEqual([[], ['image_headline contains an em dash.', 'headline contains an em dash.']]);
    expect(r.usage.output_tokens).toBe(340);
    expect(r.model).toBe('claude-opus-5-5-20261001');
    const body = stub.calls[0].body;
    expect(body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: review.BRIEFS_SCHEMA } });
    expect(body.messages[0].content.startsWith('Write 2 new ads.')).toBe(true);
    expect(body.messages[0].content).toContain('One about appraisal.');
    expect(body.messages[0].content).toContain('LIVE ADS');
    expect(body.system[0].text).toContain('You write Meta lead ads for GP Link');
  });

  it('caps at six briefs and fails when there is no ads array', async () => {
    const eight = claudeStub(() => reply(JSON.stringify({ ads: Array.from({ length: 8 }, (_, i) => Object.assign({}, BRIEF_OK, { angle: 'a-' + i })) })));
    const r1 = await review.generateBriefs({ apiKey: 'k', fetchImpl: eight.impl, count: 6, improvements: [] });
    expect(r1.briefs).toHaveLength(6);
    expect(r1.warnings).toHaveLength(6);
    const wrongShape = claudeStub(() => reply('{"briefs":[]}'));
    const r2 = await review.generateBriefs({ apiKey: 'k', fetchImpl: wrongShape.impl, improvements: [] });
    expect(r2).toMatchObject({ ok: false, error: 'The model did not return ads.', text: '{"briefs":[]}' });
    const prose = claudeStub(() => reply('No.'));
    const r3 = await review.generateBriefs({ apiKey: 'k', fetchImpl: prose.impl, improvements: [] });
    expect(r3).toMatchObject({ ok: false, error: 'The model did not return ads.', text: 'No.' });
    const network = await review.generateBriefs({ apiKey: 'k', fetchImpl: async () => { throw new Error('down'); }, improvements: [] });
    expect(network).toEqual({ ok: false, error: 'Could not reach the model: down', network: true });
  });
});

describe('iterateDraft', () => {
  const draft = Object.assign({}, BRIEF_OK, { id: 'draft-1', status: 'draft', meta_ad_id: '' });
  const revisedJson = {
    angle: '05-duty-day', image_headline: 'Duty day.', image_sub: BRIEF_OK.image_sub, headline: 'Duty day.',
    primary_text: BRIEF_OK.primary_text, description: BRIEF_OK.description, image_prompt: BRIEF_OK.image_prompt,
    change_note: 'Shortened the headline to three words.'
  };

  it('asks at low effort with the iterate schema and merges the answer over the draft', async () => {
    const stub = claudeStub(() => reply(JSON.stringify(revisedJson)));
    const r = await review.iterateDraft({ apiKey: 'k', fetchImpl: stub.impl, draft, instruction: 'Shorten the headline.' });
    expect(r.ok).toBe(true);
    expect(r.revised).toEqual(Object.assign({}, BRIEF_OK, { image_headline: 'Duty day.', headline: 'Duty day.' }));
    expect(r.revised).not.toHaveProperty('id');
    expect(r.revised).not.toHaveProperty('change_note');
    expect(r.change_note).toBe('Shortened the headline to three words.');
    expect(r.warnings).toEqual([]);
    expect(r.usage.input_tokens).toBe(1200);
    expect(r.model).toBe('claude-opus-5-5-20261001');
    const body = stub.calls[0].body;
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: review.ITERATE_SCHEMA } });
    expect(body.messages[0].content).toContain('CURRENT AD\n');
    expect(body.messages[0].content).toContain('OWNER\'S INSTRUCTION\nShorten the headline.');
  });

  it('lets the effort be raised, warns on the revised copy, and fails without JSON', async () => {
    const stub = claudeStub(() => reply(JSON.stringify(Object.assign({}, revisedJson, { headline: 'Duty day — gone', primary_text: 'No closer.' }))));
    const r = await review.iterateDraft({ apiKey: 'k', fetchImpl: stub.impl, draft, instruction: 'x', effort: 'high' });
    expect(stub.calls[0].body.output_config.effort).toBe('high');
    expect(r.warnings).toEqual(['headline contains an em dash.', 'primary_text does not end with "Completely free for doctors."']);
    const prose = claudeStub(() => reply('Sorry, I need the current ad first.'));
    const r2 = await review.iterateDraft({ apiKey: 'k', fetchImpl: prose.impl, draft, instruction: 'x' });
    expect(r2).toMatchObject({ ok: false, error: 'The model did not return JSON.', text: 'Sorry, I need the current ad first.', model: 'claude-opus-5-5-20261001' });
    const denied = claudeStub(() => apiError(403, 'forbidden', 'permission_error'));
    expect(await review.iterateDraft({ apiKey: 'k', fetchImpl: denied.impl, draft, instruction: 'x' })).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
  });
});
